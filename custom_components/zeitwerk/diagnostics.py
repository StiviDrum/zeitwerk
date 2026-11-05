"""Diagnostics download (Settings → Devices & services → Zeitwerk / a plan device).

Contains the plans as stored, their runtime status and the persisted runtime
state – what is needed to reproduce a scheduling problem. Plan, profile and
rule names stay readable; there are no credentials in Zeitwerk data.
"""

from __future__ import annotations

from typing import Any

from homeassistant.const import __version__ as HA_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.loader import async_get_integration

from . import ZeitwerkConfigEntry
from .const import DOMAIN
from .manager import ZeitwerkManager
from .websocket_api import status_dict


def _plan_diagnostics(manager: ZeitwerkManager, plan_id: str) -> dict[str, Any]:
    plan = manager.plans[plan_id]
    runner = manager.runners.get(plan_id)
    return {
        "plan": plan.to_dict(),
        "status": status_dict(runner),
        "runtime": manager.runtime.get(plan_id, {}),
    }


async def _header(hass: HomeAssistant) -> dict[str, Any]:
    integration = await async_get_integration(hass, DOMAIN)
    return {
        "zeitwerk_version": str(integration.version),
        "home_assistant_version": HA_VERSION,
        "time_zone": hass.config.time_zone,
        "language": hass.config.language,
    }


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ZeitwerkConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for all plans."""
    manager = entry.runtime_data
    return {
        **await _header(hass),
        "plans": [_plan_diagnostics(manager, plan_id) for plan_id in manager.plans],
    }


async def async_get_device_diagnostics(
    hass: HomeAssistant, entry: ZeitwerkConfigEntry, device: dr.DeviceEntry
) -> dict[str, Any]:
    """Return diagnostics for the plan of one device."""
    manager = entry.runtime_data
    plan_id = next(
        (ident for domain, ident in device.identifiers if domain == DOMAIN), None
    )
    if plan_id is None or plan_id not in manager.plans:
        return {**await _header(hass), "plan": None}
    return {**await _header(hass), **_plan_diagnostics(manager, plan_id)}
