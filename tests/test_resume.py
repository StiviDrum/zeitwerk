"""Resume points and the resume service (SPEC §3 "Rücksetzpunkte")."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from unittest.mock import patch

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
import probatio as vol
import pytest

from custom_components.zeitwerk.days import apply_day_plan, week_to_resume
from custom_components.zeitwerk.model import Plan
from custom_components.zeitwerk.schedule import (
    iter_resume_points,
    next_evaluation,
    next_resume_point,
    no_holidays,
)
from custom_components.zeitwerk.schema import validate_plan

from .common import living_room_plan
from .test_engine import TZ, WED, at, set_temp, start, temp, tick, toggle

PLAN = "wohnzimmer_heizung"
THU = WED + timedelta(days=1)
SPRING = date(2026, 3, 29)  # Sunday: 02:00 CET -> 03:00 CEST
AUTUMN = date(2026, 10, 25)  # Sunday: 03:00 CEST -> 02:00 CET


def week(
    workday: list[str] | None = None,
    *,
    forced: bool = False,
    weekend: list[str] | None = None,
    weekend_blocks: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Reference week with resume points on the workday / weekend day type."""
    data = living_room_plan()["week"]
    work, end = data["day_types"]
    if workday is not None:
        work["resume_points"] = workday
    if forced:
        work["resume_forced"] = True
    if weekend is not None:
        end["resume_points"] = weekend
    if weekend_blocks is not None:
        end["blocks"] = weekend_blocks
    return data


def plan(**changes: Any) -> Plan:
    return Plan.from_dict(validate_plan(living_room_plan(**changes)))


def _status(manager):
    return manager.runners[PLAN].status


# --- schema / storage -----------------------------------------------------------


def test_schema_sorts_and_deduplicates() -> None:
    data = validate_plan(living_room_plan(week=week(["22:00", "13:00", "13:00"])))
    workday = data["week"]["day_types"][0]
    assert workday["resume_points"] == ["13:00", "22:00"]
    # empty settings are not stored
    assert "resume_points" not in data["week"]["day_types"][1]
    assert "resume_forced" not in data["week"]["day_types"][1]
    assert Plan.from_dict(data).to_dict()["week"]["day_types"][0]["resume_points"] == [
        "13:00",
        "22:00",
    ]


@pytest.mark.parametrize("bad", ["24:00", "25:00", "7:5", "abc"])
def test_schema_rejects_invalid_points(bad: str) -> None:
    with pytest.raises(vol.Invalid):
        validate_plan(living_room_plan(week=week([bad])))


# --- pure schedule maths ----------------------------------------------------------


def test_iter_resume_points_by_day_type() -> None:
    p = plan(week=week(["13:00"], weekend=["23:00"]))
    points = list(
        iter_resume_points(p, at(WED, 13), at(WED + timedelta(4), 0), TZ, no_holidays)
    )
    # Wed 13:00 itself is excluded (start is exclusive)
    assert points == [
        at(THU, 13),
        at(WED + timedelta(2), 13),
        at(WED + timedelta(3), 23),  # Saturday
    ]
    assert next_resume_point(p, at(WED, 12), TZ, no_holidays) == at(WED, 13)
    # resume points are no profile boundaries
    assert next_evaluation(p, at(WED, 12), TZ, no_holidays) == at(WED, 16)


def test_forced_filter_and_holiday_day_type() -> None:
    data = week(["13:00"], forced=True)
    data["day_types"].append(
        {
            "id": "holiday",
            "name": "Feiertag",
            "days": [],
            "blocks": [],
            "resume_points": ["10:00"],
        }
    )
    p = plan(
        week=data,
        holidays={
            "source": "calendar.feiertage",
            "mode": "own_day_type",
            "day_type": "holiday",
        },
    )

    def is_holiday(day: date) -> bool:
        return day == THU

    all_points = list(
        iter_resume_points(p, at(WED, 0), at(THU, 23, 59), TZ, is_holiday)
    )
    assert all_points == [at(WED, 13), at(THU, 10)]
    forced = list(
        iter_resume_points(p, at(WED, 0), at(THU, 23, 59), TZ, is_holiday, forced=True)
    )
    assert forced == [at(WED, 13)]  # the holiday day type does not end forced


