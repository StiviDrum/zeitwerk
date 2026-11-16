"""Owns all plans: storage, runners, CRUD and change notifications."""

from __future__ import annotations

from collections.abc import Callable
import copy
import logging
from typing import Any

from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
)
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.start import async_at_started
import probatio as vol

from .const import DOMAIN, SIGNAL_PLAN_STATUS, SIGNAL_ROOM_STATUS
from .engine import PlanRunner
from .holidays import HolidayRegistry
from .issues import async_check_plan, async_clear_plan
from .manual import action_targets
from .model import Plan, Room
from .rooms import RoomWindowTracker
from .schema import (
    async_validate_plan,
    make_plan_id,
    validate_plan,
    validate_room,
)
from .store import StoredData, ZeitwerkStore

_LOGGER = logging.getLogger(__name__)

EVENT_ADDED = "added"
EVENT_UPDATED = "updated"
EVENT_REMOVED = "removed"

PlanListener = Callable[[str, str], None]
RoomListener = Callable[[str, str], None]


class PlanNotFoundError(HomeAssistantError):
    """Raised for an unknown plan id."""


class RoomNotFoundError(HomeAssistantError):
    """Raised for an unknown room id."""


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
        self.rooms: dict[str, Room] = {}
        self.trackers: dict[str, RoomWindowTracker] = {}
        self.runtime: dict[str, dict[str, Any]] = {}
        self._invalid: list[dict[str, Any]] = []  # kept so nothing is lost
        self._invalid_rooms: list[dict[str, Any]] = []
        self._listeners: list[PlanListener] = []
        self._room_listeners: list[RoomListener] = []
        self._unsub_areas: CALLBACK_TYPE | None = None
        self._started = False
        self._unsub_started: CALLBACK_TYPE | None = None
        self._unsub_registry: CALLBACK_TYPE | None = None

    # ---------------------------------------------------------------- setup

    async def async_setup(self) -> None:
        """Load plans; runners start once Home Assistant has started."""
        data = await self.store.async_load()
        self.runtime = data["runtime"]
        for raw_room in data["rooms"]:
            try:
                room = Room.from_dict(validate_room(raw_room))
            except (vol.Invalid, KeyError) as err:
                _LOGGER.error(
                    "Ignoring invalid stored room %s: %s", raw_room.get("id"), err
                )
                self._invalid_rooms.append(raw_room)
                continue
            self.rooms[room.id] = room
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
        for room in self.rooms.values():
            self._start_tracker(room)
        for plan in list(self.plans.values()):
            await self._async_start_runner(plan, reapply=plan.options.reapply_on_start)
        self._unsub_registry = self.hass.bus.async_listen(
            er.EVENT_ENTITY_REGISTRY_UPDATED, self._async_registry_updated
        )
        self._unsub_areas = self.hass.bus.async_listen(
            ar.EVENT_AREA_REGISTRY_UPDATED, self._async_area_updated
        )

    @callback
    def _async_area_updated(self, event: Event[Any]) -> None:
        """Tell subscribers when a room's area is deleted (``area_id`` is kept)."""
        if event.data.get("action") != "remove":
            return
        for room in self.rooms.values():
            if room.area_id == event.data.get("area_id"):
                self._room_changed(room.id)
                self._notify_room(EVENT_UPDATED, room.id)

    def area_missing(self, room: Room) -> bool:
        """Whether the room's area no longer exists in the area registry."""
        return bool(
            room.area_id
            and ar.async_get(self.hass).async_get_area(room.area_id) is None
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
        if self._unsub_areas:
            self._unsub_areas()
            self._unsub_areas = None
        for runner in list(self.runners.values()):
            await runner.async_stop()
        self.runners.clear()
        for tracker in self.trackers.values():
            tracker.async_stop()
        self.trackers.clear()
        self.holidays.async_stop()
        await self.store.async_save(self._data())
        self._started = False

    # -------------------------------------------------------------- helpers

    def _data(self) -> StoredData:
        return {
            "plans": [p.to_dict() for p in self.plans.values()] + self._invalid,
            "rooms": [r.to_dict() for r in self.rooms.values()] + self._invalid_rooms,
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
    def async_add_room_listener(self, listener: RoomListener) -> CALLBACK_TYPE:
        """Listen for room added/updated/removed events."""
        self._room_listeners.append(listener)

        @callback
        def remove() -> None:
            self._room_listeners.remove(listener)

        return remove

    @callback
    def _notify_room(self, event: str, room_id: str) -> None:
        for listener in list(self._room_listeners):
            listener(event, room_id)

    @callback
    def _room_changed(self, room_id: str) -> None:
        """Window state or attributes of a room changed (entity + subscribers)."""
        async_dispatcher_send(self.hass, SIGNAL_ROOM_STATUS.format(room_id))

    def _start_tracker(self, room: Room) -> None:
        tracker = RoomWindowTracker(
            self.hass,
            room,
            on_update=lambda: self._room_updated(room.id),
            runtime=self.runtime.setdefault(f"room:{room.id}", {}),
            on_runtime_changed=self.async_schedule_save,
        )
        self.trackers[room.id] = tracker
        tracker.async_start()

    @callback
    def _room_updated(self, room_id: str) -> None:
        self._room_changed(room_id)
        self._notify_room(EVENT_UPDATED, room_id)

    def plans_of_room(self, room_id: str) -> list[str]:
        """Ids of the plans assigned to a room."""
        return [p.id for p in self.plans.values() if p.room == room_id]

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
            room_window=self.trackers.get(plan.room) if plan.room else None,
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

    def get_room(self, room_id: str) -> Room:
        """Return a room or raise."""
        if (room := self.rooms.get(room_id)) is None:
            raise RoomNotFoundError(f"Unknown room '{room_id}'")
        return room

    # ------------------------------------------------------------------ CRUD

    async def async_create_plan(self, data: dict[str, Any]) -> Plan:
        """Validate and add a new plan."""
        data = dict(data)
        if not data.get("id"):
            data["id"] = make_plan_id(str(data.get("name", "")), set(self.plans))
        elif data["id"] in self.plans:
            raise vol.Invalid(f"a plan with id '{data['id']}' already exists")
        plan = Plan.from_dict(
            await async_validate_plan(self.hass, data, set(self.rooms))
        )
        self.plans[plan.id] = plan
        self.runtime[plan.id] = {}
        self.async_schedule_save()
        self._notify(EVENT_ADDED, plan.id)
        self._notify_rooms_of(plan.room)
        if self._started:
            await self._async_start_runner(plan, reapply=True)
        return plan

    async def async_duplicate_plan(
        self, plan_id: str, name: str | None = None, new_id: str | None = None
    ) -> Plan:
        """Copy a plan under a new id; the copy starts switched off."""
        data = copy.deepcopy(self.get_plan(plan_id).to_dict())
        copy_word = "Kopie" if self.hass.config.language.startswith("de") else "copy"
        data["name"] = name or f"{data['name']} ({copy_word})"
        data["id"] = new_id
        data["enabled"] = False
        return await self.async_create_plan(data)

    async def async_update_plan(self, plan_id: str, data: dict[str, Any]) -> Plan:
        """Replace a plan (full update)."""
        old = self.get_plan(plan_id)
        data = {**data, "id": plan_id}
        plan = Plan.from_dict(
            await async_validate_plan(self.hass, data, set(self.rooms))
        )
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
        plan = Plan.from_dict(
            await async_validate_plan(self.hass, data, set(self.rooms))
        )
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
        self._notify_rooms_of(old.room, plan.room)

    async def async_delete_plan(self, plan_id: str) -> None:
        """Remove a plan, its runtime state and its device."""
        room_id = self.get_plan(plan_id).room
        if runner := self.runners.pop(plan_id, None):
            await runner.async_stop()
        del self.plans[plan_id]
        self.runtime.pop(plan_id, None)
        async_clear_plan(self.hass, plan_id)
        self.async_schedule_save()
        self._notify(EVENT_REMOVED, plan_id)
        self._notify_rooms_of(room_id)
        self._remove_device(plan_id)

    def _remove_device(self, identifier: str) -> None:
        registry = dr.async_get(self.hass)
        for device in dr.async_entries_for_config_entry(registry, self.entry_id):
            if (DOMAIN, identifier) in device.identifiers:
                registry.async_remove_device(device.id)

    @callback
    def _notify_rooms_of(self, *room_ids: str | None) -> None:
        """Room payloads list their plans: tell subscribers about changes."""
        for room_id in dict.fromkeys(r for r in room_ids if r):
            if room_id in self.rooms:
                self._notify_room(EVENT_UPDATED, room_id)

    # ------------------------------------------------------------ room CRUD

    async def async_create_room(self, data: dict[str, Any]) -> Room:
        """Validate and add a new room."""
        data = dict(data)
        if not data.get("id"):
            data["id"] = make_plan_id(
                str(data.get("name", "")), set(self.rooms), fallback="room"
            )
        elif data["id"] in self.rooms:
            raise vol.Invalid(f"a room with id '{data['id']}' already exists")
        room = Room.from_dict(validate_room(data))
        self.rooms[room.id] = room
        self.async_schedule_save()
        if self._started:
            self._start_tracker(room)
            # Plans that referenced this id before (stale storage) pick it up now.
            for plan_id in self.plans_of_room(room.id):
                plan = self.plans[plan_id]
                await self._async_replace(plan, plan)
        self._notify_room(EVENT_ADDED, room.id)
        return room

    async def async_update_room(self, room_id: str, data: dict[str, Any]) -> Room:
        """Replace a room (full update); its plans keep running."""
        self.get_room(room_id)
        room = Room.from_dict(validate_room({**data, "id": room_id}))
        self.rooms[room_id] = room
        self.async_schedule_save()
        if tracker := self.trackers.get(room_id):
            tracker.async_reconfigure(room)
        self._notify_room(EVENT_UPDATED, room_id)
        return room

    async def async_delete_room(self, room_id: str) -> None:
        """Remove a room; its plans become general plans."""
        self.get_room(room_id)
        for plan_id in self.plans_of_room(room_id):
            old = self.plans[plan_id]
            data = copy.deepcopy(old.to_dict())
            data.pop("room", None)
            data.pop("room_reactions", None)
            await self._async_replace(old, Plan.from_dict(data))
        if tracker := self.trackers.pop(room_id, None):
            tracker.async_stop()
        del self.rooms[room_id]
        self.runtime.pop(f"room:{room_id}", None)
        self.async_schedule_save()
        self._notify_room(EVENT_REMOVED, room_id)
        self._remove_device(f"room:{room_id}")


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


def _find_value_action(
    actions: list[dict[str, Any]], entity_id: str | None
) -> dict[str, Any]:
    candidates = [
        a for a in actions if isinstance(a, dict) and ("action" in a or "service" in a)
    ]
    if entity_id is not None:
        candidates = [a for a in candidates if entity_id in action_targets(a)]
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
