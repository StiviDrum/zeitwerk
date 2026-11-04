"""Validation and model round-trip tests."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
import pytest

from custom_components.zeitwerk.compat import vol
from custom_components.zeitwerk.model import Plan, parse_hhmm
from custom_components.zeitwerk.schema import (
    async_validate_plan,
    make_plan_id,
    validate_plan,
)

from .common import living_room_plan


def _day_types(
    *blocks: dict[str, Any], days: list[str] | None = None
) -> dict[str, Any]:
    return {
        "day_types": [
            {
                "id": "all",
                "name": "All",
                "days": days if days is not None else ["mon"],
                "blocks": list(blocks),
            }
        ]
    }


def test_reference_plan_roundtrip() -> None:
    data = validate_plan(living_room_plan())
    plan = Plan.from_dict(data)
    assert plan.to_dict() == data
    assert plan.profile("comfort").name == "Komfort"
    assert plan.day_type_for_weekday("sat").id == "weekend"
    assert plan.options.manual_override == "until_next"
    assert plan.activation.reevaluate is True


def test_parse_hhmm() -> None:
    assert parse_hhmm("00:00") == 0
    assert parse_hhmm("24:00") == 1440
    for bad in ("24:15", "7", "7:5", "25:00", "aa:bb"):
        with pytest.raises(ValueError):
            parse_hhmm(bad)


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"default_profile": "nope"}, "default_profile: unknown profile 'nope'"),
        (
            {"week": _day_types({"start": "10:00", "end": "12:00", "profile": "x"})},
            "unknown profile 'x'",
        ),
        (
            {
                "week": _day_types(
                    {"start": "10:00", "end": "12:00", "profile": "comfort"},
                    {"start": "11:00", "end": "13:00", "profile": "eco"},
                )
            },
            "overlap",
        ),
        (
            {
                "week": _day_types(
                    {"start": "22:00", "end": "06:00", "profile": "comfort"},
                    {"start": "05:00", "end": "07:00", "profile": "eco"},
                )
            },
            "overlap",
        ),
        (
            {"week": _day_types({"start": "10:00", "end": "10:00", "profile": "eco"})},
            "no duration",
        ),
        (
            {
                "week": {
                    "day_types": [
                        {"id": "a", "name": "A", "days": ["mon"]},
                        {"id": "b", "name": "B", "days": ["mon"]},
                    ]
                }
            },
            "weekday 'mon' belongs to day types 'a' and 'b'",
        ),
        ({"holidays": {"mode": "like_day", "like_day": "sun"}}, "source entity"),
        (
            {"holidays": {"source": "calendar.feiertage", "mode": "like_day"}},
            "like_day",
        ),
        (
            {
                "holidays": {
                    "source": "calendar.feiertage",
                    "mode": "own_day_type",
                    "day_type": "holiday",
                }
            },
            "existing day type",
        ),
        ({"activation": {"when_inactive": "profile:nope"}}, "when_inactive"),
        ({"options": {"manual_override": "minutes:0"}}, "manual_override"),
    ],
)
def test_invalid_plans(changes: dict[str, Any], message: str) -> None:
    with pytest.raises(vol.Invalid, match=message):
        validate_plan(living_room_plan(**changes))


def test_adjacent_and_midnight_blocks_valid() -> None:
    validate_plan(
        living_room_plan(
            week=_day_types(
                {"start": "06:00", "end": "08:00", "profile": "comfort"},
                {"start": "08:00", "end": "10:00", "profile": "away"},
                {"start": "22:00", "end": "06:00", "profile": "eco"},
            )
        )
    )
    validate_plan(
        living_room_plan(
            week=_day_types({"start": "18:00", "end": "24:00", "profile": "comfort"})
        )
    )


async def test_async_validation_rejects_bad_action(hass: HomeAssistant) -> None:
    plan = living_room_plan()
    plan["profiles"][0]["actions"] = [{"nonsense": True}]
    with pytest.raises(vol.Invalid, match="profile 'comfort' actions"):
        await async_validate_plan(hass, plan)


async def test_async_validation_rejects_bad_condition(hass: HomeAssistant) -> None:
    plan = living_room_plan()
    plan["overrides"][0]["conditions"] = [{"condition": "state"}]
    with pytest.raises(vol.Invalid, match="override 'vacation' conditions"):
        await async_validate_plan(hass, plan)


async def test_async_validation_accepts_reference(hass: HomeAssistant) -> None:
    data = await async_validate_plan(hass, living_room_plan())
    # stored as given, JSON serialisable
    assert data["profiles"][0]["actions"][0]["data"] == {"value": 22}


def test_make_plan_id() -> None:
    assert make_plan_id("Heizung Wohnzimmer", set()) == "heizung_wohnzimmer"
    assert make_plan_id("Bad", {"bad", "bad_2"}) == "bad_3"
