"""Rooms: window tracker, engine priority, entity, storage and websocket."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    area_registry as ar,
    device_registry as dr,
    entity_registry as er,
)
import pytest

from custom_components.zeitwerk.const import DOMAIN
from custom_components.zeitwerk.manager import ZeitwerkManager
from custom_components.zeitwerk.schema import replace_missing_profiles
from custom_components.zeitwerk.websocket_api import _plan_payload, _room_payload

from .common import living_room_plan
from .ha_testing import MockConfigEntry, WebSocketGenerator
from .test_engine import (
    TZ,
    WED,
    at,
    set_temp,
    setup_helpers,
    setup_zeitwerk,
    temp,
    tick,
    toggle,
)

PLAN = "wohnzimmer_heizung"
WIN_A = "binary_sensor.fenster_a"
WIN_B = "binary_sensor.fenster_b"
SENSOR = "binary_sensor.zeitwerk_wz_window"


def room_data(**windows: Any) -> dict[str, Any]:
    return {
        "id": "wz",
        "name": "Wohnzimmer",
        "windows": {"entities": [WIN_A, WIN_B], "open_delay": 60, **windows},
    }


def room_plan(window: str | None = "eco", **changes: Any) -> dict[str, Any]:
    reactions = {"window": window} if window else {}
    return living_room_plan(room="wz", room_reactions=reactions, **changes)


async def win(hass: HomeAssistant, entity_id: str, state: str) -> None:
    hass.states.async_set(entity_id, state)
    await hass.async_block_till_done()


async def setup_room(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    when: datetime,
    *,
    window: str | None = "eco",
    windows: dict[str, Any] | None = None,
    initial: str = "off",
    plan_changes: dict[str, Any] | None = None,
) -> tuple[MockConfigEntry, ZeitwerkManager]:
    freezer.move_to(when)
    await setup_helpers(hass)
    await win(hass, WIN_A, initial)
    await win(hass, WIN_B, "off")
    entry, manager = await setup_zeitwerk(hass)
    await manager.async_create_room(room_data(**(windows or {})))
    await manager.async_create_plan(room_plan(window, **(plan_changes or {})))
    await hass.async_block_till_done()
    return entry, manager


def tracker(manager: ZeitwerkManager):
    return manager.trackers["wz"]


async def test_migration_v1_to_v2(hass: HomeAssistant, hass_storage: dict) -> None:
    hass_storage["zeitwerk"] = {
        "version": 1,
        "minor_version": 1,
        "key": "zeitwerk",
        "data": {"plans": [living_room_plan()], "runtime": {}},
    }
    await setup_helpers(hass)
    entry, manager = await setup_zeitwerk(hass)
    assert manager.rooms == {}
    assert PLAN in manager.plans
    assert "room" not in manager.plans[PLAN].to_dict()
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert hass_storage["zeitwerk"]["version"] == 2
    assert hass_storage["zeitwerk"]["data"]["rooms"] == []
    assert hass_storage["zeitwerk"]["data"]["plans"][0]["id"] == PLAN


async def test_plan_roundtrip_unchanged_without_room() -> None:
    from custom_components.zeitwerk.model import Plan

    data = Plan.from_dict(living_room_plan()).to_dict()
    assert "room" not in data
    assert "room_reactions" not in data


async def test_open_delay_and_close_delay(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0, windows={"close_delay": 30})
    assert temp(hass) == 22
    freezer.move_to(t0)
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=30))
    assert not tracker(manager).is_open
    assert temp(hass) == 22
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert tracker(manager).is_open
    assert hass.states.get(SENSOR).state == "on"
    assert temp(hass) == 18
    status = manager.runners[PLAN].status
    assert (status.profile, status.source) == ("eco", "room:window")

    t1 = t0 + timedelta(minutes=5)
    freezer.move_to(t1)
    await win(hass, WIN_A, "off")
    await tick(hass, freezer, t1 + timedelta(seconds=10))
    assert tracker(manager).is_open
    await tick(hass, freezer, t1 + timedelta(seconds=30))
    assert not tracker(manager).is_open
    assert hass.states.get(SENSOR).state == "off"
    assert temp(hass) == 22


async def test_short_opening_ignored_tilted_counts(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=20))
    await win(hass, WIN_A, "off")
    await tick(hass, freezer, t0 + timedelta(seconds=120))
    assert not tracker(manager).is_open
    assert temp(hass) == 22
    # "open" (tilted/cover style state) counts too
    freezer.move_to(t0 + timedelta(seconds=130))
    await win(hass, WIN_B, "open")
    await tick(hass, freezer, t0 + timedelta(seconds=200))
    assert tracker(manager).is_open


async def test_unavailable_keeps_last_known_and_is_reported(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert tracker(manager).is_open
    freezer.move_to(t0 + timedelta(minutes=5))
    await win(hass, WIN_A, "unavailable")
    await tick(hass, freezer, t0 + timedelta(minutes=10))
    assert tracker(manager).is_open  # dropping sensor does not end "open"
    attrs = hass.states.get(SENSOR).attributes
    assert attrs["unavailable"] == [WIN_A]
    assert attrs["entities"][WIN_A] == "unavailable"
    assert attrs["open_since"] is not None
    assert temp(hass) == 18


async def test_unavailable_since_start_counts_closed(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0, initial="unavailable")
    await tick(hass, freezer, t0 + timedelta(minutes=5))
    assert not tracker(manager).is_open
    assert hass.states.get(SENSOR).attributes["unavailable"] == [WIN_A]
    assert temp(hass) == 22


async def test_priority_over_vacation_manual_and_forced(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    status = manager.runners[PLAN].status

    async def open_window(at_time: datetime) -> None:
        freezer.move_to(at_time)
        await win(hass, WIN_A, "on")
        await tick(hass, freezer, at_time + timedelta(seconds=60))

    async def close_window(at_time: datetime) -> None:
        freezer.move_to(at_time)
        await win(hass, WIN_A, "off")
        await hass.async_block_till_done()

    # vacation (away=16) loses against the window (eco=18)
    await toggle(hass, "urlaub", True)
    assert temp(hass) == 16
    await open_window(t0 + timedelta(minutes=1))
    assert temp(hass) == 18
    assert status.source == "room:window"
    await close_window(t0 + timedelta(minutes=3))
    assert temp(hass) == 16
    assert status.source == "override:vacation"
    await toggle(hass, "urlaub", False)
    assert temp(hass) == 22

    # manual change ends when the window opens
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    assert status.manual_since is not None
    await open_window(t0 + timedelta(minutes=5))
    assert temp(hass) == 18
    assert status.manual_since is None
    await close_window(t0 + timedelta(minutes=7))
    assert temp(hass) == 22

    # forced profile is covered by the window and applies again afterwards
    await manager.runners[PLAN].async_force_profile("away", timedelta(hours=1))
    assert temp(hass) == 16
    await open_window(t0 + timedelta(minutes=9))
    assert temp(hass) == 18
    assert status.source == "room:window"
    await close_window(t0 + timedelta(minutes=11))
    assert temp(hass) == 16
    assert status.source == "forced"


async def test_close_applies_current_profile_after_block_change(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0, window="away")
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert temp(hass) == 16
    await tick(hass, freezer, at(WED, 22))  # block ends while window is open
    assert temp(hass) == 16
    assert manager.runners[PLAN].status.source == "room:window"
    freezer.move_to(at(WED, 22, 30))
    await win(hass, WIN_A, "off")
    await hass.async_block_till_done()
    assert temp(hass) == 18  # eco applies now, not comfort from before


async def test_actions_only_on_change(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    await setup_room(hass, freezer, t0)
    calls: list[Any] = []
    hass.bus.async_listen(
        "call_service",
        lambda e: (
            calls.append(e)
            if e.data["domain"] == "input_number" and e.data["service"] == "set_value"
            else None
        ),
    )
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert len(calls) == 1
    # second window opens, attribute noise, unrelated change -> no re-apply
    freezer.move_to(t0 + timedelta(seconds=70))
    await win(hass, WIN_B, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=140))
    hass.states.async_set(WIN_A, "on", {"x": 1})
    await hass.async_block_till_done()
    assert len(calls) == 1


async def test_room_delete_detaches_plans(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert temp(hass) == 18
    registry = er.async_get(hass)
    assert registry.async_get(SENSOR) is not None
    await manager.async_delete_room("wz")
    await hass.async_block_till_done()
    plan = manager.plans[PLAN]
    assert plan.room is None and plan.room_reactions == {}
    assert "room" not in plan.to_dict()
    assert "wz" not in manager.trackers
    assert temp(hass) == 22  # general plan again
    assert registry.async_get(SENSOR) is None
    with pytest.raises(Exception, match="Unknown room"):
        manager.get_room("wz")


async def test_profile_delete_removes_reaction(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    data = room_plan("away")
    data = replace_missing_profiles(
        {**data, "profiles": [p for p in data["profiles"] if p["id"] != "away"]}
    )
    assert "room_reactions" not in data
    assert data["room"] == "wz"

    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0, window="away")
    await hass.services.async_call(
        DOMAIN,
        "update_plan",
        {
            "plan": PLAN,
            "profiles": [p for p in data["profiles"]],
            "default_profile": "eco",
        },
        blocking=True,
    )
    assert manager.plans[PLAN].room == "wz"
    assert manager.plans[PLAN].room_reactions == {}


async def test_plan_validation_errors(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    import probatio as vol

    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0, window=None)
    with pytest.raises(vol.Invalid, match="unknown room 'nope'"):
        await manager.async_create_plan(
            room_plan(id="x", window=None) | {"room": "nope"}
        )
    with pytest.raises(vol.Invalid, match="unknown profile 'ghost'"):
        await manager.async_create_plan(room_plan("ghost", id="x"))
    with pytest.raises(vol.Invalid, match="need a room"):
        await manager.async_create_plan(
            living_room_plan(id="x", room_reactions={"window": "eco"})
        )
    with pytest.raises(vol.Invalid, match="0 and 3600"):
        await manager.async_create_room(
            {"name": "Bad", "windows": {"open_delay": 4000}}
        )
    with pytest.raises(vol.Invalid):
        await manager.async_create_room(
            {"name": "Bad", "windows": {"entities": ["not an entity"]}}
        )
    with pytest.raises(vol.Invalid, match="already exists"):
        await manager.async_create_room(room_data())


async def test_unload_removes_listeners_and_timers(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    entry, manager = await setup_room(hass, freezer, t0)
    await win(hass, WIN_A, "on")  # pending open timer
    trk = tracker(manager)
    runner = manager.runners[PLAN]
    assert trk._unsub_timer is not None and trk._unsub_states is not None
    assert trk._listeners and runner._unsubs
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert trk._unsub_timer is None and trk._unsub_states is None
    assert not runner._unsubs
    assert manager.trackers == {} and manager.runners == {}
    # no callback fires after unload
    await tick(hass, freezer, t0 + timedelta(minutes=5))
    assert not trk.is_open


async def test_reconfigure_and_delete_clean_up(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    trk = tracker(manager)
    await manager.async_update_room(
        "wz",
        room_data(entities=[WIN_B])
        | {"windows": {"entities": [WIN_B], "open_delay": 10}},
    )
    assert trk is tracker(manager)
    await win(hass, WIN_A, "on")  # no longer watched
    await tick(hass, freezer, t0 + timedelta(minutes=2))
    assert not trk.is_open
    await win(hass, WIN_B, "on")
    await tick(hass, freezer, t0 + timedelta(minutes=2, seconds=10))
    assert trk.is_open
    await manager.async_delete_room("wz")
    assert trk._unsub_states is None and trk._unsub_timer is None


async def test_restart_with_window_already_open(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    freezer.move_to(t0)
    await setup_helpers(hass)
    await win(hass, WIN_A, "on")
    await win(hass, WIN_B, "off")
    freezer.move_to(t0 + timedelta(minutes=10))
    entry, manager = await setup_zeitwerk(hass)
    await manager.async_create_room(room_data())
    await manager.async_create_plan(room_plan())
    await hass.async_block_till_done()
    # integration reload: last_changed is 10 minutes old -> open at once
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    manager = entry.runtime_data
    assert manager.trackers["wz"].is_open
    assert temp(hass) == 18
    assert manager.runners[PLAN].status.source == "room:window"


async def test_core_restart_waits_full_delay(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    freezer.move_to(t0)
    await setup_helpers(hass)
    await win(hass, WIN_A, "on")  # last_changed = start time
    await win(hass, WIN_B, "off")
    _, manager = await setup_zeitwerk(hass)
    await manager.async_create_room(room_data())
    await hass.async_block_till_done()
    assert not manager.trackers["wz"].is_open
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert manager.trackers["wz"].is_open


async def test_dst_day_with_open_window(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    day = date(2026, 3, 29)  # Europe/Berlin spring forward at 02:00
    t0 = at(day, 1, 30)
    _, manager = await setup_room(hass, freezer, t0, window="away")
    assert temp(hass) == 18
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert temp(hass) == 16
    await tick(hass, freezer, datetime(2026, 3, 29, 3, 0, tzinfo=TZ))
    await tick(hass, freezer, at(day, 9))  # weekend block starts while open
    assert temp(hass) == 16
    assert manager.runners[PLAN].status.source == "room:window"
    freezer.move_to(at(day, 10))
    await win(hass, WIN_A, "off")
    await hass.async_block_till_done()
    assert temp(hass) == 22
    status = manager.runners[PLAN].status
    assert status.next_change == at(day, 22)


async def test_ws_rooms(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    await setup_helpers(hass)
    await setup_zeitwerk(hass)
    admin = await hass_ws_client(hass)
    reader = await hass_ws_client(hass, hass_read_only_access_token)
    freezer.move_to(at(WED, 17, 40))

    await reader.send_json_auto_id({"type": "zeitwerk/rooms/create", "room": {}})
    msg = await reader.receive_json()
    assert not msg["success"] and msg["error"]["code"] == "unauthorized"

    await admin.send_json_auto_id(
        {"type": "zeitwerk/rooms/create", "room": {"name": "Wohnzimmer"}}
    )
    msg = await admin.receive_json()
    assert msg["success"], msg
    assert msg["result"]["id"] == "wohnzimmer"
    assert msg["result"]["windows"]["open_delay"] == 60
    assert msg["result"]["plans"] == []

    await admin.send_json_auto_id(
        {
            "type": "zeitwerk/rooms/create",
            "room": {"name": "X", "windows": {"close_delay": 99999}},
        }
    )
    msg = await admin.receive_json()
    assert not msg["success"] and msg["error"]["code"] == "invalid_format"
    assert "3600" in msg["error"]["message"]

    await admin.send_json_auto_id(
        {
            "type": "zeitwerk/plans/create",
            "plan": room_plan() | {"room": "nope"},
        }
    )
    msg = await admin.receive_json()
    assert not msg["success"] and "unknown room" in msg["error"]["message"]

    await admin.send_json_auto_id(
        {
            "type": "zeitwerk/plans/create",
            "plan": living_room_plan(
                room="wohnzimmer", room_reactions={"window": "eco"}
            ),
        }
    )
    msg = await admin.receive_json()
    assert msg["success"], msg
    assert msg["result"]["room_reactions"] == {"window": "eco"}

    await admin.send_json_auto_id(
        {"type": "zeitwerk/rooms/get", "room_id": "wohnzimmer"}
    )
    msg = await admin.receive_json()
    assert msg["result"]["plans"] == [PLAN]
    assert msg["result"]["window"]["open"] is False

    await admin.send_json_auto_id({"type": "zeitwerk/rooms/list"})
    assert len((await admin.receive_json())["result"]["rooms"]) == 1

    await admin.send_json_auto_id({"type": "zeitwerk/rooms/get", "room_id": "nope"})
    assert (await admin.receive_json())["error"]["code"] == "not_found"

    await reader.send_json_auto_id(
        {"type": "zeitwerk/rooms/delete", "room_id": "wohnzimmer"}
    )
    assert (await reader.receive_json())["error"]["code"] == "unauthorized"
    await admin.send_json_auto_id(
        {"type": "zeitwerk/rooms/delete", "room_id": "wohnzimmer"}
    )
    assert (await admin.receive_json())["success"]


def record_set_values(hass: HomeAssistant) -> list[float]:
    values: list[float] = []

    def _listener(event: Any) -> None:
        if (
            event.data["domain"] == "input_number"
            and event.data["service"] == "set_value"
        ):
            values.append(event.data["service_data"]["value"])

    hass.bus.async_listen("call_service", _listener)
    return values


async def open_window(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, when: datetime
) -> None:
    freezer.move_to(when)
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, when + timedelta(seconds=60))


async def test_reconfigure_keeps_state_and_pending_delay(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0, windows={"close_delay": 60})
    trk = tracker(manager)
    notified: list[int] = []
    trk.async_add_listener(lambda: notified.append(1))
    await open_window(hass, freezer, t0)
    assert trk.is_open
    since = trk.open_since
    notified.clear()

    # raising open_delay while open does not close; rename touches nothing
    await manager.async_update_room("wz", room_data(open_delay=600, close_delay=60))
    assert trk.is_open and trk.open_since == since
    await manager.async_update_room(
        "wz", {**room_data(open_delay=600, close_delay=60), "name": "Wohnen"}
    )
    assert trk.is_open and notified == []
    assert temp(hass) == 18

    # pending close_delay survives an edit and keeps its start time
    t1 = t0 + timedelta(minutes=5)
    freezer.move_to(t1)
    await win(hass, WIN_A, "off")
    await tick(hass, freezer, t1 + timedelta(seconds=10))
    assert trk.is_open
    await manager.async_update_room("wz", room_data(open_delay=600, close_delay=30))
    await tick(hass, freezer, t1 + timedelta(seconds=20))
    assert trk.is_open
    await tick(hass, freezer, t1 + timedelta(seconds=30))
    assert not trk.is_open
    assert temp(hass) == 22


async def test_removed_entity_counts_closed(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    await open_window(hass, freezer, t0)
    assert tracker(manager).is_open
    freezer.move_to(t0 + timedelta(minutes=2))
    hass.states.async_remove(WIN_A)
    await hass.async_block_till_done()
    assert not tracker(manager).is_open
    assert WIN_A in tracker(manager).unavailable
    assert temp(hass) == 22


async def test_create_room_restarts_stale_plans_and_flags_missing(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, hass_storage: dict
) -> None:
    t0 = at(WED, 17, 40)
    freezer.move_to(t0)
    hass_storage["zeitwerk"] = {
        "version": 2,
        "minor_version": 1,
        "key": "zeitwerk",
        "data": {
            "plans": [living_room_plan(room="ghost", room_reactions={"window": "eco"})],
            "rooms": [],
            "runtime": {},
        },
    }
    await setup_helpers(hass)
    await win(hass, WIN_A, "off")
    await win(hass, WIN_B, "off")
    _, manager = await setup_zeitwerk(hass)
    assert _plan_payload(manager, manager.plans[PLAN])["room_missing"] is True
    old_runner = manager.runners[PLAN]
    await manager.async_create_room({**room_data(), "id": "ghost"})
    await hass.async_block_till_done()
    assert manager.runners[PLAN] is not old_runner
    assert _plan_payload(manager, manager.plans[PLAN])["room_missing"] is False
    freezer.move_to(t0)
    await win(hass, WIN_A, "on")
    await tick(hass, freezer, t0 + timedelta(seconds=60))
    assert temp(hass) == 18


async def test_skip_next_while_window_open_stores_underlying_profile(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    await open_window(hass, freezer, t0)
    assert temp(hass) == 18
    await manager.runners[PLAN].async_skip_next()
    await hass.async_block_till_done()
    assert manager.runtime[PLAN]["forced"]["profile"] == "comfort"
    assert temp(hass) == 18
    freezer.move_to(t0 + timedelta(minutes=5))
    await win(hass, WIN_A, "off")
    await hass.async_block_till_done()
    assert temp(hass) == 22
    await tick(hass, freezer, at(WED, 22))  # the skipped change
    assert temp(hass) == 22


async def test_force_profile_while_window_open_is_deferred(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    await open_window(hass, freezer, t0)
    values = record_set_values(hass)
    await manager.runners[PLAN].async_force_profile("away", timedelta(hours=1))
    await hass.async_block_till_done()
    status = manager.runners[PLAN].status
    assert values == []
    assert temp(hass) == 18
    assert status.source == "room:window"
    assert status.forced_until is not None
    freezer.move_to(t0 + timedelta(minutes=5))
    await win(hass, WIN_A, "off")
    await hass.async_block_till_done()
    assert values == [16]
    assert status.source == "forced"


async def test_core_restart_with_open_window_does_not_pulse(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    entry, manager = await setup_room(hass, freezer, t0)
    await open_window(hass, freezer, t0)
    opened = manager.trackers["wz"].open_since
    assert temp(hass) == 18
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    # core restart: states are recreated, last_changed is "now"
    freezer.move_to(t0 + timedelta(minutes=10))
    hass.states.async_remove(WIN_A)
    await win(hass, WIN_A, "on")
    values = record_set_values(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    manager = entry.runtime_data
    assert manager.trackers["wz"].is_open
    assert manager.trackers["wz"].open_since == opened
    assert manager.runners[PLAN].status.source == "room:window"
    assert 22 not in values  # no schedule-profile pulse
    assert temp(hass) == 18


async def test_core_restart_with_window_closed_meanwhile_uses_normal_path(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    entry, _ = await setup_room(hass, freezer, t0)
    await open_window(hass, freezer, t0)
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    freezer.move_to(t0 + timedelta(minutes=10))
    await win(hass, WIN_A, "off")
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert not entry.runtime_data.trackers["wz"].is_open
    assert temp(hass) == 22


async def test_window_transition_clears_manual_and_reapplies(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 23)  # default profile eco (18) == window profile
    _, manager = await setup_room(hass, freezer, t0)
    assert temp(hass) == 18
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    status = manager.runners[PLAN].status
    assert status.manual_since is not None
    await open_window(hass, freezer, t0)
    assert status.manual_since is None
    assert temp(hass) == 18  # applied although last_applied was already eco


async def test_area_deleted_keeps_area_id_and_is_flagged(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    _, manager = await setup_room(hass, freezer, t0)
    area = ar.async_get(hass).async_create("Wohnzimmer")
    await manager.async_update_room("wz", {**room_data(), "area_id": area.id})
    events: list[tuple[str, str]] = []
    manager.async_add_room_listener(lambda e, r: events.append((e, r)))
    assert _room_payload(manager, manager.rooms["wz"])["area_missing"] is False
    ar.async_get(hass).async_delete(area.id)
    await hass.async_block_till_done()
    assert manager.rooms["wz"].area_id == area.id
    assert _room_payload(manager, manager.rooms["wz"])["area_missing"] is True
    assert ("updated", "wz") in events
    # an area that never existed (deleted while HA was off) is flagged as well
    await manager.async_update_room("wz", {**room_data(), "area_id": "gone"})
    assert _room_payload(manager, manager.rooms["wz"])["area_missing"] is True


async def test_activation_inactive_plan_ignores_window(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    inactive = {
        "conditions": [
            {
                "condition": "state",
                "entity_id": "input_boolean.heizperiode",
                "state": "off",
            }
        ]
    }
    _, manager = await setup_room(
        hass, freezer, t0, plan_changes={"activation": inactive}
    )
    values = record_set_values(hass)
    await open_window(hass, freezer, t0)
    assert tracker(manager).is_open
    assert manager.runners[PLAN].status.source == "inactive"
    assert values == []


async def test_binary_sensor_attributes_and_device_removal(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    entry, manager = await setup_room(hass, freezer, t0)
    await open_window(hass, freezer, t0)
    state = hass.states.get(SENSOR)
    assert state.state == "on"
    assert state.attributes["device_class"] == "window"
    assert state.attributes["entities"] == {WIN_A: "on", WIN_B: "off"}
    assert (
        state.attributes["open_since"]
        == (t0 + timedelta(0))
        .astimezone(tracker(manager).open_since.tzinfo)
        .isoformat()
    )
    assert state.attributes["unavailable"] == []
    devices = dr.async_get(hass)
    assert (
        devices.async_get_device_by_identifier((DOMAIN, "room:wz"), entry.entry_id)
        is not None
    )
    await manager.async_delete_room("wz")
    await hass.async_block_till_done()
    assert (
        devices.async_get_device_by_identifier((DOMAIN, "room:wz"), entry.entry_id)
        is None
    )
    assert hass.states.get(SENSOR) is None or (
        hass.states.get(SENSOR).state == "unavailable"
    )


async def test_ws_rooms_non_admin(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    await setup_helpers(hass)
    _, manager = await setup_zeitwerk(hass)
    await manager.async_create_room(room_data())
    reader = await hass_ws_client(hass, hass_read_only_access_token)
    freezer.move_to(at(WED, 17, 40))
    for message in (
        {"type": "zeitwerk/rooms/create", "room": {"name": "X"}},
        {"type": "zeitwerk/rooms/update", "room_id": "wz", "room": {"name": "Y"}},
        {"type": "zeitwerk/rooms/delete", "room_id": "wz"},
    ):
        await reader.send_json_auto_id(message)
        msg = await reader.receive_json()
        assert not msg["success"] and msg["error"]["code"] == "unauthorized"
    assert set(manager.rooms) == {"wz"}
    assert manager.rooms["wz"].name == "Wohnzimmer"
    await reader.send_json_auto_id({"type": "zeitwerk/rooms/list"})
    assert (await reader.receive_json())["success"]


async def test_restart_resets_stale_persisted_open(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    entry, manager = await setup_room(hass, freezer, t0)
    await open_window(hass, freezer, t0)
    assert manager.runtime["room:wz"]["window"]["open"] is True
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()

    # closed during downtime -> persisted state is reset on start
    freezer.move_to(t0 + timedelta(minutes=10))
    await win(hass, WIN_A, "off")
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    manager = entry.runtime_data
    assert manager.runtime["room:wz"]["window"] == {"open": False, "since": None}

    # opened briefly (never debounced), then restart: must not open immediately
    freezer.move_to(t0 + timedelta(minutes=20))
    await win(hass, WIN_A, "on")
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert manager.runtime["room:wz"]["window"]["open"] is False
    freezer.move_to(t0 + timedelta(minutes=30))
    hass.states.async_remove(WIN_A)
    await win(hass, WIN_A, "on")  # core restart: last_changed is "now"
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert not entry.runtime_data.trackers["wz"].is_open


async def test_create_room_event_order_and_runtime_key_removed(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, hass_storage: dict
) -> None:
    t0 = at(WED, 17, 40)
    freezer.move_to(t0)
    hass_storage["zeitwerk"] = {
        "version": 2,
        "minor_version": 1,
        "key": "zeitwerk",
        "data": {
            "plans": [living_room_plan(room="wz", room_reactions={"window": "eco"})],
            "rooms": [],
            "runtime": {},
        },
    }
    await setup_helpers(hass)
    await win(hass, WIN_A, "off")
    await win(hass, WIN_B, "off")
    _, manager = await setup_zeitwerk(hass)
    events: list[str] = []
    manager.async_add_room_listener(lambda e, r: events.append(e))
    await manager.async_create_room(room_data())
    await hass.async_block_till_done()
    assert events[0] == "added"
    assert "room:wz" in manager.runtime
    await manager.async_delete_room("wz")
    assert "room:wz" not in manager.runtime


async def test_room_rename_and_area_update_device(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    t0 = at(WED, 17, 40)
    entry, manager = await setup_room(hass, freezer, t0)
    devices = dr.async_get(hass)
    areas = ar.async_get(hass)
    one, two = areas.async_create("Eins"), areas.async_create("Zwei")

    def device():
        return devices.async_get_device_by_identifier(
            (DOMAIN, "room:wz"), entry.entry_id
        )

    await manager.async_update_room("wz", {**room_data(), "name": "Wohnen"})
    assert device().name == "Wohnen"
    await manager.async_update_room(
        "wz", {**room_data(), "name": "Wohnen", "area_id": one.id}
    )
    assert device().area_id == one.id
    # the user moves the device: later room area changes leave it alone
    devices.async_update_device(device().id, area_id=two.id)
    three = areas.async_create("Drei")
    await manager.async_update_room(
        "wz", {**room_data(), "name": "Wohnen", "area_id": three.id}
    )
    assert device().area_id == two.id


def test_room_id_new_is_reserved() -> None:
    """'new' is the panel route for creating a room and cannot be an id."""
    import probatio as vol

    from custom_components.zeitwerk.schema import (
        RESERVED_ROOM_IDS,
        make_plan_id,
        validate_room,
    )

    with pytest.raises(vol.Invalid, match="reserved"):
        validate_room({"id": "new", "name": "New"})
    assert make_plan_id("New", set(RESERVED_ROOM_IDS), fallback="room") == "new_2"
