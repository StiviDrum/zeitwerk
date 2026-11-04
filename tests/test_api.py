"""Services and websocket API."""

from __future__ import annotations

from datetime import date, timedelta
from unittest.mock import patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
import pytest
from pytest_homeassistant_custom_component.typing import WebSocketGenerator

from .common import living_room_plan
from .test_engine import WED, at, setup_helpers, setup_zeitwerk, start, temp, tick

PLAN = "wohnzimmer_heizung"


async def call(hass: HomeAssistant, service: str, **data) -> None:
    await hass.services.async_call("zeitwerk", service, data, blocking=True)
    await hass.async_block_till_done()


async def test_services(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    await start(hass, freezer, at(WED, 17, 40))

    await call(hass, "set_profile_value", plan=PLAN, profile="comfort", value=21.5)
    assert temp(hass) == 21.5

    await call(hass, "force_profile", plan=PLAN, profile="away", duration={"hours": 1})
    assert temp(hass) == 16
    await call(hass, "clear_force", plan=PLAN)
    assert temp(hass) == 21.5

    await call(hass, "skip_next", plan=PLAN)
    await tick(hass, freezer, at(WED, 22))
    assert temp(hass) == 21.5

    await hass.services.async_call(
        "input_number",
        "set_value",
        {"entity_id": "input_number.temperaturspeicher_wohnzimmer", "value": 10},
        blocking=True,
    )
    await call(hass, "apply", plan=PLAN)
    assert temp(hass) == 21.5


async def test_service_errors(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    await start(hass, freezer, at(WED, 17, 40))
    with pytest.raises(ServiceValidationError):
        await call(hass, "apply", plan="nope")
    with pytest.raises(ServiceValidationError):
        await call(hass, "force_profile", plan=PLAN, profile="nope")


async def test_ws_crud_and_subscribe(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    hass_ws_client: WebSocketGenerator,
) -> None:
    client = await hass_ws_client(hass)  # authenticate before freezing time
    freezer.move_to(at(WED, 17, 40))
    await setup_helpers(hass)
    await setup_zeitwerk(hass)

    await client.send_json_auto_id({"type": "zeitwerk/plans/subscribe"})
    assert (await client.receive_json())["success"]
    init = await client.receive_json()
    assert init["event"] == {"event": "init", "plans": []}

    plan = living_room_plan()
    del plan["id"]
    await client.send_json_auto_id({"type": "zeitwerk/plans/create", "plan": plan})
    # events and result may interleave
    messages = [await client.receive_json() for _ in range(3)]
    result = next(m for m in messages if m.get("type") == "result")
    assert result["success"], result
    assert result["result"]["id"] == "heizung_wohnzimmer"
    assert result["result"]["status"]["profile"] == "comfort"
    events = [m["event"]["event"] for m in messages if m.get("type") == "event"]
    assert "added" in events
    assert temp(hass) == 22

    await client.send_json_auto_id({"type": "zeitwerk/plans/list", "tag": "heizung"})
    msg = await _result(client)
    assert [p["id"] for p in msg["result"]["plans"]] == ["heizung_wohnzimmer"]

    await client.send_json_auto_id({"type": "zeitwerk/plans/list", "tag": "licht"})
    assert (await _result(client))["result"]["plans"] == []

    bad = living_room_plan(default_profile="nope")
    await client.send_json_auto_id(
        {"type": "zeitwerk/plans/update", "plan_id": "heizung_wohnzimmer", "plan": bad}
    )
    msg = await _result(client)
    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"
    assert "unknown profile 'nope'" in msg["error"]["message"]

    await client.send_json_auto_id({"type": "zeitwerk/plans/get", "plan_id": "nope"})
    msg = await _result(client)
    assert msg["error"]["code"] == "not_found"

    await client.send_json_auto_id(
        {
            "type": "zeitwerk/preview",
            "start": at(WED, 0).isoformat(),
            "end": at(WED + timedelta(1), 0).isoformat(),
        }
    )
    msg = await _result(client)
    segments = msg["result"]["plans"]["heizung_wohnzimmer"]
    assert [s["profile"] for s in segments] == ["eco", "comfort", "eco"]

    await client.send_json_auto_id(
        {"type": "zeitwerk/plans/delete", "plan_id": "heizung_wohnzimmer"}
    )
    msg = await _result(client)
    assert msg["success"]


async def _result(client) -> dict:
    while True:
        msg = await client.receive_json()
        if msg.get("type") == "result":
            return msg


async def test_ws_admin_only(
    hass: HomeAssistant,
    freezer: FrozenDateTimeFactory,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    client = await hass_ws_client(hass, hass_read_only_access_token)
    freezer.move_to(at(WED, 17, 40))
    await setup_helpers(hass)
    await setup_zeitwerk(hass)
    await client.send_json_auto_id(
        {"type": "zeitwerk/plans/create", "plan": living_room_plan()}
    )
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "unauthorized"
    # reading is allowed
    await client.send_json_auto_id({"type": "zeitwerk/plans/list"})
    assert (await client.receive_json())["success"]


async def test_ws_holidays_upcoming(
    hass: HomeAssistant,
    hass_ws_client: WebSocketGenerator,
    freezer: FrozenDateTimeFactory,
) -> None:
    client = await hass_ws_client(hass)  # authenticate before freezing time
    freezer.move_to(at(WED, 10))
    await setup_helpers(hass)
    await setup_zeitwerk(hass)
    hass.states.async_set("calendar.feiertage", "off")
    dates = {
        date(2026, 12, 25): "1. Weihnachtstag",
        date(2026, 12, 26): "2. Weihnachtstag",
        date(2027, 1, 1): "Neujahr",
        date(2026, 10, 3): "Tag der Deutschen Einheit",
    }
    with patch(
        "custom_components.zeitwerk.holidays.HolidaySource._async_read_calendar",
        return_value=dates,
    ):
        await client.send_json_auto_id(
            {"type": "zeitwerk/holidays/upcoming", "source": "calendar.feiertage"}
        )
        msg = await client.receive_json()
    assert msg["success"], msg
    assert msg["result"] == {
        "kind": "calendar",
        "holidays": [
            {"date": "2026-12-25", "name": "1. Weihnachtstag"},
            {"date": "2026-12-26", "name": "2. Weihnachtstag"},
            {"date": "2027-01-01", "name": "Neujahr"},
        ],
    }

    await client.send_json_auto_id(
        {"type": "zeitwerk/holidays/upcoming", "source": "sensor.nope"}
    )
    msg = await client.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"
