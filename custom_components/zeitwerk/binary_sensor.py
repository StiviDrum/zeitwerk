"""Activation state of a plan (binary_sensor.zeitwerk_<plan>_active)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import ZeitwerkConfigEntry
from .entity import (
    ZeitwerkEntity,
    ZeitwerkRoomEntity,
    async_setup_plan_entities,
    async_setup_room_entities,
)
from .manager import ZeitwerkManager

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ZeitwerkConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up activation binary sensors."""

    def factory(manager: ZeitwerkManager, plan_id: str) -> list[Entity]:
        return [ActiveSensor(manager, plan_id)]

    async_setup_plan_entities(entry, entry.runtime_data, factory, async_add_entities)

    def room_factory(manager: ZeitwerkManager, room_id: str) -> list[Entity]:
        return [RoomWindowSensor(manager, room_id)]

    async_setup_room_entities(
        entry, entry.runtime_data, room_factory, async_add_entities
    )


class ActiveSensor(ZeitwerkEntity, BinarySensorEntity):
    """On while the plan's activation conditions are met."""

    _attr_translation_key = "active"

    def __init__(self, manager: ZeitwerkManager, plan_id: str) -> None:
        """Initialise the sensor."""
        super().__init__(
            manager, plan_id, "active", f"binary_sensor.zeitwerk_{plan_id}_active"
        )

    @property
    def is_on(self) -> bool | None:
        """Activation conditions met."""
        return self.runner.status.active if self.runner else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Match mode and per-condition results."""
        if (runner := self.runner) is None or (plan := self.plan) is None:
            return None
        results = runner.status.activation_results
        return {
            "match": plan.activation.match,
            "conditions": [
                {"condition": cond, "result": results[i] if i < len(results) else None}
                for i, cond in enumerate(plan.activation.conditions)
            ],
        }


class RoomWindowSensor(ZeitwerkRoomEntity, BinarySensorEntity):
    """On while a window of the room counts as open (after the delay)."""

    _attr_translation_key = "window"
    _attr_device_class = BinarySensorDeviceClass.WINDOW

    def __init__(self, manager: ZeitwerkManager, room_id: str) -> None:
        """Initialise the sensor."""
        super().__init__(
            manager, room_id, "window", f"binary_sensor.zeitwerk_{room_id}_window"
        )

    @property
    def is_on(self) -> bool | None:
        """Window open (debounced)."""
        return self.tracker.is_open if self.tracker else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Individual window states, open since, unavailable entities."""
        if (tracker := self.tracker) is None:
            return None
        return {
            "entities": tracker.entity_states,
            "open_since": tracker.open_since.isoformat()
            if tracker.open_since
            else None,
            "unavailable": tracker.unavailable,
        }
