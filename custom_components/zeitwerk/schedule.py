"""Pure schedule maths: day types, blocks, next change, preview.

No Home Assistant runtime needed – everything works on timezone aware
datetimes, so it is easy to test (incl. DST switch days).

Rules (docs/SPEC.md §3):
- The day type of a date comes from the holiday settings or the weekday.
- Blocks are wall-clock times on their day type. A block with ``end <= start``
  runs across midnight and keeps the day type of its start day.
- Blocks of the current day win over a block spilling over from yesterday.
- Outside of all blocks the plan's ``default_profile`` applies.
- DST: wall times that do not exist (spring forward) start at the first valid
  instant after the gap; repeated wall times (fall back) use the first
  occurrence for boundaries.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta, tzinfo
import heapq

from .model import (
    HOLIDAY_MODE_LIKE_DAY,
    HOLIDAY_MODE_OWN_DAY_TYPE,
    MINUTES_PER_DAY,
    WEEKDAYS,
    Block,
    DayType,
    Plan,
)

HolidayFn = Callable[[date], bool]

# How far ahead next_change searches (a plan without any change returns None).
SEARCH_DAYS = 8


def no_holidays(_day: date) -> bool:
    """Holiday function for plans without holiday source."""
    return False


@dataclass(slots=True, frozen=True)
class ScheduleState:
    """Scheduled (block/default) profile at an instant."""

    profile: str
    day_type: str | None
    is_holiday: bool
    from_block: bool


@dataclass(slots=True, frozen=True)
class Segment:
    """Time range with one scheduled profile (for previews)."""

    start: datetime
    end: datetime
    profile: str


def day_type_for_date(
    plan: Plan, day: date, is_holiday: HolidayFn
) -> tuple[DayType | None, bool]:
    """Return (day type, is holiday) for a calendar date."""
    holiday = plan.holidays.enabled and is_holiday(day)
    if holiday and plan.holidays.mode == HOLIDAY_MODE_OWN_DAY_TYPE:
        return plan.day_type(plan.holidays.day_type), True
    weekday = WEEKDAYS[day.weekday()]
    if (
        holiday
        and plan.holidays.mode == HOLIDAY_MODE_LIKE_DAY
        and plan.holidays.like_day
    ):
        weekday = plan.holidays.like_day
    return plan.day_type_for_weekday(weekday), holiday


def _block_today(day_type: DayType | None, minute: int) -> Block | None:
    if day_type is None:
        return None
    for block in day_type.blocks:
        start, end = block.start_min, block.end_min
        if block.crosses_midnight:
            if minute >= start:
                return block
        elif start <= minute < end:
            return block
    return None


def _block_spill(day_type: DayType | None, minute: int) -> Block | None:
    if day_type is None:
        return None
    for block in day_type.blocks:
        if block.crosses_midnight and minute < block.end_min:
            return block
    return None


def scheduled_at(
    plan: Plan, when: datetime, tz: tzinfo, is_holiday: HolidayFn
) -> ScheduleState:
    """Return the scheduled profile at ``when`` (any aware datetime)."""
    local = when.astimezone(tz)
    today = local.date()
    minute = wall_minute(local)
    day_type, holiday = day_type_for_date(plan, today, is_holiday)
    block = _block_today(day_type, minute)
    if block is None:
        yesterday_type, _ = day_type_for_date(
            plan, today - timedelta(days=1), is_holiday
        )
        block = _block_spill(yesterday_type, minute)
    return ScheduleState(
        profile=block.profile if block else plan.default_profile,
        day_type=day_type.id if day_type else None,
        is_holiday=holiday,
        from_block=block is not None,
    )


def local_instant(day: date, minute: int, tz: tzinfo) -> datetime:
    """UTC instant for a wall-clock minute on a date (DST safe, see module doc)."""
    day = day + timedelta(days=minute // MINUTES_PER_DAY)
    minute %= MINUTES_PER_DAY
    naive = datetime.combine(day, time(minute // 60, minute % 60))
    normalised = naive.replace(tzinfo=tz, fold=0).astimezone(UTC)
    if normalised.astimezone(tz).replace(tzinfo=None) == naive:
        return normalised  # exists (first occurrence if repeated)
    # Inside a spring-forward gap: first valid instant after the gap.
    candidate = naive.replace(tzinfo=tz, fold=1).astimezone(UTC)
    while candidate.astimezone(tz).replace(tzinfo=None) < naive:
        candidate += timedelta(minutes=1)
    return candidate


def wall_minute(local: datetime) -> int:
    """Minute of day used for block lookup.

    During the second pass of a repeated hour (fall back, ``fold=1``) the state
    reached at the end of the first pass is held, so nothing switches twice.
    """
    minute = local.hour * 60 + local.minute
    if not local.fold:
        return minute
    tz = local.tzinfo
    assert tz is not None
    first = local
    while True:
        prev = (first.astimezone(UTC) - timedelta(minutes=1)).astimezone(tz)
        if not prev.fold:
            break
        first = prev
    offset_fold0 = local.replace(fold=0).utcoffset()
    offset_fold1 = local.utcoffset()
    assert offset_fold0 is not None
    assert offset_fold1 is not None
    repeated = int((offset_fold0 - offset_fold1).total_seconds() // 60)
    return first.hour * 60 + first.minute + repeated - 1


def iter_boundaries(
    plan: Plan, start: datetime, end: datetime, tz: tzinfo, is_holiday: HolidayFn
) -> Iterator[datetime]:
    """Instants (UTC) in (start, end] where the scheduled profile may change.

    Yields in order and computes day by day, so callers that only need the
    first change (the usual case) never look further ahead than necessary.
    """
    # Compare in UTC: aware datetimes sharing a tzinfo compare by wall time.
    start, end = start.astimezone(UTC), end.astimezone(UTC)
    day = start.astimezone(tz).date() - timedelta(days=1)
    last = end.astimezone(tz).date()
    pending: list[datetime] = []
    seen: set[datetime] = set()
    while day <= last:
        points = [local_instant(day, 0, tz)]
        day_type, _ = day_type_for_date(plan, day, is_holiday)
        if day_type is not None:
            for block in day_type.blocks:
                points.append(local_instant(day, block.start_min, tz))
                end_min = block.end_min + (
                    MINUTES_PER_DAY if block.crosses_midnight else 0
                )
                points.append(local_instant(day, end_min, tz))
        for point in points:
            if start < point <= end and point not in seen:
                seen.add(point)
                heapq.heappush(pending, point)
        # Later days only add points from their own midnight on.
        day += timedelta(days=1)
        horizon = local_instant(day, 0, tz)
        while pending and pending[0] < horizon:
            yield heapq.heappop(pending)
    while pending:
        yield heapq.heappop(pending)


def boundaries(
    plan: Plan, start: datetime, end: datetime, tz: tzinfo, is_holiday: HolidayFn
) -> list[datetime]:
    """All instants (UTC) in (start, end] where the scheduled profile may change."""
    return list(iter_boundaries(plan, start, end, tz, is_holiday))


def next_evaluation(
    plan: Plan, now: datetime, tz: tzinfo, is_holiday: HolidayFn
) -> datetime:
    """Next instant (UTC) the plan has to be re-evaluated (boundary or midnight)."""
    now = now.astimezone(UTC)
    horizon = now + timedelta(days=2)
    first = next(iter_boundaries(plan, now, horizon, tz, is_holiday), None)
    if first is not None:
        return first
    return local_instant(now.astimezone(tz).date(), MINUTES_PER_DAY, tz)


def next_change(
    plan: Plan, now: datetime, tz: tzinfo, is_holiday: HolidayFn
) -> tuple[datetime, str] | None:
    """First future instant (UTC) where the scheduled profile changes + new profile."""
    current = scheduled_at(plan, now, tz, is_holiday).profile
    for point in iter_boundaries(
        plan, now, now + timedelta(days=SEARCH_DAYS), tz, is_holiday
    ):
        profile = scheduled_at(plan, point, tz, is_holiday).profile
        if profile != current:
            return point, profile
    return None


def preview(
    plan: Plan, start: datetime, end: datetime, tz: tzinfo, is_holiday: HolidayFn
) -> list[Segment]:
    """Scheduled profile segments (UTC) covering [start, end)."""
    start, end = start.astimezone(UTC), end.astimezone(UTC)
    segments: list[Segment] = []
    seg_start = start
    profile = scheduled_at(plan, start, tz, is_holiday).profile
    for point in iter_boundaries(plan, start, end, tz, is_holiday):
        if point >= end:
            break
        new = scheduled_at(plan, point, tz, is_holiday).profile
        if new != profile:
            segments.append(Segment(seg_start, point, profile))
            seg_start, profile = point, new
    segments.append(Segment(seg_start, end, profile))
    return segments
