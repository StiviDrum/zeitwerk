"""Holiday sources: Holiday calendar or Workday binary_sensor.

Each source keeps a set of holiday dates for the coming days and notifies its
listeners when that set may have changed (source state change, new day).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta
import logging
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_change,
)
from homeassistant.util import dt as dt_util

from .model import WEEKDAYS

_LOGGER = logging.getLogger(__name__)

CALENDAR_DAYS_AHEAD = 400  # enough for "next holidays" previews
WORKDAY_DAYS_AHEAD = 9  # schedule search horizon + 1


class HolidaySource:
    """Holiday dates from one entity (calendar.* or binary_sensor.* of Workday)."""

    def __init__(self, hass: HomeAssistant, entity_id: str) -> None:
        """Initialise the source."""
        self.hass = hass
        self.entity_id = entity_id
        self.dates: dict[date, str] = {}
        self._listeners: list[Callable[[], None]] = []
        self._unsubs: list[CALLBACK_TYPE] = []

    def is_holiday(self, day: date) -> bool:
        """Return True if the day is a known holiday."""
        return day in self.dates

    def upcoming(self, count: int = 3) -> list[tuple[date, str]]:
        """Next holidays from today on."""
        today = dt_util.now().date()
        return sorted((d, n) for d, n in self.dates.items() if d >= today)[:count]

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        """Call listener when holiday dates were refreshed."""
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            self._listeners.remove(listener)

        return remove

    @property
    def has_listeners(self) -> bool:
        """Whether any plan still uses this source."""
        return bool(self._listeners)

    async def async_start(self) -> None:
        """Load dates and start tracking changes."""
        self._unsubs.append(
            async_track_state_change_event(
                self.hass, [self.entity_id], self._async_source_changed
            )
        )
        # Re-read shortly after local midnight (new day, new horizon).
        self._unsubs.append(
            async_track_time_change(
                self.hass, self._async_new_day, hour=0, minute=0, second=1
            )
        )
        await self.async_refresh()

    @callback
    def async_stop(self) -> None:
        """Stop tracking."""
        while self._unsubs:
            self._unsubs.pop()()

    @callback
    def _async_source_changed(self, _event: Event[Any]) -> None:
        self.hass.async_create_task(self.async_refresh(), eager_start=True)

    @callback
    def _async_new_day(self, _now: datetime) -> None:
        self.hass.async_create_task(self.async_refresh(), eager_start=True)

    async def async_refresh(self) -> None:
        """Re-read holiday dates and notify listeners if they changed."""
        try:
            if self.entity_id.startswith("calendar."):
                dates = await self._async_read_calendar()
            else:
                dates = await self._async_read_workday()
        except (HomeAssistantError, KeyError, TypeError, ValueError) as err:
            _LOGGER.debug("Holiday source %s not readable: %s", self.entity_id, err)
            dates = {}
        if dates != self.dates:
            self.dates = dates
            for listener in list(self._listeners):
                listener()

    async def _async_read_calendar(self) -> dict[date, str]:
        if self.hass.states.get(self.entity_id) is None:
            return {}
        today = dt_util.now().date()
        start = dt_util.start_of_local_day(today - timedelta(days=1))
        end = start + timedelta(days=CALENDAR_DAYS_AHEAD)
        response = await self.hass.services.async_call(
            "calendar",
            "get_events",
            {"start_date_time": start, "end_date_time": end},
            target={"entity_id": self.entity_id},
            blocking=True,
            return_response=True,
        )
        events = (response or {}).get(self.entity_id, {}).get("events", [])
        dates: dict[date, str] = {}
        for event in events:
            first = _as_date(event["start"])
            last = _as_date(event["end"])
            # all-day events have an exclusive end date
            if last <= first:
                last = first + timedelta(days=1)
            day = first
            while day < last:
                dates.setdefault(day, event.get("summary", ""))
                day += timedelta(days=1)
        return dates

    async def _async_read_workday(self) -> dict[date, str]:
        state = self.hass.states.get(self.entity_id)
        if state is None:
            return {}
        workdays = set(state.attributes.get("workdays", WEEKDAYS[:5]))
        today = dt_util.now().date()
        dates: dict[date, str] = {}
        for offset in range(-1, WORKDAY_DAYS_AHEAD):
            day = today + timedelta(days=offset)
            if WEEKDAYS[day.weekday()] not in workdays:
                # Workday cannot tell a holiday on a non-working weekday apart.
                continue
            if offset == 0:
                is_workday = state.state == "on"
            else:
                is_workday = await self._async_check_workday(day)
            if is_workday is False:
                dates[day] = ""
        return dates

    async def _async_check_workday(self, day: date) -> bool | None:
        try:
            response = await self.hass.services.async_call(
                "workday",
                "check_date",
                {"check_date": day},
                target={"entity_id": self.entity_id},
                blocking=True,
                return_response=True,
            )
        except HomeAssistantError:
            return None
        result = (response or {}).get(self.entity_id, {})
        return result.get("workday") if isinstance(result, dict) else None


def _as_date(value: Any) -> date:
    if isinstance(value, datetime):
        return dt_util.as_local(value).date()
    if isinstance(value, date):
        return value
    parsed = dt_util.parse_datetime(value)
    if parsed is not None:
        return dt_util.as_local(parsed).date()
    parsed_date = dt_util.parse_date(value)
    if parsed_date is None:
        raise ValueError(f"invalid date {value!r}")
    return parsed_date


class HolidayRegistry:
    """Shared holiday sources (one per entity, reused by all plans)."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise the registry."""
        self.hass = hass
        self._sources: dict[str, HolidaySource] = {}

    def get(self, entity_id: str) -> HolidaySource | None:
        """Return a started source."""
        return self._sources.get(entity_id)

    async def async_acquire(self, entity_id: str) -> HolidaySource:
        """Return (and start if needed) the source for an entity."""
        if (source := self._sources.get(entity_id)) is None:
            source = self._sources[entity_id] = HolidaySource(self.hass, entity_id)
            await source.async_start()
        return source

    @callback
    def async_release_unused(self) -> None:
        """Stop sources no plan listens to any more."""
        for entity_id, source in list(self._sources.items()):
            if not source.has_listeners:
                source.async_stop()
                del self._sources[entity_id]

    @callback
    def async_stop(self) -> None:
        """Stop all sources."""
        for source in self._sources.values():
            source.async_stop()
        self._sources.clear()
