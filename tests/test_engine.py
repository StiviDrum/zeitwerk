"""Engine behaviour with a running Home Assistant (frozen time)."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any
from unittest.mock import patch
from zoneinfo import ZoneInfo

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

from custom_components.zeitwerk.const import DOMAIN
from custom_components.zeitwerk.manager import ZeitwerkManager

from .common import living_room_plan

TZ = ZoneInfo("Europe/Berlin")
TEMP = "input_number.temperaturspeicher_wohnzimmer"
WED = date(2026, 11, 4)


def at(day: date, hh: int, mm: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hh, mm, tzinfo=TZ)


async def setup_helpers(hass: HomeAssistant) -> None:
    await hass.config.async_set_time_zone("Europe/Berlin")
    assert await async_setup_component(
        hass,
        "input_number",
        {
            "input_number": {
                "temperaturspeicher_wohnzimmer": {
                    "min": 5,
                    "max": 30,
                    "step": 0.5,
                    "initial": 20,
                }
            }
        },
    )
    assert await async_setup_component(
        hass,
        "input_boolean",
        {
            "input_boolean": {
                "urlaub": {"initial": False},
                "heizperiode": {"initial": True},
                "person_1_home": {"initial": True},
                "person_2_home": {"initial": True},
            }
        },
    )


async def setup_zeitwerk(
    hass: HomeAssistant,
) -> tuple[MockConfigEntry, ZeitwerkManager]:
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry, entry.runtime_data


async def start(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime, **changes: Any
) -> tuple[MockConfigEntry, ZeitwerkManager]:
    freezer.move_to(when)
    await setup_helpers(hass)
    entry, manager = await setup_zeitwerk(hass)
    await manager.async_create_plan(living_room_plan(**changes))
    await hass.async_block_till_done()
    return entry, manager


async def tick(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime
) -> None:
    freezer.move_to(when)
    async_fire_time_changed(hass, when)
    await hass.async_block_till_done()


def temp(hass: HomeAssistant) -> float:
    return float(hass.states.get(TEMP).state)


async def set_temp(hass: HomeAssistant, value: float) -> None:
    await hass.services.async_call(
        "input_number", "set_value", {"entity_id": TEMP, "value": value}, blocking=True
    )


async def toggle(hass: HomeAssistant, name: str, on: bool) -> None:
    await hass.services.async_call(
        "input_boolean",
        "turn_on" if on else "turn_off",
        {"entity_id": f"input_boolean.{name}"},
        blocking=True,
    )
    await hass.async_block_till_done()


async def test_applies_current_profile_on_create(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    assert temp(hass) == 22
    status = manager.runners["wohnzimmer_heizung"].status
    assert (status.profile, status.source, status.day_type) == (
        "comfort",
        "schedule",
        "workday",
    )
    assert status.next_change == at(WED, 22)
    assert status.next_profile == "eco"


async def test_timer_switches_profile(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 18
    status = manager.runners["wohnzimmer_heizung"].status
    assert (status.profile, status.source) == ("eco", "default")
    assert status.next_change == at(WED + timedelta(1), 16)


async def test_only_applied_on_change(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    await start(hass, freezer, at(WED, 17, 40))
    await set_temp(hass, 20)
    # no boundary, unrelated condition entity change -> nothing re-applied
    await tick(hass, freezer, at(WED, 19))
    await toggle(hass, "person_1_home", False)
    assert temp(hass) == 20
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 18


async def test_override_priority(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    plan = living_room_plan()
    plan["overrides"][1]["profile"] = "eco"  # nobody home -> eco, vacation -> away
    freezer.move_to(at(WED, 17, 40))
    await setup_helpers(hass)
    _, manager = await setup_zeitwerk(hass)
    await manager.async_create_plan(plan)
    await hass.async_block_till_done()
    status = manager.runners["wohnzimmer_heizung"].status

    await toggle(hass, "person_1_home", False)
    await toggle(hass, "person_2_home", False)
    assert temp(hass) == 18
    assert status.source == "override:nobody_home"
    assert status.next_change is None

    await toggle(hass, "urlaub", True)  # higher priority
    assert temp(hass) == 16
    assert status.source == "override:vacation"
    assert status.override_results == {"vacation": True, "nobody_home": True}

    await toggle(hass, "urlaub", False)
    await toggle(hass, "person_1_home", True)
    assert temp(hass) == 22
    assert status.source == "schedule"


async def test_override_match_any(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    plan = living_room_plan()
    plan["overrides"][1]["match"] = "any"
    freezer.move_to(at(WED, 17, 40))
    await setup_helpers(hass)
    _, manager = await setup_zeitwerk(hass)
    await manager.async_create_plan(plan)
    await hass.async_block_till_done()
    await toggle(hass, "person_2_home", False)
    assert temp(hass) == 16
    assert manager.runners["wohnzimmer_heizung"].status.source == "override:nobody_home"


ACTIVATION = {
    "match": "all",
    "conditions": [
        {"condition": "state", "entity_id": "input_boolean.heizperiode", "state": "on"}
    ],
}


async def test_activation_when_inactive_none(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40), activation=ACTIVATION)
    status = manager.runners["wohnzimmer_heizung"].status
    assert temp(hass) == 22
    await toggle(hass, "heizperiode", False)
    assert (status.active, status.source, status.profile) == (False, "inactive", None)
    assert temp(hass) == 22  # nothing switched
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 22  # still paused
    await toggle(hass, "heizperiode", True)
    assert temp(hass) == 18  # re-activated -> current profile applied


async def test_activation_when_inactive_profile(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    activation = {**ACTIVATION, "when_inactive": "profile:away"}
    _, manager = await start(hass, freezer, at(WED, 17, 40), activation=activation)
    await toggle(hass, "heizperiode", False)
    assert temp(hass) == 16
    status = manager.runners["wohnzimmer_heizung"].status
    assert (status.source, status.profile) == ("inactive", "away")
    await set_temp(hass, 19)
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 19  # applied only once


async def test_activation_any(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    activation = {
        "match": "any",
        "conditions": [
            {
                "condition": "state",
                "entity_id": "input_boolean.person_1_home",
                "state": "on",
            },
            {
                "condition": "state",
                "entity_id": "input_boolean.person_2_home",
                "state": "on",
            },
        ],
    }
    _, manager = await start(
        hass, freezer, at(WED, 17, 40), activation=activation, overrides=[]
    )
    status = manager.runners["wohnzimmer_heizung"].status
    await toggle(hass, "person_1_home", False)
    assert status.active
    assert status.activation_results == [False, True]
    await toggle(hass, "person_2_home", False)
    assert not status.active


async def test_activation_reevaluate_false(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    activation = {**ACTIVATION, "reevaluate": False, "when_inactive": "profile:away"}
    _, manager = await start(hass, freezer, at(WED, 17, 40), activation=activation)
    await toggle(hass, "heizperiode", False)
    assert manager.runners["wohnzimmer_heizung"].status.active  # not yet re-checked
    assert temp(hass) == 22
    await tick(hass, freezer, at(WED, 22))  # block boundary
    assert temp(hass) == 16


async def test_disable_and_enable(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    await manager.async_set_enabled("wohnzimmer_heizung", False)
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 22
    assert manager.runners["wohnzimmer_heizung"].status.source == "disabled"
    await manager.async_set_enabled("wohnzimmer_heizung", True)
    await hass.async_block_till_done()
    assert temp(hass) == 18


async def test_restart_reapply_on_start(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    entry, _ = await start(hass, freezer, at(WED, 17, 40))
    await hass.config_entries.async_unload(entry.entry_id)
    await set_temp(hass, 20)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert temp(hass) == 22


async def test_restart_without_reapply(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    entry, _ = await start(
        hass, freezer, at(WED, 17, 40), options={"reapply_on_start": False}
    )
    await hass.config_entries.async_unload(entry.entry_id)
    await set_temp(hass, 20)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert temp(hass) == 20  # same profile as before the restart -> untouched
    # changed while stopped -> applied
    await hass.config_entries.async_unload(entry.entry_id)
    freezer.move_to(at(WED, 22, 30))
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert temp(hass) == 18


async def test_plans_persist(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    entry, _ = await start(hass, freezer, at(WED, 17, 40))
    await hass.config_entries.async_unload(entry.entry_id)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert list(entry.runtime_data.plans) == ["wohnzimmer_heizung"]


async def test_reapply_on_profile_change(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    await manager.async_set_profile_value("wohnzimmer_heizung", "comfort", 21)
    await hass.async_block_till_done()
    assert temp(hass) == 21
    await manager.async_set_profile_value("wohnzimmer_heizung", "eco", 17)
    await hass.async_block_till_done()
    assert temp(hass) == 21  # eco not active
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 17


async def test_profile_change_without_reapply(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(
        hass, freezer, at(WED, 17, 40), options={"reapply_on_profile_change": False}
    )
    await manager.async_set_profile_value("wohnzimmer_heizung", "comfort", 21)
    await hass.async_block_till_done()
    assert temp(hass) == 22


async def test_force_profile_and_skip_next(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    runner = manager.runners["wohnzimmer_heizung"]
    await runner.async_force_profile("away", timedelta(hours=1))
    await hass.async_block_till_done()
    assert temp(hass) == 16
    assert runner.status.source == "forced"
    await tick(hass, freezer, at(WED, 18, 40))
    assert temp(hass) == 22

    await runner.async_skip_next()  # stay comfort through 22:00 until Thu 16:00
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 22
    await tick(hass, freezer, at(WED + timedelta(1), 16))
    assert temp(hass) == 22
    assert runner.status.source == "schedule"
    await tick(hass, freezer, at(WED + timedelta(1), 22))
    assert temp(hass) == 18


async def test_holiday_like_sunday(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    hass.states.async_set("calendar.feiertage", "off")
    with patch(
        "custom_components.zeitwerk.holidays.HolidaySource._async_read_calendar",
        return_value={WED: "Testfeiertag"},
    ):
        _, manager = await start(
            hass,
            freezer,
            at(WED, 10),
            holidays={
                "source": "calendar.feiertage",
                "mode": "like_day",
                "like_day": "sun",
            },
        )
    status = manager.runners["wohnzimmer_heizung"].status
    assert temp(hass) == 22  # weekend block 09-22
    assert status.is_holiday
    assert status.day_type == "weekend"
    source = manager.runners["wohnzimmer_heizung"].holiday_source
    # holiday removed from the calendar -> re-evaluated on source change
    with patch(
        "custom_components.zeitwerk.holidays.HolidaySource._async_read_calendar",
        return_value={},
    ):
        hass.states.async_set("calendar.feiertage", "on")
        await hass.async_block_till_done()
    assert source.dates == {}
    assert temp(hass) == 18
    assert not status.is_holiday


async def test_dst_spring_forward(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    week = {
        "day_types": [
            {
                "id": "weekend",
                "name": "WE",
                "days": ["sat", "sun"],
                "blocks": [{"start": "02:30", "end": "05:00", "profile": "comfort"}],
            }
        ]
    }
    utc = dt_util.UTC
    _, manager = await start(
        hass, freezer, datetime(2026, 3, 29, 0, 50, tzinfo=utc), week=week
    )
    assert temp(hass) == 18
    assert manager.runners["wohnzimmer_heizung"].status.next_change == datetime(
        2026, 3, 29, 1, 0, tzinfo=utc
    )
    await tick(hass, freezer, datetime(2026, 3, 29, 1, 0, tzinfo=utc))  # 03:00 CEST
    assert temp(hass) == 22
    await tick(hass, freezer, datetime(2026, 3, 29, 3, 0, tzinfo=utc))  # 05:00 CEST
    assert temp(hass) == 18


async def test_dst_fall_back_no_double_switch(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    week = {
        "day_types": [
            {
                "id": "weekend",
                "name": "WE",
                "days": ["sat", "sun"],
                "blocks": [{"start": "01:00", "end": "02:30", "profile": "comfort"}],
            }
        ]
    }
    utc = dt_util.UTC
    await start(
        hass, freezer, datetime(2026, 10, 24, 23, 30, tzinfo=utc), week=week
    )  # 01:30 CEST
    assert temp(hass) == 22
    await tick(hass, freezer, datetime(2026, 10, 25, 0, 30, tzinfo=utc))  # 02:30 CEST
    assert temp(hass) == 18
    await set_temp(hass, 19)
    for minute in (0, 15, 30, 45):  # repeated hour 02:xx CET
        await tick(hass, freezer, datetime(2026, 10, 25, 1, minute, tzinfo=utc))
    assert temp(hass) == 19  # nothing switched again


async def test_unload_removes_listeners(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    freezer.move_to(at(WED, 17, 40))
    await setup_helpers(hass)
    before = hass.bus.async_listeners()
    entry, manager = await setup_zeitwerk(hass)
    await manager.async_create_plan(living_room_plan(activation=ACTIVATION))
    await hass.async_block_till_done()
    runner = manager.runners["wohnzimmer_heizung"]
    assert runner._unsubs
    assert runner._unsub_timer is not None
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert runner._unsub_timer is None
    assert not runner._unsubs
    after = hass.bus.async_listeners()
    assert after.get("state_changed", 0) == before.get("state_changed", 0)
    # nothing fires after unload
    await set_temp(hass, 20)
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 20


async def test_update_and_delete_plan(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    plan = living_room_plan()
    plan["week"]["day_types"][0]["blocks"] = []
    await manager.async_update_plan("wohnzimmer_heizung", plan)
    await hass.async_block_till_done()
    assert temp(hass) == 18
    await manager.async_delete_plan("wohnzimmer_heizung")
    assert manager.plans == {}
    assert manager.runners == {}
