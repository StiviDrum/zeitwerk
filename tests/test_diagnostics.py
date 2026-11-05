"""Diagnostics download."""

from __future__ import annotations

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr

from custom_components.zeitwerk.diagnostics import (
    async_get_config_entry_diagnostics,
    async_get_device_diagnostics,
)

from .test_engine import WED, at, start


async def test_diagnostics(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    # Called directly: the HTTP test client does not work with frozen time.
    entry, _manager = await start(hass, freezer, at(WED, 17, 40))

    result = await async_get_config_entry_diagnostics(hass, entry)
    assert result["zeitwerk_version"]
    assert result["time_zone"] == "Europe/Berlin"
    [plan] = result["plans"]
    assert plan["plan"]["id"] == "wohnzimmer_heizung"
    assert plan["status"]["profile"] == "comfort"
    assert plan["runtime"]["last_applied"] == "comfort"

    [device] = dr.async_entries_for_config_entry(dr.async_get(hass), entry.entry_id)
    single = await async_get_device_diagnostics(hass, entry, device)
    assert single["plan"]["name"] == "Heizung Wohnzimmer"
    assert single["status"]["source"] == "schedule"
