"""Owns all plans: storage, runners, CRUD and change notifications."""

from __future__ import annotations

from collections.abc import Callable
import copy
import logging
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.start import async_at_started

from .compat import vol
from .const import DOMAIN, SIGNAL_PLAN_STATUS
from .engine import PlanRunner
from .holidays import HolidayRegistry
from .issues import async_check_plan, async_clear_plan
from .model import Plan
from .schema import async_validate_plan, make_plan_id, validate_plan
from .store import StoredData, ZeitwerkStore

_LOGGER = logging.getLogger(__name__)

EVENT_ADDED = "added"
EVENT_UPDATED = "updated"
EVENT_REMOVED = "removed"

PlanListener = Callable[[str, str], None]


class PlanNotFoundError(HomeAssistantError):
    """Raised for an unknown plan id."""


class ZeitwerkManager:
    """Central object stored in ``entry.runtime_data``."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        """Initialise the manager."""
        self.hass = hass
        self.entry_id = entry_id
        self.store = ZeitwerkStore(hass)
        self.holidays = HolidayRegistry(hass)
        self.plans: dict[str, Plan] = {}
        self.runners: dict[str, PlanRunner] = {}
        self.runtime: dict[str, dict[str, Any]] = {}
        self._invalid: list[dict[str, Any]] = []  # kept so nothing is lost
        self._listeners: list[PlanListener] = []
        self._started = False
        self._unsub_started: CALLBACK_TYPE | None = None
        self._unsub_registry: CALLBACK_TYPE | None = None

    # ---------------------------------------------------------------- setup

    async def async_setup(self) -> None:
        """Load plans; runners start once Home Assistant has started."""
        data = await self.store.async_load()
        self.runtime = data["runtime"]
        for raw in data["plans"]:
            try:
                plan = Plan.from_dict(validate_plan(raw))
            except (vol.Invalid, KeyError) as err:
                _LOGGER.error("Ignoring invalid stored plan %s: %s", raw.get("id"), err)
                self._invalid.append(raw)
                continue
            self.plans[plan.id] = plan
        self._unsub_started = async_at_started(self.hass, self._async_hass_started)

    async def _async_hass_started(self, _hass: HomeAssistant) -> None:
        self._unsub_started = None
        self._started = True
        for plan in list(self.plans.values()):
            await self._async_start_runner(plan, reapply=plan.options.reapply_on_start)
        self._unsub_registry = self.hass.bus.async_listen(
            er.EVENT_ENTITY_REGISTRY_UPDATED, self._async_registry_updated
        )

    @callback
    def _async_registry_updated(self, _event: Event[Any]) -> None:
        """Entities were added, removed or renamed: re-check plan references."""
        for plan in self.plans.values():
            async_check_plan(self.hass, plan)

    async def async_unload(self) -> None:
        """Stop everything and flush storage."""
        if self._unsub_started:
            self._unsub_started()
            self._unsub_started = None
        if self._unsub_registry:
            self._unsub_registry()
            self._unsub_registry = None
        for runner in list(self.runners.values()):
            await runner.async_stop()
        self.runners.clear()
        self.holidays.async_stop()
        await self.store.async_save(self._data())
        self._started = False

    # -------------------------------------------------------------- helpers

    def _data(self) -> StoredData:
        return {
            "plans": [p.to_dict() for p in self.plans.values()] + self._invalid,
            "runtime": self.runtime,
        }

    @callback
    def async_schedule_save(self) -> None:
        """Debounced save of plans + runtime."""
        self.store.async_schedule_save(self._data)

    @callback
    def async_add_listener(self, listener: PlanListener) -> CALLBACK_TYPE:
        """Listen for plan added/updated/removed events."""
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            self._listeners.remove(listener)

        return remove

    @callback
    def _notify(self, event: str, plan_id: str) -> None:
        for listener in list(self._listeners):
            listener(event, plan_id)

    @callback
    def _runner_updated(self, runner: PlanRunner) -> None:
        async_dispatcher_send(self.hass, SIGNAL_PLAN_STATUS.format(runner.plan.id))
        self._notify(EVENT_UPDATED, runner.plan.id)

    async def _async_start_runner(self, plan: Plan, *, reapply: bool) -> None:
        runner = PlanRunner(
            self.hass,
            plan,
            runtime=self.runtime.setdefault(plan.id, {}),
            holidays=self.holidays,
            on_update=self._runner_updated,
            on_runtime_changed=self.async_schedule_save,
        )
        self.runners[plan.id] = runner
        await runner.async_start(reapply=reapply)
        async_check_plan(self.hass, plan)

    def get_plan(self, plan_id: str) -> Plan:
        """Return a plan or raise."""
        if (plan := self.plans.get(plan_id)) is None:
            raise PlanNotFoundError(f"Unknown plan '{plan_id}'")
        return plan

    def get_runner(self, plan_id: str) -> PlanRunner:
        """Return a running plan's runner or raise."""
        self.get_plan(plan_id)
        if (runner := self.runners.get(plan_id)) is None:
            raise HomeAssistantError(f"Plan '{plan_id}' is not running yet")
        return runner

    # ------------------------------------------------------------------ CRUD

    async def async_create_plan(self, data: dict[str, Any]) -> Plan:
        """Validate and add a new plan."""
        data = dict(data)
        if not data.get("id"):
            data["id"] = make_plan_id(str(data.get("name", "")), set(self.plans))
        elif data["id"] in self.plans:
            raise vol.Invalid(f"a plan with id '{data['id']}' already exists")
        plan = Plan.from_dict(await async_validate_plan(self.hass, data))
        self.plans[plan.id] = plan
        self.runtime[plan.id] = {}
        self.async_schedule_save()
        self._notify(EVENT_ADDED, plan.id)
        if self._started:
            await self._async_start_runner(plan, reapply=True)
        return plan

    async def async_update_plan(self, plan_id: str, data: dict[str, Any]) -> Plan:
        """Replace a plan (full update)."""
        old = self.get_plan(plan_id)
        data = {**data, "id": plan_id}
        plan = Plan.from_dict(await async_validate_plan(self.hass, data))
        await self._async_replace(old, plan)
        return plan

    async def async_set_enabled(self, plan_id: str, enabled: bool) -> None:
        """Switch a plan on or off."""
        plan = self.get_plan(plan_id)
        if plan.enabled == enabled:
            return
        plan.enabled = enabled
        self.async_schedule_save()
        if runner := self.runners.get(plan_id):
            await runner.async_evaluate(refresh_activation=True)
        self._notify(EVENT_UPDATED, plan_id)

    async def async_set_profile_value(
        self,
        plan_id: str,
        profile_id: str,
        value: Any,
        entity_id: str | None = None,
        key: str | None = None,
    ) -> None:
        """Change a value in a profile's quick-view action."""
        old = self.get_plan(plan_id)
        data = copy.deepcopy(old.to_dict())
        profile = next((p for p in data["profiles"] if p["id"] == profile_id), None)
        if profile is None:
            raise HomeAssistantError(f"Plan '{plan_id}' has no profile '{profile_id}'")
        action = _find_value_action(profile["actions"], entity_id)
        action_data = action.setdefault("data", {})
        key = key or _value_key(action_data)
        action_data[key] = value
        plan = Plan.from_dict(await async_validate_plan(self.hass, data))
        await self._async_replace(old, plan)

    async def _async_replace(self, old: Plan, plan: Plan) -> None:
        runner = self.runners.pop(old.id, None)
        current = runner.status.profile if runner else None
        if runner:
            await runner.async_stop()
        self.plans[plan.id] = plan
        self.async_schedule_save()
        if self._started:
            changed = current is not None and _profile_actions(old, current) != (
                _profile_actions(plan, current)
            )
            await self._async_start_runner(
                plan, reapply=plan.options.reapply_on_profile_change and changed
            )
        self._notify(EVENT_UPDATED, plan.id)

    async def async_delete_plan(self, plan_id: str) -> None:
        """Remove a plan, its runtime state and its device."""
        self.get_plan(plan_id)
        if runner := self.runners.pop(plan_id, None):
            await runner.async_stop()
        del self.plans[plan_id]
        self.runtime.pop(plan_id, None)
        async_clear_plan(self.hass, plan_id)
        self.async_schedule_save()
        self._notify(EVENT_REMOVED, plan_id)
        registry = dr.async_get(self.hass)
        for device in dr.async_entries_for_config_entry(registry, self.entry_id):
            if (DOMAIN, plan_id) in device.identifiers:
                registry.async_remove_device(device.id)


