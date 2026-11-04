"""Base entity: one device per plan, updated via dispatcher."""

from __future__ import annotations

from collections.abc import Callable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import callback
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, SIGNAL_PLAN_STATUS
from .engine import PlanRunner
from .manager import EVENT_ADDED, ZeitwerkManager
from .model import Plan


class ZeitwerkEntity(Entity):
    """Entity belonging to one plan."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self, manager: ZeitwerkManager, plan_id: str, key: str, entity_id: str
    ) -> None:
        """Initialise; entity ids follow SPEC (<domain>.zeitwerk_<plan>...)."""
        self._manager = manager
        self._plan_id = plan_id
        self._attr_unique_id = f"{plan_id}_{key}"
        self.entity_id = entity_id
        plan = manager.plans[plan_id]
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, plan_id)},
            name=plan.name,
            manufacturer="Zeitwerk",
            model="Plan",
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def plan(self) -> Plan | None:
        """Current plan object (replaced on updates)."""
        return self._manager.plans.get(self._plan_id)

    @property
    def runner(self) -> PlanRunner | None:
        """Runner of the plan, if running."""
        return self._manager.runners.get(self._plan_id)

    @property
    def available(self) -> bool:
        """Available while the plan exists and runs."""
        return self.plan is not None and self.runner is not None

    async def async_added_to_hass(self) -> None:
        """Subscribe to status updates."""
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                SIGNAL_PLAN_STATUS.format(self._plan_id),
                self.async_write_ha_state,
            )
        )


def async_setup_plan_entities(
    entry: ConfigEntry,
    manager: ZeitwerkManager,
    factory: Callable[[ZeitwerkManager, str], list[Entity]],
    add_entities: Callable[[list[Entity]], None],
) -> None:
    """Add entities for existing plans and for plans created later."""
    entities: list[Entity] = []
    for plan_id in manager.plans:
        entities += factory(manager, plan_id)
    add_entities(entities)

    @callback
    def _plan_event(event: str, plan_id: str) -> None:
        if event == EVENT_ADDED:
            add_entities(factory(manager, plan_id))

    entry.async_on_unload(manager.async_add_listener(_plan_event))