def test_resume_points_dst() -> None:
    p = plan(week=week(weekend=["02:15", "02:45", "04:00"]))
    spring = list(iter_resume_points(p, at(SPRING, 0), at(SPRING, 23), TZ, no_holidays))
    # 02:15 and 02:45 do not exist -> both at 03:00 CEST, only once
    assert spring == [
        datetime(2026, 3, 29, 1, 0, tzinfo=UTC),
        datetime(2026, 3, 29, 2, 0, tzinfo=UTC),
    ]
    autumn = list(iter_resume_points(p, at(AUTUMN, 0), at(AUTUMN, 23), TZ, no_holidays))
    # repeated hour: first occurrence (CEST) only
    assert autumn == [
        datetime(2026, 10, 25, 0, 15, tzinfo=UTC),
        datetime(2026, 10, 25, 0, 45, tzinfo=UTC),
        datetime(2026, 10, 25, 3, 0, tzinfo=UTC),
    ]


# --- day plan helpers (service set_day_plan) ----------------------------------------


def test_apply_day_plan_keeps_and_sets_resume_points() -> None:
    data = validate_plan(living_room_plan(week=week(["13:00"])))
    blocks = [{"start": "16:00", "end": "22:00", "profile": "comfort"}]
    # same blocks, no resume settings given -> unchanged grouping
    same = apply_day_plan(data, ["wed"], blocks, "de")
    assert same["week"]["day_types"] == data["week"]["day_types"]
    # new points for Wednesday only -> own day type
    changed = apply_day_plan(data, ["wed"], blocks, "de", resume_points=["22:30"])
    resume = week_to_resume(changed)
    assert resume["wed"] == {"resume_points": ["22:30"], "resume_forced": False}
    assert resume["mon"] == {"resume_points": ["13:00"], "resume_forced": False}
    assert len(changed["week"]["day_types"]) == 3
    # setting them for all workdays merges again
    merged = apply_day_plan(
        changed,
        ["mon", "tue", "wed", "thu", "fri"],
        blocks,
        "de",
        resume_points=["22:30"],
        resume_forced=True,
    )
    workday = merged["week"]["day_types"][0]
    assert workday["days"] == ["mon", "tue", "wed", "thu", "fri"]
    assert len(merged["week"]["day_types"]) == 2
    assert workday["resume_points"] == ["22:30"]
    assert workday["resume_forced"] is True
    validate_plan(merged)
    with pytest.raises(ValueError):
        apply_day_plan(data, ["wed"], blocks, "de", resume_points=["24:00"])


# --- engine -------------------------------------------------------------------------


async def test_resume_point_ends_manual_until_next(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40), week=week(["19:00"]))
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    status = _status(manager)
    assert status.manual_since == at(WED, 17, 40)
    assert status.manual_until == at(WED, 19)  # resume point before 22:00
    await tick(hass, freezer, at(WED, 18, 59))
    assert temp(hass) == 20
    await tick(hass, freezer, at(WED, 19))
    assert temp(hass) == 22  # schedule resumed (same profile, re-applied)
    assert status.manual_since is None
    assert status.source == "schedule"


async def test_resume_point_before_minutes_window(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(
        hass,
        freezer,
        at(WED, 17, 40),
        week=week(["18:00"]),
        options={"manual_override": "minutes:120"},
    )
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    assert _status(manager).manual_until == at(WED, 18)
    await tick(hass, freezer, at(WED, 18))
    assert temp(hass) == 22
    assert _status(manager).manual_since is None


async def test_resume_point_keeps_forced_unless_configured(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40), week=week(["19:00"]))
    runner = manager.runners[PLAN]
    await runner.async_force_profile("away", timedelta(hours=3))
    await hass.async_block_till_done()
    assert runner.status.forced_until == at(WED, 20, 40)
    await tick(hass, freezer, at(WED, 19))
    assert temp(hass) == 16
    assert runner.status.source == "forced"


async def test_resume_point_ends_forced_when_configured(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(
        hass, freezer, at(WED, 17, 40), week=week(["19:00"], forced=True)
    )
    runner = manager.runners[PLAN]
    await runner.async_force_profile("away", timedelta(hours=3))
    await hass.async_block_till_done()
    assert temp(hass) == 16
    assert runner.status.forced_until == at(WED, 19)
    assert runner.status.next_change == at(WED, 19)
    assert runner.status.next_profile == "comfort"
    await tick(hass, freezer, at(WED, 19))
    assert temp(hass) == 22
    assert runner.status.source == "schedule"
    assert "forced" not in runner.runtime


async def test_resume_point_keeps_override_priority(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40), week=week(["19:00"]))
    await toggle(hass, "urlaub", True)
    assert temp(hass) == 16
    await set_temp(hass, 19)
    await hass.async_block_till_done()
    assert _status(manager).manual_since is not None
    await tick(hass, freezer, at(WED, 19))
    assert temp(hass) == 16  # override profile, not the schedule
    assert _status(manager).source == "override:vacation"
    assert _status(manager).manual_since is None