def _profile_actions(plan: Plan, profile_id: str) -> list[dict[str, Any]] | None:
    profile = plan.profile(profile_id)
    return copy.deepcopy(profile.actions) if profile else None


VALUE_KEYS = (
    "value",
    "temperature",
    "option",
    "brightness_pct",
    "brightness",
    "position",
    "percentage",
)


def _targets(action: dict[str, Any]) -> list[str]:
    target = action.get("target") or {}
    entity_ids = target.get("entity_id", action.get("entity_id", []))
    return [entity_ids] if isinstance(entity_ids, str) else list(entity_ids)


def _find_value_action(
    actions: list[dict[str, Any]], entity_id: str | None
) -> dict[str, Any]:
    candidates = [
        a for a in actions if isinstance(a, dict) and ("action" in a or "service" in a)
    ]
    if entity_id is not None:
        candidates = [a for a in candidates if entity_id in _targets(a)]
    if len(candidates) != 1:
        raise HomeAssistantError(
            "Cannot find exactly one action to change"
            + (f" for {entity_id}" if entity_id else "; pass entity_id")
        )
    return candidates[0]


def _value_key(data: dict[str, Any]) -> str:
    for key in VALUE_KEYS:
        if key in data:
            return key
    raise HomeAssistantError("Action has no value field; pass 'key'")
