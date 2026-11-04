"""Plan on/off switch (switch.zeitwerk_<plan>)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
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
    """Set up plan switches."""

    def factory(manager: ZeitwerkManager, plan_id: str) -> list[Entity]:
        return [PlanSwitch(manager, plan_id)]

    async_setup_plan_entities(entry, entry.runtime_data, factory, async_add_entities)


class PlanSwitch(ZeitwerkEntity, SwitchEntity):
    """Enables or disables a plan."""

    _attr_name = None  # use the device (plan) name
    _attr_translation_key = "plan"

    def __init__(self, manager: ZeitwerkManager, plan_id: str) -> None:
        """Initialise the switch."""
        super().__init__(manager, plan_id, "enabled", f"switch.zeitwerk_{plan_id}")

    @property
    def available(self) -> bool:
        """Switch works as soon as the plan exists."""
        return self.plan is not None

    @property
    def is_on(self) -> bool | None:
        """Return True if the plan is enabled."""
        return self.plan.enabled if self.plan else None

    async def async_turn_on(self, **kwargs: Any) -> None:
        """Enable the plan."""
        await self._manager.async_set_enabled(self._plan_id, True)
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        """Disable the plan."""
        await self._manager.async_set_enabled(self._plan_id, False)
        self.async_write_ha_state()