async def test_resume_point_inside_block_across_midnight(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    # Saturday 20:00 – Sunday 02:00 comfort, resume point Sunday 01:00
    _, manager = await start(
        hass,
        freezer,
        at(WED + timedelta(3), 23),
        week=week(
            weekend=["01:00"],
            weekend_blocks=[{"start": "20:00", "end": "02:00", "profile": "comfort"}],
        ),
    )
    assert temp(hass) == 22
    await set_temp(hass, 25)
    await hass.async_block_till_done()
    sunday = WED + timedelta(4)
    assert _status(manager).manual_until == at(sunday, 1)
    await tick(hass, freezer, at(sunday, 1))
    assert temp(hass) == 22
    assert _status(manager).manual_since is None


async def test_missed_resume_point_after_restart(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    entry, manager = await start(
        hass,
        freezer,
        at(WED, 17, 40),
        week=week(["19:00"]),
        options={"reapply_on_start": False},
    )
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    assert _status(manager).manual_since is not None
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    freezer.move_to(at(WED, 19, 30))  # HA was down at 19:00
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert temp(hass) == 22
    assert _status(entry.runtime_data).manual_since is None


async def test_resume_point_dst_spring_forward(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    # 02:30 does not exist on SPRING -> resume at 03:00 CEST (01:00 UTC)
    utc = UTC
    _, manager = await start(
        hass,
        freezer,
        datetime(2026, 3, 29, 0, 30, tzinfo=utc),  # 01:30 CET
        week=week(weekend=["02:30"]),
    )
    assert temp(hass) == 18
    await set_temp(hass, 21)
    await hass.async_block_till_done()
    assert _status(manager).manual_until == datetime(2026, 3, 29, 1, 0, tzinfo=utc)
    await tick(hass, freezer, datetime(2026, 3, 29, 0, 59, tzinfo=utc))
    assert temp(hass) == 21
    await tick(hass, freezer, datetime(2026, 3, 29, 1, 0, tzinfo=utc))
    assert temp(hass) == 18
    assert _status(manager).manual_since is None


async def test_resume_point_dst_fall_back_only_once(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    utc = UTC
    _, manager = await start(
        hass,
        freezer,
        datetime(2026, 10, 24, 23, 0, tzinfo=utc),  # 01:00 CEST
        week=week(weekend=["02:30"]),
    )
    await set_temp(hass, 21)
    await hass.async_block_till_done()
    # 02:30 CEST (first pass)
    await tick(hass, freezer, datetime(2026, 10, 25, 0, 30, tzinfo=utc))
    assert temp(hass) == 18
    # manual change during the repeated hour survives 02:30 CET
    await tick(hass, freezer, datetime(2026, 10, 25, 1, 0, tzinfo=utc))
    await set_temp(hass, 21)
    await hass.async_block_till_done()
    await tick(hass, freezer, datetime(2026, 10, 25, 1, 30, tzinfo=utc))
    await tick(hass, freezer, datetime(2026, 10, 25, 1, 45, tzinfo=utc))
    assert temp(hass) == 21
    assert _status(manager).manual_since is not None


async def test_resume_service(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    _, manager = await start(hass, freezer, at(WED, 17, 40))
    runner = manager.runners[PLAN]
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    await hass.services.async_call("zeitwerk", "resume", {"plan": PLAN}, blocking=True)
    await hass.async_block_till_done()
    assert temp(hass) == 22
    assert runner.status.manual_since is None

    await runner.async_force_profile("away", timedelta(hours=2))
    await hass.async_block_till_done()
    assert temp(hass) == 16
    await hass.services.async_call("zeitwerk", "resume", {}, blocking=True)
    await hass.async_block_till_done()
    assert temp(hass) == 22
    assert runner.status.source == "schedule"
    assert "forced" not in runner.runtime

    # overrides keep their priority
    await toggle(hass, "urlaub", True)
    await set_temp(hass, 19)
    await hass.async_block_till_done()
    await hass.services.async_call("zeitwerk", "resume", {"plan": PLAN}, blocking=True)
    await hass.async_block_till_done()
    assert temp(hass) == 16
    assert runner.status.source == "override:vacation"


async def test_resume_timer_removed_on_unload(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    entry, manager = await start(hass, freezer, at(WED, 17, 40), week=week(["19:00"]))
    runner = manager.runners[PLAN]
    await set_temp(hass, 20)
    await hass.async_block_till_done()
    assert runner._timer_point == at(WED, 19)
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert runner._unsub_timer is None
    with patch.object(runner, "_evaluate") as evaluate:
        await tick(hass, freezer, at(WED, 19))
    evaluate.assert_not_called()
    assert temp(hass) == 20
