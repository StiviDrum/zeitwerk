"""Profile and next-change sensors."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import ZeitwerkConfigEntry
from .entity import ZeitwerkEntity, async_setup_plan_entities
from .manager import ZeitwerkManager

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ZeitwerkConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up plan sensors."""

    def factory(manager: ZeitwerkManager, plan_id: str) -> list[Entity]:
        return [ProfileSensor(manager, plan_id), NextChangeSensor(manager, plan_id)]

    async_setup_plan_entities(entry, entry.runtime_data, factory, async_add_entities)


class ProfileSensor(ZeitwerkEntity, SensorEntity):
    """Current profile (name) of a plan."""

    _attr_translation_key = "profile"

    def __init__(self, manager: ZeitwerkManager, plan_id: str) -> None:
        """Initialise the sensor."""
        super().__init__(
            manager, plan_id, "profile", f"sensor.zeitwerk_{plan_id}_profile"
        )

    @property
    def icon(self) -> str | None:
        """Icon of the active profile, else the plan icon."""
        if (runner := self.runner) is None or (plan := self.plan) is None:
            return None
        profile = plan.profile(runner.status.profile)
        if profile and profile.icon:
            return profile.icon
        return plan.icon

    @property
    def native_value(self) -> str | None:
        """Name of the active profile."""
        if (runner := self.runner) is None or (plan := self.plan) is None:
            return None
        profile = plan.profile(runner.status.profile)
        return profile.name if profile else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Attributes per SPEC section 4."""
        if (runner := self.runner) is None:
            return None
        status = runner.status
        attributes: dict[str, Any] = {
            "profile_id": status.profile,
            "source": status.source,
            "day_type": status.day_type,
            "is_holiday": status.is_holiday,
        }
        if status.forced_until:
            attributes["forced_until"] = status.forced_until.isoformat()
        if status.manual_since:
            attributes["manual_override"] = True
            attributes["manual_since"] = status.manual_since.isoformat()
            if status.manual_until:
                attributes["manual_until"] = status.manual_until.isoformat()
            attributes["manual_entity"] = status.manual_entity
        if status.error:
            attributes["error"] = status.error
        return attributes


class NextChangeSensor(ZeitwerkEntity, SensorEntity):
    """Timestamp of the next scheduled profile change."""

    _attr_translation_key = "next_change"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, manager: ZeitwerkManager, plan_id: str) -> None:
        """Initialise the sensor."""
        super().__init__(
            manager, plan_id, "next_change", f"sensor.zeitwerk_{plan_id}_next_change"
        )

    @property
    def native_value(self) -> datetime | None:
        """Next change (None if nothing changes or an override is active)."""
        return self.runner.status.next_change if self.runner else None

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        """Next profile id and name."""
        if (runner := self.runner) is None or (plan := self.plan) is None:
            return None
        profile = plan.profile(runner.status.next_profile)
        return {
            "next_profile": runner.status.next_profile,
            "next_profile_name": profile.name if profile else None,
        }
