"""Entities per plan."""

from __future__ import annotations

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .common import living_room_plan
from .test_engine import WED, at, start, temp, tick


async def test_entities_created_and_updated(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    entry, manager = await start(hass, freezer, at(WED, 17, 40))

    switch = hass.states.get("switch.zeitwerk_wohnzimmer_heizung")
    assert switch is not None
    assert switch.state == "on"

    profile = hass.states.get("sensor.zeitwerk_wohnzimmer_heizung_profile")
    assert profile.state == "Komfort"
    assert profile.attributes["profile_id"] == "comfort"
    assert profile.attributes["source"] == "schedule"
    assert profile.attributes["day_type"] == "workday"
    assert profile.attributes["is_holiday"] is False

    next_change = hass.states.get("sensor.zeitwerk_wohnzimmer_heizung_next_change")
    assert next_change.attributes["device_class"] == "timestamp"
    assert next_change.state == "2026-11-04T21:00:00+00:00"
    assert next_change.attributes["next_profile"] == "eco"
    assert next_change.attributes["next_profile_name"] == "Absenkung"

    active = hass.states.get("binary_sensor.zeitwerk_wohnzimmer_heizung_active")
    assert active.state == "on"
    assert active.attributes["match"] == "all"

    # one device per plan
    device = dr.async_get(hass).async_get_device_by_identifier(
        ("zeitwerk", "wohnzimmer_heizung"), entry.entry_id
    )
    assert device is not None
    assert device.name == "Heizung Wohnzimmer"

    await tick(hass, freezer, at(WED, 22))
    assert hass.states.get("sensor.zeitwerk_wohnzimmer_heizung_profile").state == (
        "Absenkung"
    )

    # switch off -> plan disabled, nothing switches
    await hass.services.async_call(
        "switch",
        "turn_off",
        {"entity_id": "switch.zeitwerk_wohnzimmer_heizung"},
        blocking=True,
    )
    await hass.async_block_till_done()
    assert not manager.plans["wohnzimmer_heizung"].enabled
    profile = hass.states.get("sensor.zeitwerk_wohnzimmer_heizung_profile")
    assert profile.attributes["source"] == "disabled"
    await tick(hass, freezer, at(WED, 23))
    assert temp(hass) == 18


async def test_entities_for_new_and_deleted_plans(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    await manager.async_create_plan(living_room_plan(id="bad", name="Bad"))
    await hass.async_block_till_done()
    assert hass.states.get("sensor.zeitwerk_bad_profile") is not None

    await manager.async_delete_plan("bad")
    await hass.async_block_till_done()
    assert er.async_get(hass).async_get("sensor.zeitwerk_bad_profile") is None
    assert hass.states.get("sensor.zeitwerk_bad_profile") is None
