"""Per-weekday view of a plan (same rules as the card's day editor).

Plans are stored with day types (docs/SPEC.md §3). For services and the card
a plan is edited per weekday: blocks stay within one day (00:00–24:00) and
weekdays with identical blocks are regrouped into day types when saving.
"""

from __future__ import annotations

import copy
import itertools
import json
from typing import Any

from .model import (
    HOLIDAY_MODE_OWN_DAY_TYPE,
    MINUTES_PER_DAY,
    WEEKDAYS,
    format_hhmm,
    parse_hhmm,
)

HOLIDAY = "holiday"
DAY_KEYS: tuple[str, ...] = (*WEEKDAYS, HOLIDAY)

_LABELS = {
    "de": ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"),
    "en": ("Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"),
}

Interval = tuple[int, int, str]


def _interval(block: dict[str, Any]) -> tuple[int, int, str]:
    start = parse_hhmm(block["start"]) % MINUTES_PER_DAY
    end = parse_hhmm(block["end"])
    if end <= start:
        end += MINUTES_PER_DAY
    return start, end, block["profile"]


def _subtract(
    pieces: list[tuple[int, int]], cut: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    rest = pieces
    for cs, ce in cut:
        nxt: list[tuple[int, int]] = []
        for s, e in rest:
            if ce <= s or cs >= e:
                nxt.append((s, e))
                continue
            if cs > s:
                nxt.append((s, cs))
            if ce < e:
                nxt.append((ce, e))
        rest = nxt
    return rest


def _to_blocks(intervals: list[Interval]) -> list[dict[str, str]]:
    """Sort, drop empty, merge touching blocks of the same profile."""
    out: list[list[Any]] = []
    for s, e, p in sorted(i for i in intervals if i[1] > i[0]):
        if out and out[-1][2] == p and out[-1][1] == s:
            out[-1][1] = e
        else:
            out.append([s, e, p])
    return [
        {"start": format_hhmm(s), "end": format_hhmm(e), "profile": p}
        for s, e, p in out
    ]


def _day_type_for(plan: dict[str, Any], weekday: str) -> dict[str, Any] | None:
    return next(
        (d for d in plan["week"]["day_types"] if weekday in d.get("days", [])), None
    )


def _holiday_type_id(plan: dict[str, Any]) -> str | None:
    holidays = plan.get("holidays") or {}
    if holidays.get("mode") == HOLIDAY_MODE_OWN_DAY_TYPE:
        return holidays.get("day_type")
    return None


def week_to_days(plan: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    """Effective blocks per weekday (and the own holiday day), never across midnight.

    Blocks of the stored plan that run past midnight are split; their morning
    part is added to the next weekday where it does not collide with that
    day's own blocks (as the engine does).
    """
    days: dict[str, list[dict[str, str]]] = {}
    for i, weekday in enumerate(WEEKDAYS):
        own = [
            _interval(b) for b in (_day_type_for(plan, weekday) or {}).get("blocks", [])
        ]
        prev_type = _day_type_for(plan, WEEKDAYS[(i + 6) % 7]) or {}
        prev = [_interval(b) for b in prev_type.get("blocks", [])]
        day: list[Interval] = [(s, min(e, MINUTES_PER_DAY), p) for s, e, p in own]
        own_pieces = [(s, e) for s, e, _ in day]
        for _s, e, p in prev:
            if e <= MINUTES_PER_DAY:
                continue
            day.extend(
                (s2, e2, p)
                for s2, e2 in _subtract([(0, e - MINUTES_PER_DAY)], own_pieces)
            )
        days[weekday] = _to_blocks(day)
    holiday_id = _holiday_type_id(plan)
    holiday = next(
        (d for d in plan["week"]["day_types"] if d["id"] == holiday_id), None
    )
    if holiday is not None:
        days[HOLIDAY] = _to_blocks(
            [
                (s, min(e, MINUTES_PER_DAY), p)
                for s, e, p in map(_interval, holiday["blocks"])
            ]
        )
    return days


def days_label(weekdays: list[str], language: str) -> str:
    """'Mo–Fr', 'Sa–So', 'Mo, Mi'."""
    labels = _LABELS.get(language.split("-", maxsplit=1)[0].lower(), _LABELS["en"])
    idx = sorted(WEEKDAYS.index(d) for d in weekdays)
    contiguous = all(b == a + 1 for a, b in itertools.pairwise(idx))
    if len(idx) >= 2 and contiguous:
        return f"{labels[idx[0]]}–{labels[idx[-1]]}"
    return ", ".join(labels[i] for i in idx)


def normalize_day_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Validate blocks of one day (start < end <= 24:00, no overlap) and merge."""
    intervals: list[Interval] = []
    for block in blocks:
        start, end = parse_hhmm(block["start"]), parse_hhmm(block["end"])
        if start >= MINUTES_PER_DAY or end <= start:
            raise ValueError(
                f"block {block['start']}–{block['end']}: start must be before end "
                "and blocks stay within one day (00:00–24:00)"
            )
        intervals.append((start, end, block["profile"]))
    intervals.sort()
    for (s1, e1, _), (s2, e2, _) in itertools.pairwise(intervals):
        if s2 < e1:
            raise ValueError(
                f"blocks {format_hhmm(s1)}–{format_hhmm(e1)} and "
                f"{format_hhmm(s2)}–{format_hhmm(e2)} overlap"
            )
    return _to_blocks(intervals)


def apply_day_plan(
    plan: dict[str, Any],
    targets: list[str],
    blocks: list[dict[str, Any]],
    language: str,
) -> dict[str, Any]:
    """Return a copy of ``plan`` where every target day gets exactly ``blocks``.

    Weekdays with identical blocks are regrouped into day types; existing day
    types keep id and name when their weekday set is unchanged.
    """
    plan = copy.deepcopy(plan)
    holiday_id = _holiday_type_id(plan)
    if HOLIDAY in targets and holiday_id is None:
        raise ValueError(
            "this plan has no own holiday day (holidays.mode must be 'own_day_type')"
        )
    new_blocks = normalize_day_blocks(blocks)
    days = week_to_days(plan)
    for target in targets:
        days[target] = copy.deepcopy(new_blocks)

    groups: dict[str, list[str]] = {}
    for weekday in WEEKDAYS:
        groups.setdefault(json.dumps(days[weekday]), []).append(weekday)
    old_types = plan["week"]["day_types"]
    taken = {holiday_id} if holiday_id else set()
    day_types: list[dict[str, Any]] = []
    for key, weekdays in groups.items():
        same = next(
            (
                d
                for d in old_types
                if d["id"] != holiday_id
                and sorted(d.get("days", [])) == sorted(weekdays)
            ),
            None,
        )
        base = same["id"] if same else "_".join(weekdays)
        type_id, n = base, 2
        while type_id in taken:
            type_id, n = f"{base}_{n}", n + 1
        taken.add(type_id)
        day_types.append(
            {
                "id": type_id,
                "name": same["name"] if same else days_label(weekdays, language),
                "days": weekdays,
                "blocks": json.loads(key),
            }
        )
    if holiday_id:
        old = next((d for d in old_types if d["id"] == holiday_id), None)
        day_types.append(
            {
                "id": holiday_id,
                "name": old["name"]
                if old
                else ("Feiertag" if language.startswith("de") else "Holiday"),
                "days": [],
                "blocks": days.get(HOLIDAY, []),
            }
        )
    plan["week"]["day_types"] = day_types
    return plan
