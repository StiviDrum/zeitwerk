"""Editing and read services (full control for automations / assistants)."""

from __future__ import annotations

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import ServiceValidationError, Unauthorized
import pytest

from custom_components.zeitwerk.days import (
    apply_day_plan,
    days_label,
    normalize_day_blocks,
    week_to_days,
)

from .common import living_room_plan
from .test_engine import WED, at, start, temp, tick

PLAN = "wohnzimmer_heizung"


async def call(hass: HomeAssistant, service: str, response: bool = False, **data):
    result = await hass.services.async_call(
        "zeitwerk", service, data, blocking=True, return_response=response
    )
    await hass.async_block_till_done()
    return result


def b(start: str, end: str, profile: str = "comfort") -> dict[str, str]:
    return {"start": start, "end": end, "profile": profile}


# --- pure day logic -------------------------------------------------------------


def test_week_to_days_and_regroup() -> None:
    plan = living_room_plan()
    days = week_to_days(plan)
    assert days["mon"] == [b("16:00", "22:00")]
    assert days["sun"] == [b("09:00", "22:00")]
    assert "holiday" not in days

    new = apply_day_plan(
        plan, ["wed"], [b("06:00", "08:00"), b("16:00", "22:00")], "de"
    )
    types = [(d["id"], d["name"], d["days"]) for d in new["week"]["day_types"]]
    assert types == [
        ("mon_tue_thu_fri", "Mo, Di, Do, Fr", ["mon", "tue", "thu", "fri"]),
        ("wed", "Mi", ["wed"]),
        ("weekend", "Wochenende", ["sat", "sun"]),
    ]
    # original untouched, identical days keep their day type
    assert plan["week"]["day_types"][0]["id"] == "workday"
    same = apply_day_plan(plan, ["sat"], [b("09:00", "22:00")], "en")
    assert same["week"]["day_types"] == plan["week"]["day_types"]


def test_midnight_blocks_are_split() -> None:
    plan = living_room_plan()
    plan["week"]["day_types"][0]["blocks"] = [b("22:00", "06:00")]
    days = week_to_days(plan)
    assert days["mon"] == [b("22:00", "24:00")]
    assert days["tue"] == [b("00:00", "06:00"), b("22:00", "24:00")]
    # Saturday morning gets Friday's spill, then its own block
    assert days["sat"] == [b("00:00", "06:00"), b("09:00", "22:00")]


def test_day_block_validation() -> None:
    assert normalize_day_blocks([b("08:00", "10:00"), b("06:00", "08:00")]) == [
        b("06:00", "10:00")
    ]
    with pytest.raises(ValueError, match="overlap"):
        normalize_day_blocks([b("06:00", "09:00"), b("08:00", "10:00", "away")])
    with pytest.raises(ValueError, match="within one day"):
        normalize_day_blocks([b("22:00", "06:00")])
    assert days_label(["mon", "tue", "wed"], "de") == "Mo–Mi"
    assert days_label(["mon", "wed"], "en") == "Mo, We"


# --- services ---------------------------------------------------------------------


async def test_get_plan(hass: HomeAssistant, freezer: FrozenDateTimeFactory) -> None:
    await start(hass, freezer, at(WED, 17, 40))
    result = await call(hass, "get_plan", True, plan=PLAN)
    plan = result["plans"][0]
    assert plan["id"] == PLAN
    assert plan["days"]["wed"] == [b("16:00", "22:00")]
    assert plan["status"]["profile"] == "comfort"
    assert [p["id"] for p in plan["profiles"]] == ["comfort", "eco", "away"]
    everything = await call(hass, "get_plan", True)
    assert len(everything["plans"]) == 1
    with pytest.raises(ServiceValidationError):
        await call(hass, "get_plan", True, plan="nope")


