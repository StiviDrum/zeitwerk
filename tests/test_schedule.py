"""Pure schedule maths: day types, holidays, midnight, next change, DST."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from custom_components.zeitwerk.model import Plan
from custom_components.zeitwerk.schedule import (
    boundaries,
    local_instant,
    next_change,
    next_evaluation,
    no_holidays,
    preview,
    scheduled_at,
)
from custom_components.zeitwerk.schema import validate_plan

from .common import living_room_plan

TZ = ZoneInfo("Europe/Berlin")
# 2026-11-04 is a Wednesday
WED = date(2026, 11, 4)
FRI = date(2026, 11, 6)
SAT = date(2026, 11, 7)
SPRING = date(2026, 3, 29)  # last Sunday of March: 02:00 CET -> 03:00 CEST
AUTUMN = date(2026, 10, 25)  # last Sunday of October: 03:00 CEST -> 02:00 CET


def at(day: date, hh: int, mm: int = 0) -> datetime:
    return datetime(day.year, day.month, day.day, hh, mm, tzinfo=TZ)


def plan(**changes: Any) -> Plan:
    return Plan.from_dict(validate_plan(living_room_plan(**changes)))


def week(
    workday: list[dict], weekend: list[dict], extra: list[dict] | None = None
) -> dict:
    return {
        "day_types": [
            {
                "id": "workday",
                "name": "Werktag",
                "days": ["mon", "tue", "wed", "thu", "fri"],
                "blocks": workday,
            },
            {"id": "weekend", "name": "WE", "days": ["sat", "sun"], "blocks": weekend},
            *(extra or []),
        ]
    }


def holidays_on(*days: date):
    return lambda d: d in days


def profile_at(p: Plan, when: datetime, holiday=no_holidays) -> str:
    return scheduled_at(p, when, TZ, holiday).profile


def test_reference_workday_and_weekend() -> None:
    p = plan()
    state = scheduled_at(p, at(WED, 17, 40), TZ, no_holidays)
    assert state.profile == "comfort"
    assert state.day_type == "workday"
    assert state.from_block
    assert not state.is_holiday
    assert profile_at(p, at(WED, 15, 59)) == "eco"
    assert profile_at(p, at(WED, 16, 0)) == "comfort"
    assert profile_at(p, at(WED, 22, 0)) == "eco"
    assert profile_at(p, at(SAT, 9, 0)) == "comfort"
    assert scheduled_at(p, at(SAT, 8, 0), TZ, no_holidays).day_type == "weekend"


def test_next_change() -> None:
    p = plan()
    assert next_change(p, at(WED, 17, 40), TZ, no_holidays) == (at(WED, 22), "eco")
    assert next_change(p, at(WED, 23), TZ, no_holidays) == (
        at(date(2026, 11, 5), 16),
        "comfort",
    )
    assert next_change(p, at(FRI, 23), TZ, no_holidays) == (at(SAT, 9), "comfort")


def test_next_change_none_without_blocks() -> None:
    p = plan(week=week([], []))
    assert next_change(p, at(WED, 12), TZ, no_holidays) is None
    # still re-evaluated at midnight
    assert next_evaluation(p, at(WED, 12), TZ, no_holidays) == at(WED + timedelta(1), 0)


def test_missing_day_type_uses_default() -> None:
    p = plan(
        week={
            "day_types": [
                {
                    "id": "workday",
                    "name": "W",
                    "days": ["mon"],
                    "blocks": [
                        {"start": "00:00", "end": "24:00", "profile": "comfort"}
                    ],
                }
            ]
        }
    )
    state = scheduled_at(p, at(WED, 12), TZ, no_holidays)
    assert state.profile == "eco"
    assert state.day_type is None
    assert not state.from_block


def test_block_until_2400() -> None:
    p = plan(week=week([{"start": "18:00", "end": "24:00", "profile": "comfort"}], []))
    assert profile_at(p, at(WED, 23, 59)) == "comfort"
    assert profile_at(p, at(WED + timedelta(1), 0, 0)) == "eco"
    assert next_change(p, at(WED, 19), TZ, no_holidays) == (
        at(WED + timedelta(1), 0),
        "eco",
    )


def test_block_across_midnight_keeps_start_day_type() -> None:
    p = plan(week=week([{"start": "22:00", "end": "06:00", "profile": "comfort"}], []))
    assert profile_at(p, at(FRI, 23)) == "comfort"
    # Friday's block runs into Saturday (a weekend day without blocks)
    assert profile_at(p, at(SAT, 5, 59)) == "comfort"
    assert profile_at(p, at(SAT, 6, 0)) == "eco"
    assert next_change(p, at(FRI, 23), TZ, no_holidays) == (at(SAT, 6), "eco")
    # Sunday has no midnight block -> Monday early morning is default
    assert profile_at(p, at(date(2026, 11, 9), 5)) == "eco"


def test_today_block_wins_over_spill() -> None:
    p = plan(
        week=week(
            [{"start": "22:00", "end": "06:00", "profile": "comfort"}],
            [{"start": "05:00", "end": "07:00", "profile": "away"}],
        )
    )
    assert profile_at(p, at(SAT, 4, 59)) == "comfort"
    assert profile_at(p, at(SAT, 5, 30)) == "away"


HOLIDAY_DAY_TYPE = {
    "id": "holiday",
    "name": "Feiertag",
    "days": [],
    "blocks": [{"start": "08:00", "end": "23:00", "profile": "away"}],
}


def test_holiday_like_sunday() -> None:
    p = plan(
        holidays={"source": "calendar.feiertage", "mode": "like_day", "like_day": "sun"}
    )
    holiday = holidays_on(WED)
    state = scheduled_at(p, at(WED, 10), TZ, holiday)
    assert state.is_holiday
    assert state.day_type == "weekend"
    assert state.profile == "comfort"
    # day after is a normal workday again
    assert profile_at(p, at(WED + timedelta(1), 10), holiday) == "eco"


def test_holiday_own_day_type() -> None:
    p = plan(
        week=week(
            [{"start": "16:00", "end": "22:00", "profile": "comfort"}],
            [{"start": "09:00", "end": "22:00", "profile": "comfort"}],
            [HOLIDAY_DAY_TYPE],
        ),
        holidays={
            "source": "binary_sensor.workday",
            "mode": "own_day_type",
            "day_type": "holiday",
        },
    )
    state = scheduled_at(p, at(WED, 10), TZ, holidays_on(WED))
    assert (state.day_type, state.profile, state.is_holiday) == (
        "holiday",
        "away",
        True,
    )


def test_holiday_on_weekend() -> None:
    weekend_holiday = holidays_on(SAT)
    like_day = plan(
        holidays={"source": "calendar.feiertage", "mode": "like_day", "like_day": "sun"}
    )
    state = scheduled_at(like_day, at(SAT, 10), TZ, weekend_holiday)
    assert (state.day_type, state.profile, state.is_holiday) == (
        "weekend",
        "comfort",
        True,
    )

    own = plan(
        week=week(
            [],
            [{"start": "09:00", "end": "22:00", "profile": "comfort"}],
            [HOLIDAY_DAY_TYPE],
        ),
        holidays={
            "source": "calendar.feiertage",
            "mode": "own_day_type",
            "day_type": "holiday",
        },
    )
    state = scheduled_at(own, at(SAT, 10), TZ, weekend_holiday)
    assert (state.day_type, state.profile) == ("holiday", "away")


def test_holiday_mode_off_ignores_source() -> None:
    p = plan(holidays={"source": "calendar.feiertage", "mode": "off"})
    state = scheduled_at(p, at(WED, 10), TZ, holidays_on(WED))
    assert not state.is_holiday
    assert state.day_type == "workday"


def test_preview_day() -> None:
    p = plan()
    segments = preview(p, at(WED, 0), at(WED + timedelta(1), 0), TZ, no_holidays)
    assert [(s.start, s.end, s.profile) for s in segments] == [
        (at(WED, 0), at(WED, 16), "eco"),
        (at(WED, 16), at(WED, 22), "comfort"),
        (at(WED, 22), at(WED + timedelta(1), 0), "eco"),
    ]


# --- DST -------------------------------------------------------------------


def test_local_instant_spring_gap() -> None:
    # 02:30 does not exist on 2026-03-29 -> first valid instant 03:00 CEST
    instant = local_instant(SPRING, 150, TZ)
    assert instant.astimezone(UTC) == datetime(2026, 3, 29, 1, 0, tzinfo=UTC)
    local = instant.astimezone(TZ)
    assert (local.hour, local.minute) == (3, 0)


def test_spring_forward_block_in_gap() -> None:
    p = plan(week=week([], [{"start": "02:30", "end": "05:00", "profile": "comfort"}]))
    before = datetime(2026, 3, 29, 0, 59, tzinfo=UTC)  # 01:59 CET
    assert profile_at(p, before) == "eco"
    assert profile_at(p, datetime(2026, 3, 29, 1, 0, tzinfo=UTC)) == "comfort"
    change = next_change(p, before, TZ, no_holidays)
    assert change is not None
    assert change[0].astimezone(UTC) == datetime(2026, 3, 29, 1, 0, tzinfo=UTC)
    # 05:00 CEST = 03:00 UTC
    change = next_change(p, change[0], TZ, no_holidays)
    assert change[0].astimezone(UTC) == datetime(2026, 3, 29, 3, 0, tzinfo=UTC)


def test_spring_forward_normal_blocks_shift_correctly() -> None:
    p = plan()  # weekend 09:00-22:00
    change = next_change(p, at(SPRING, 0, 30), TZ, no_holidays)
    assert change is not None
    assert change[0].astimezone(UTC) == datetime(
        2026, 3, 29, 7, 0, tzinfo=UTC
    )  # 09:00 CEST


def test_fall_back_no_double_switch() -> None:
    # block 01:00-02:30 on the day the hour 02:00-03:00 repeats
    p = plan(week=week([], [{"start": "01:00", "end": "02:30", "profile": "comfort"}]))
    utc = lambda h, m=0: datetime(2026, 10, 25, h, m, tzinfo=UTC)  # noqa: E731
    assert profile_at(p, utc(0, 0)) == "comfort"  # 02:00 CEST
    assert profile_at(p, utc(0, 30)) == "eco"  # 02:30 CEST
    assert profile_at(p, utc(1, 0)) == "eco"  # 02:00 CET (repeated) - held
    assert profile_at(p, utc(1, 15)) == "eco"  # 02:15 CET
    assert profile_at(p, utc(2, 0)) == "eco"  # 03:00 CET
    segments = preview(p, at(AUTUMN, 0), at(AUTUMN + timedelta(1), 0), TZ, no_holidays)
    assert [s.profile for s in segments] == ["eco", "comfort", "eco"]
    assert segments[1].end.astimezone(UTC) == utc(0, 30)


def test_fall_back_day_length() -> None:
    p = plan(week=week([], [{"start": "09:00", "end": "22:00", "profile": "comfort"}]))
    segments = preview(p, at(AUTUMN, 0), at(AUTUMN + timedelta(1), 0), TZ, no_holidays)
    total = sum(((s.end - s.start) for s in segments), timedelta())
    assert total == timedelta(hours=25)
    assert segments[1].start.astimezone(UTC) == datetime(2026, 10, 25, 8, 0, tzinfo=UTC)


@pytest.mark.parametrize("day", [SPRING, AUTUMN])
def test_boundaries_strictly_increasing_on_dst_days(day: date) -> None:
    p = plan(
        week=week(
            [],
            [
                {"start": "01:00", "end": "02:15", "profile": "comfort"},
                {"start": "02:30", "end": "03:30", "profile": "away"},
                {"start": "22:00", "end": "00:30", "profile": "comfort"},
            ],
        )
    )
    points = boundaries(
        p, at(day, 0) - timedelta(hours=1), at(day + timedelta(1), 0), TZ, no_holidays
    )
    assert points == sorted(set(points))
    # walking the boundaries never revisits a state at the same instant
    previous = None
    for point in points:
        assert previous is None or point > previous
        previous = point
