"""Runtime of one plan: evaluation, timer, condition listeners, apply-on-change.

Priority (docs/SPEC.md §3): disabled -> activation -> forced -> overrides ->
schedule block -> default profile. A profile is applied only when the effective
profile changes (or when explicitly re-applied).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import logging
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.exceptions import ConditionError, HomeAssistantError
from homeassistant.helpers import (
    condition as condition_helper,
    config_validation as cv,
)
from homeassistant.helpers.event import (
    async_track_point_in_utc_time,
    async_track_state_change_event,
)
from homeassistant.util import dt as dt_util

from .compat import vol
from .executor import ProfileExecutor
from .holidays import HolidayRegistry, HolidaySource
from .model import MATCH_ANY, Plan
from .schedule import (
    HolidayFn,
    next_change,
    next_evaluation,
    no_holidays,
    scheduled_at,
)

_LOGGER = logging.getLogger(__name__)

SOURCE_SCHEDULE = "schedule"
SOURCE_DEFAULT = "default"
SOURCE_INACTIVE = "inactive"
SOURCE_DISABLED = "disabled"
SOURCE_FORCED = "forced"
SOURCE_OVERRIDE_PREFIX = "override:"


@dataclass(slots=True)
class PlanStatus:
    """Evaluated state of a plan (read by entities and the card)."""

    profile: str | None = None
    source: str = SOURCE_DISABLED
    day_type: str | None = None
    is_holiday: bool = False
    active: bool = False
    activation_results: list[bool] = field(default_factory=list)
    override_results: dict[str, bool] = field(default_factory=dict)
    next_change: datetime | None = None
    next_profile: str | None = None
    forced_until: datetime | None = None
    error: str | None = None


@dataclass(slots=True)
class _Conditions:
    checkers: list[Any] = field(default_factory=list)
    entities: set[str] = field(default_factory=set)
    error: str | None = None


class PlanRunner:
    """Keeps one plan's profile in sync with its schedule."""

    def __init__(
        self,
        hass: HomeAssistant,
        plan: Plan,
        *,
        runtime: dict[str, Any],
        holidays: HolidayRegistry,
        on_update: Callable[[PlanRunner], None],
        on_runtime_changed: Callable[[], None],
    ) -> None:
        """Initialise the runner; ``runtime`` is persisted by the manager."""
        self.hass = hass
        self.plan = plan
        self.runtime = runtime
        self.status = PlanStatus()
        self.executor = ProfileExecutor(hass, plan)
        self._holidays = holidays
        self._holiday_source: HolidaySource | None = None
        self._on_update = on_update
        self._on_runtime_changed = on_runtime_changed
        self._activation = _Conditions()
        self._overrides: list[_Conditions] = []
        self._activation_entities: set[str] = set()
        self._unsubs: list[CALLBACK_TYPE] = []
        self._unsub_timer: CALLBACK_TYPE | None = None
        self._lock = asyncio.Lock()
        self._stopped = False

    # ------------------------------------------------------------------ setup

    @property
    def is_holiday(self) -> HolidayFn:
        """Holiday predicate for this plan."""
        if self._holiday_source is None:
            return no_holidays
        return self._holiday_source.is_holiday

    @property
    def holiday_source(self) -> HolidaySource | None:
        """Holiday source in use (None if holidays are off)."""
        return self._holiday_source

    async def async_start(self, *, reapply: bool) -> None:
        """Compile actions/conditions, start listeners, evaluate once."""
        errors: list[str] = []
        try:
            await self.executor.async_setup()
        except (vol.Invalid, HomeAssistantError) as err:
            errors.append(f"actions: {err}")
        self._activation = await self._async_compile(self.plan.activation.conditions)
        self._overrides = [
            await self._async_compile(o.conditions) for o in self.plan.overrides
        ]
        errors += [c.error for c in (self._activation, *self._overrides) if c.error]
        self.status.error = "; ".join(errors) or None
        if self.status.error:
            _LOGGER.error("Plan %s: %s", self.plan.id, self.status.error)

        if self.plan.holidays.enabled and self.plan.holidays.source:
            self._holiday_source = await self._holidays.async_acquire(
                self.plan.holidays.source
            )
            self._unsubs.append(
                self._holiday_source.async_add_listener(self._async_holidays_changed)
            )

        self._activation_entities = (
            self._activation.entities if self.plan.activation.reevaluate else set()
        )
        tracked = set(self._activation_entities)
        for override in self._overrides:
            tracked |= override.entities
        if tracked:
            self._unsubs.append(
                async_track_state_change_event(
                    self.hass, sorted(tracked), self._async_condition_entity_changed
                )
            )
        await self.async_evaluate(refresh_activation=True, force_apply=reapply)

    async def _async_compile(self, conditions: list[dict[str, Any]]) -> _Conditions:
        result = _Conditions()
        if not conditions:
            return result
        try:
            validated = await condition_helper.async_validate_conditions_config(
                self.hass, cv.CONDITIONS_SCHEMA(conditions)
            )
            for config in validated:
                result.checkers.append(
                    await condition_helper.async_from_config(self.hass, config)
                )
                result.entities |= condition_helper.async_extract_entities(config)
        except (vol.Invalid, HomeAssistantError) as err:
            result.error = f"conditions: {err}"
        return result

    async def async_stop(self) -> None:
        """Stop timer and listeners, release resources."""
        self._stopped = True
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None
        while self._unsubs:
            self._unsubs.pop()()
        for group in (self._activation, *self._overrides):
            for checker in group.checkers:
                unload = getattr(checker, "async_unload", None)
                if unload is not None:
                    unload()
            group.checkers.clear()
        await self.executor.async_unload()
        self._holiday_source = None
        self._holidays.async_release_unused()

    # -------------------------------------------------------------- triggers

    @callback
    def _async_condition_entity_changed(self, event: Event[Any]) -> None:
        refresh = event.data["entity_id"] in self._activation_entities
        self._request(refresh_activation=refresh)

    @callback
    def _async_holidays_changed(self) -> None:
        self._request(refresh_activation=False)

    @callback
    def _async_timer_fired(self, _now: datetime) -> None:
        self._unsub_timer = None
        self._request(refresh_activation=True)

    @callback
    def _request(self, *, refresh_activation: bool, force_apply: bool = False) -> None:
        if self._stopped:
            return
        self.hass.async_create_task(
            self.async_evaluate(
                refresh_activation=refresh_activation, force_apply=force_apply
            ),
            f"zeitwerk evaluate {self.plan.id}",
            eager_start=True,
        )

    # ------------------------------------------------------------- evaluation

    def _check(self, group: _Conditions) -> list[bool]:
        results: list[bool] = []
        for checker in group.checkers:
            try:
                results.append(checker(self.hass) is True)
            except (ConditionError, HomeAssistantError) as err:
                _LOGGER.warning("Plan %s: condition error: %s", self.plan.id, err)
                results.append(False)
        return results

    @staticmethod
    def _combine(results: list[bool], match: str, *, empty: bool) -> bool:
        if not results:
            return empty
        return any(results) if match == MATCH_ANY else all(results)

    def _forced(self, now: datetime) -> tuple[str, datetime] | None:
        forced = self.runtime.get("forced")
        if not forced:
            return None
        until = dt_util.parse_datetime(forced.get("until") or "")
        if (
            until is None
            or until <= now
            or self.plan.profile(forced["profile"]) is None
        ):
            self.runtime.pop("forced", None)
            self._on_runtime_changed()
            return None
        return forced["profile"], until

    async def async_evaluate(
        self, *, refresh_activation: bool = True, force_apply: bool = False
    ) -> None:
        """Re-evaluate the plan, apply on change, reschedule the timer."""
        async with self._lock:
            if self._stopped:
                return
            self._evaluate(
                refresh_activation=refresh_activation, force_apply=force_apply
            )

    def _evaluate(self, *, refresh_activation: bool, force_apply: bool) -> None:
        plan, status = self.plan, self.status
        now = dt_util.utcnow()
        tz = dt_util.get_default_time_zone()
        scheduled = scheduled_at(plan, now, tz, self.is_holiday)
        status.day_type = scheduled.day_type
        status.is_holiday = scheduled.is_holiday

        if refresh_activation or (
            not status.activation_results and self._activation.checkers
        ):
            status.activation_results = self._check(self._activation)
        if self._activation.error:
            status.active = False
        else:
            status.active = self._combine(
                status.activation_results, plan.activation.match, empty=True
            )
        status.override_results = {
            override.id: (
                not group.error
                and self._combine(
                    self._check(group),
                    override.match,
                    empty=False,
                )
            )
            for override, group in zip(plan.overrides, self._overrides, strict=True)
        }
        forced = self._forced(now)
        status.forced_until = None
        status.next_change = status.next_profile = None

        if not plan.enabled:
            status.profile, status.source = None, SOURCE_DISABLED
        elif not status.active:
            status.profile = plan.activation.inactive_profile
            status.source = SOURCE_INACTIVE
        elif forced is not None:
            status.profile, status.source = forced[0], SOURCE_FORCED
            status.forced_until = forced[1]
            status.next_change = forced[1]
            status.next_profile = scheduled_at(
                plan, forced[1], tz, self.is_holiday
            ).profile
        elif (
            active_override := next(
                (o for o in plan.overrides if status.override_results.get(o.id)), None
            )
        ) is not None:
            status.profile = active_override.profile
            status.source = f"{SOURCE_OVERRIDE_PREFIX}{active_override.id}"
        else:
            status.profile = scheduled.profile
            status.source = SOURCE_SCHEDULE if scheduled.from_block else SOURCE_DEFAULT
            if (change := next_change(plan, now, tz, self.is_holiday)) is not None:
                status.next_change, status.next_profile = change

        self._apply(status.profile, force=force_apply)
        self._schedule_timer(now, forced[1] if forced else None)
        self._on_update(self)

    def _apply(self, profile: str | None, *, force: bool) -> None:
        last = self.runtime.get("last_applied")
        if profile is None:
            if last is not None:
                self.runtime["last_applied"] = None
                self._on_runtime_changed()
            return
        if not force and profile == last:
            return
        self.executor.async_run(profile)
        self.runtime["last_applied"] = profile
        self._on_runtime_changed()

    def _schedule_timer(self, now: datetime, forced_until: datetime | None) -> None:
        if self._unsub_timer:
            self._unsub_timer()
        point = next_evaluation(
            self.plan, now, dt_util.get_default_time_zone(), self.is_holiday
        )
        if forced_until is not None and forced_until < point:
            point = forced_until
        self._unsub_timer = async_track_point_in_utc_time(
            self.hass, self._async_timer_fired, point
        )

    # --------------------------------------------------------------- commands

    async def async_apply_current(self) -> None:
        """Apply the current profile now (service ``zeitwerk.apply``)."""
        await self.async_evaluate(refresh_activation=True, force_apply=True)

    async def async_force_profile(
        self, profile_id: str, duration: timedelta | None
    ) -> None:
        """Force a profile for a duration (default: until the next change)."""
        if self.plan.profile(profile_id) is None:
            raise HomeAssistantError(
                f"Plan '{self.plan.id}' has no profile '{profile_id}'"
            )
        now = dt_util.utcnow()
        if duration is None:
            change = next_change(
                self.plan, now, dt_util.get_default_time_zone(), self.is_holiday
            )
            if change is None:
                raise HomeAssistantError(
                    f"Plan '{self.plan.id}' has no upcoming change; give a duration"
                )
            until = change[0]
        else:
            until = now + duration
        self.runtime["forced"] = {"profile": profile_id, "until": until.isoformat()}
        self._on_runtime_changed()
        await self.async_evaluate(refresh_activation=False)

    async def async_skip_next(self) -> None:
        """Keep the current profile through the next scheduled change."""
        tz = dt_util.get_default_time_zone()
        now = dt_util.utcnow()
        first = next_change(self.plan, now, tz, self.is_holiday)
        if first is None or self.status.profile is None:
            raise HomeAssistantError(f"Plan '{self.plan.id}' has no upcoming change")
        second = next_change(self.plan, first[0], tz, self.is_holiday)
        until = second[0] if second else first[0] + timedelta(days=1)
        self.runtime["forced"] = {
            "profile": self.status.profile,
            "until": until.isoformat(),
        }
        self._on_runtime_changed()
        await self.async_evaluate(refresh_activation=False)

    async def async_clear_forced(self) -> None:
        """Remove a forced profile."""
        if self.runtime.pop("forced", None) is not None:
            self._on_runtime_changed()
        await self.async_evaluate(refresh_activation=False)