async def test_profile_sensor_describes_plan(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    await start(hass, freezer, at(WED, 17, 40))
    attrs = hass.states.get("sensor.zeitwerk_wohnzimmer_heizung_profile").attributes
    assert attrs["plan_id"] == PLAN
    assert attrs["profiles"] == {
        "comfort": "Komfort",
        "eco": "Absenkung",
        "away": "Abwesend",
    }
    assert attrs["overrides"][0] == {
        "id": "vacation",
        "name": "Urlaub",
        "profile": "away",
        "active": False,
    }


async def test_set_day_plan_applies(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    await start(hass, freezer, at(WED, 6, 30))
    assert temp(hass) == 18
    await call(
        hass,
        "set_day_plan",
        plan=PLAN,
        days=["wed", "thu"],
        blocks=[b("06:00", "08:00"), b("16:00", "22:00")],
    )
    assert temp(hass) == 22  # Wednesday 06:30 is now comfort
    result = await call(hass, "get_plan", True, plan=PLAN)
    assert result["plans"][0]["days"]["thu"] == [
        b("06:00", "08:00"),
        b("16:00", "22:00"),
    ]
    assert result["plans"][0]["days"]["mon"] == [b("16:00", "22:00")]

    with pytest.raises(ServiceValidationError, match="overlap"):
        await call(
            hass,
            "set_day_plan",
            plan=PLAN,
            days=["mon"],
            blocks=[b("06:00", "09:00"), b("08:00", "10:00")],
        )
    with pytest.raises(ServiceValidationError, match="own holiday day"):
        await call(hass, "set_day_plan", plan=PLAN, days=["holiday"], blocks=[])
    with pytest.raises(ServiceValidationError):
        await call(
            hass,
            "set_day_plan",
            plan=PLAN,
            days=["mon"],
            blocks=[b("06:00", "08:00", "nope")],
        )
    # clearing a day
    await call(hass, "set_day_plan", plan=PLAN, days=["wed"], blocks=[])
    assert temp(hass) == 18


async def test_geofencing_override(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    """The use case: geofencing helper on -> away, via services only."""
    await start(hass, freezer, at(WED, 17, 40), overrides=[])
    hass.states.async_set("input_boolean.claude_heizung_abgesenkt", "off")
    await call(
        hass,
        "set_override",
        plan=PLAN,
        name="Niemand zu Hause",
        profile="away",
        conditions=[
            {
                "condition": "state",
                "entity_id": "input_boolean.claude_heizung_abgesenkt",
                "state": "on",
            }
        ],
    )
    assert temp(hass) == 22
    hass.states.async_set("input_boolean.claude_heizung_abgesenkt", "on")
    await hass.async_block_till_done()
    assert temp(hass) == 16
    hass.states.async_set("input_boolean.claude_heizung_abgesenkt", "off")
    await hass.async_block_till_done()
    assert temp(hass) == 22  # back to the week plan

    # second rule on top, then edit and remove
    await call(
        hass,
        "set_override",
        plan=PLAN,
        override_id="vacation",
        name="Urlaub",
        profile="eco",
        conditions=[
            {"condition": "state", "entity_id": "input_boolean.urlaub", "state": "on"}
        ],
        position=0,
    )
    result = await call(hass, "get_plan", True, plan=PLAN)
    assert [o["id"] for o in result["plans"][0]["overrides"]] == [
        "vacation",
        "niemand_zu_hause",
    ]
    await call(hass, "set_override", plan=PLAN, override_id="vacation", profile="away")
    result = await call(hass, "get_plan", True, plan=PLAN)
    assert result["plans"][0]["overrides"][0]["profile"] == "away"
    assert result["plans"][0]["overrides"][0]["name"] == "Urlaub"
    await call(hass, "remove_override", plan=PLAN, override_id="vacation")
    with pytest.raises(ServiceValidationError):
        await call(hass, "remove_override", plan=PLAN, override_id="vacation")
    with pytest.raises(ServiceValidationError, match="required"):
        await call(hass, "set_override", plan=PLAN, override_id="new", name="X")
    with pytest.raises(ServiceValidationError):
        await call(
            hass,
            "set_override",
            plan=PLAN,
            name="Kaputt",
            profile="nope",
            conditions=[],
        )


async def test_update_create_delete(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    await start(hass, freezer, at(WED, 17, 40))
    await call(
        hass,
        "update_plan",
        plan=PLAN,
        name="Wohnzimmer",
        activation={
            "conditions": [
                {
                    "condition": "state",
                    "entity_id": "input_boolean.heizperiode",
                    "state": "off",
                }
            ]
        },
        options={"manual_override": "minutes:30"},
    )
    result = (await call(hass, "get_plan", True, plan=PLAN))["plans"][0]
    assert result["name"] == "Wohnzimmer"
    assert result["activation"]["match"] == "all"  # merged, not replaced
    assert result["options"]["manual_override"] == "minutes:30"
    assert result["options"]["reapply_on_start"] is True
    assert result["status"]["active"] is False

    with pytest.raises(ServiceValidationError):
        await call(hass, "update_plan", plan=PLAN, default_profile="nope")

    new = living_room_plan()
    del new["id"]
    new["name"] = "Heizung Bad"
    created = await call(hass, "create_plan", True, plan=new)
    assert created == {"plan_id": "heizung_bad"}
    assert hass.states.get("switch.zeitwerk_heizung_bad") is not None
    await call(hass, "delete_plan", plan="heizung_bad")
    assert (await call(hass, "get_plan", True))["plans"][0]["id"] == PLAN


async def test_editing_requires_admin(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, hass_read_only_user
) -> None:
    await start(hass, freezer, at(WED, 17, 40))
    context = Context(user_id=hass_read_only_user.id)
    with pytest.raises(Unauthorized):
        await hass.services.async_call(
            "zeitwerk",
            "set_day_plan",
            {"plan": PLAN, "days": ["mon"], "blocks": []},
            blocking=True,
            context=context,
        )
    # reading is fine for everyone
    result = await hass.services.async_call(
        "zeitwerk",
        "get_plan",
        {"plan": PLAN},
        blocking=True,
        context=context,
        return_response=True,
    )
    assert result["plans"][0]["id"] == PLAN
    await tick(hass, freezer, at(WED, 17, 41))
