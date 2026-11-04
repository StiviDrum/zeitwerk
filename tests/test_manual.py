"""Manual override: until_next, ignore, minutes:<n> (SPEC §3 "Manuelle Änderungen")."""

from __future__ import annotations

from datetime import timedelta

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import Context, HomeAssistant, State

from custom_components.zeitwerk.manual import (
    STATE,
    build_watch,
    is_manual_change,
)
from custom_components.zeitwerk.model import Plan

from .common import living_room_plan
from .test_engine import WED, at, set_temp, start, temp, tick

PLAN = "wohnzimmer_heizung"


def _status(manager):
    return manager.runners[PLAN].status


async def test_own_changes_are_not_manual(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    assert temp(hass) == 22
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 18
    assert _status(manager).manual_since is None


async def test_until_next_holds_until_profile_change(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    entry, manager = await start(hass, freezer, at(WED, 17, 40))
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    status = _status(manager)
    assert status.manual_since == at(WED, 17, 40)
    assert status.manual_until == at(WED, 22)
    assert status.manual_entity == "input_number.temperaturspeicher_wohnzimmer"
    state = hass.states.get("sensor.zeitwerk_wohnzimmer_heizung_profile")
    assert state.attributes["manual_override"] is True

    # restart with reapply_on_start keeps the manual value
    await hass.config_entries.async_unload(entry.entry_id)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    manager = entry.runtime_data
    assert temp(hass) == 20
    assert _status(manager).manual_since == at(WED, 17, 40)

    # editing the active profile does not overwrite it either
    await manager.async_set_profile_value(PLAN, "comfort", 21.5)
    await hass.async_block_till_done()
    assert temp(hass) == 20

    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 18
    assert _status(manager).manual_since is None
    assert (
        "manual_override"
        not in hass.states.get("sensor.zeitwerk_wohnzimmer_heizung_profile").attributes
    )


async def test_echo_of_profile_value_is_not_manual(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    await set_temp(hass, 22)  # same value as Komfort, foreign context
    await hass.async_block_till_done()
    assert _status(manager).manual_since is None


async def test_override_change_ends_manual(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    await hass.services.async_call(
        "input_boolean", "turn_on", {"entity_id": "input_boolean.urlaub"}, blocking=True
    )
    await hass.async_block_till_done()
    assert temp(hass) == 16
    assert _status(manager).manual_since is None


async def test_ignore_mode(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    entry, manager = await start(
        hass, freezer, at(WED, 17, 40), options={"manual_override": "ignore"}
    )
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    assert _status(manager).manual_since is None
    await hass.config_entries.async_unload(entry.entry_id)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert temp(hass) == 22  # reapply_on_start wins


async def test_minutes_mode_reapplies_after_window(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(
        hass, freezer, at(WED, 17, 40), options={"manual_override": "minutes:30"}
    )
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    assert _status(manager).manual_until == at(WED, 18, 10)
    await tick(hass, freezer, at(WED, 18, 9))
    assert temp(hass) == 20
    await tick(hass, freezer, at(WED, 18, 10))
    assert temp(hass) == 22  # same profile, re-applied after the window
    assert _status(manager).manual_since is None


async def test_minutes_mode_holds_across_profile_change(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(
        hass, freezer, at(WED, 21, 50), options={"manual_override": "minutes:30"}
    )
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 20
    assert _status(manager).profile == "eco"
    await tick(hass, freezer, at(WED, 22, 20))
    assert temp(hass) == 18


async def test_apply_and_force_clear_manual(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    runner = manager.runners[PLAN]
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    await hass.services.async_call("zeitwerk", "apply", {"plan": PLAN}, blocking=True)
    await hass.async_block_till_done()
    assert temp(hass) == 22
    assert runner.status.manual_since is None

    await set_temp(hass, 19)
    await hass.async_block_till_done()
    assert runner.status.manual_since is not None
    await runner.async_force_profile("comfort", timedelta(hours=1))
    await hass.async_block_till_done()
    assert temp(hass) == 22
    assert runner.status.manual_since is None


# --- pure helpers -------------------------------------------------------------


def _plan(actions: list[dict]) -> Plan:
    data = living_room_plan()
    data["profiles"][0]["actions"] = actions
    return Plan.from_dict(data)


def test_build_watch_keys() -> None:
    watch = build_watch(
        _plan(
            [
                {
                    "action": "climate.set_temperature",
                    "target": {"entity_id": "climate.bad"},
                    "data": {"temperature": 21},
                },
                {
                    "action": "light.turn_on",
                    "target": {"entity_id": ["light.a"]},
                    "data": {"brightness_pct": 40},
                },
                {"action": "switch.turn_off", "entity_id": "switch.pump"},
                {"action": "script.turn_on", "target": {"entity_id": "{{ x }}"}},
            ]
        )
    )
    assert watch.watched["climate.bad"] == "temperature"
    assert watch.watched["light.a"] == "brightness"
    assert watch.watched["switch.pump"] == STATE
    assert "{{ x }}" not in watch.watched
    assert watch.expected["comfort"] == {
        "climate.bad": 21,
        "light.a": 102,
        "switch.pump": "off",
    }
    assert watch.expected["eco"] == {"input_number.temperaturspeicher_wohnzimmer": 18}


def test_is_manual_change_only_watched_attribute() -> None:
    ctx = Context()
    old = State("climate.bad", "heat", {"temperature": 21, "current_temperature": 19})
    sensor_update = State(
        "climate.bad",
        "heat",
        {"temperature": 21, "current_temperature": 20},
        context=ctx,
    )
    assert not is_manual_change(old, sensor_update, "temperature", 21)
    manual = State("climate.bad", "heat", {"temperature": 23}, context=ctx)
    assert is_manual_change(old, manual, "temperature", 21)
    assert not is_manual_change(old, manual, "temperature", 23)  # echo
    assert is_manual_change(old, manual, "temperature", None)
    unavailable = State("climate.bad", "unavailable", {})
    assert not is_manual_change(old, unavailable, "temperature", 21)
    assert not is_manual_change(None, manual, "temperature", 21)
    assert not is_manual_change(
        State("input_number.x", "20.0"), State("input_number.x", "20"), STATE, None
    )
