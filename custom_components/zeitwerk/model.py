"""Data model for Zeitwerk plans (pure dataclasses, no Home Assistant imports).

The dict format (``to_dict`` / ``from_dict``) is the storage and websocket
format described in docs/SPEC.md §3.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

WEEKDAYS: tuple[str, ...] = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

MATCH_ALL = "all"
MATCH_ANY = "any"

HOLIDAY_MODE_OFF = "off"
HOLIDAY_MODE_LIKE_DAY = "like_day"
HOLIDAY_MODE_OWN_DAY_TYPE = "own_day_type"

WHEN_INACTIVE_NONE = "none"
WHEN_INACTIVE_PROFILE_PREFIX = "profile:"

MANUAL_UNTIL_NEXT = "until_next"
MANUAL_IGNORE = "ignore"
MANUAL_MINUTES_PREFIX = "minutes:"

MINUTES_PER_DAY = 24 * 60


def parse_hhmm(value: str) -> int:
    """Return minutes since midnight for ``HH:MM`` (``24:00`` allowed)."""
    try:
        hours_s, minutes_s = value.split(":")
        hours, minutes = int(hours_s), int(minutes_s)
    except (AttributeError, ValueError) as err:
        raise ValueError(f"invalid time '{value}', expected HH:MM") from err
    if len(minutes_s) != 2 or not 0 <= minutes < 60 or not 0 <= hours <= 24:
        raise ValueError(f"invalid time '{value}', expected HH:MM")
    if hours == 24 and minutes != 0:
        raise ValueError(f"invalid time '{value}', only 24:00 is allowed after 23:59")
    return hours * 60 + minutes


def format_hhmm(minutes: int) -> str:
    """Format minutes since midnight as ``HH:MM``."""
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


@dataclass(slots=True)
class Block:
    """A time window on a day type that selects a profile.

    ``end <= start`` means the block runs across midnight into the next day.
    """

    start: str
    end: str
    profile: str

    @property
    def start_min(self) -> int:
        """Start in minutes since midnight."""
        return parse_hhmm(self.start)

    @property
    def end_min(self) -> int:
        """End in minutes since midnight (24:00 -> 1440)."""
        return parse_hhmm(self.end)

    @property
    def crosses_midnight(self) -> bool:
        """Whether the block continues on the following day."""
        return self.end_min <= self.start_min

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Block:
        """Create from storage dict."""
        return cls(start=data["start"], end=data["end"], profile=data["profile"])

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {"start": self.start, "end": self.end, "profile": self.profile}


@dataclass(slots=True)
class DayType:
    """Named day profile (e.g. workday) assigned to weekdays."""

    id: str
    name: str
    days: list[str] = field(default_factory=list)
    blocks: list[Block] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DayType:
        """Create from storage dict."""
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            days=list(data.get("days", [])),
            blocks=[Block.from_dict(b) for b in data.get("blocks", [])],
        )

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {
            "id": self.id,
            "name": self.name,
            "days": list(self.days),
            "blocks": [b.to_dict() for b in self.blocks],
        }


@dataclass(slots=True)
class Profile:
    """Named set of actions."""

    id: str
    name: str
    color: str | None = None
    icon: str | None = None
    actions: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Profile:
        """Create from storage dict."""
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            color=data.get("color"),
            icon=data.get("icon"),
            actions=list(data.get("actions", [])),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {
            "id": self.id,
            "name": self.name,
            "color": self.color,
            "icon": self.icon,
            "actions": list(self.actions),
        }


@dataclass(slots=True)
class Override:
    """Condition based profile override; list order is priority."""

    id: str
    name: str
    profile: str
    match: str = MATCH_ALL
    conditions: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Override:
        """Create from storage dict."""
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            profile=data["profile"],
            match=data.get("match", MATCH_ALL),
            conditions=list(data.get("conditions", [])),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {
            "id": self.id,
            "name": self.name,
            "profile": self.profile,
            "match": self.match,
            "conditions": list(self.conditions),
        }


@dataclass(slots=True)
class Activation:
    """Conditions deciding whether a plan runs at all."""

    match: str = MATCH_ALL
    conditions: list[dict[str, Any]] = field(default_factory=list)
    when_inactive: str = WHEN_INACTIVE_NONE
    reevaluate: bool = True

    @property
    def inactive_profile(self) -> str | None:
        """Profile applied once while inactive (``when_inactive: profile:<id>``)."""
        if self.when_inactive.startswith(WHEN_INACTIVE_PROFILE_PREFIX):
            return self.when_inactive.removeprefix(WHEN_INACTIVE_PROFILE_PREFIX)
        return None

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Activation:
        """Create from storage dict."""
        data = data or {}
        return cls(
            match=data.get("match", MATCH_ALL),
            conditions=list(data.get("conditions", [])),
            when_inactive=data.get("when_inactive", WHEN_INACTIVE_NONE),
            reevaluate=data.get("reevaluate", True),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {
            "match": self.match,
            "conditions": list(self.conditions),
            "when_inactive": self.when_inactive,
            "reevaluate": self.reevaluate,
        }


@dataclass(slots=True)
class Holidays:
    """Holiday handling of a plan."""

    source: str | None = None
    mode: str = HOLIDAY_MODE_OFF
    like_day: str | None = None
    day_type: str | None = None

    @property
    def enabled(self) -> bool:
        """Whether holidays influence the plan."""
        return self.mode != HOLIDAY_MODE_OFF and bool(self.source)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Holidays:
        """Create from storage dict."""
        data = data or {}
        return cls(
            source=data.get("source"),
            mode=data.get("mode", HOLIDAY_MODE_OFF),
            like_day=data.get("like_day"),
            day_type=data.get("day_type"),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {
            "source": self.source,
            "mode": self.mode,
            "like_day": self.like_day,
            "day_type": self.day_type,
        }


@dataclass(slots=True)
class Options:
    """Behaviour options of a plan."""

    reapply_on_start: bool = True
    reapply_on_profile_change: bool = True
    manual_override: str = MANUAL_UNTIL_NEXT

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> Options:
        """Create from storage dict."""
        data = data or {}
        return cls(
            reapply_on_start=data.get("reapply_on_start", True),
            reapply_on_profile_change=data.get("reapply_on_profile_change", True),
            manual_override=data.get("manual_override", MANUAL_UNTIL_NEXT),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {
            "reapply_on_start": self.reapply_on_start,
            "reapply_on_profile_change": self.reapply_on_profile_change,
            "manual_override": self.manual_override,
        }


@dataclass(slots=True)
class Plan:
    """A Zeitwerk plan."""

    id: str
    name: str
    profiles: list[Profile]
    default_profile: str
    enabled: bool = True
    icon: str | None = None
    tags: list[str] = field(default_factory=list)
    day_types: list[DayType] = field(default_factory=list)
    overrides: list[Override] = field(default_factory=list)
    activation: Activation = field(default_factory=Activation)
    holidays: Holidays = field(default_factory=Holidays)
    options: Options = field(default_factory=Options)

    def profile(self, profile_id: str | None) -> Profile | None:
        """Return the profile with this id."""
        return next((p for p in self.profiles if p.id == profile_id), None)

    def day_type(self, day_type_id: str | None) -> DayType | None:
        """Return the day type with this id."""
        return next((d for d in self.day_types if d.id == day_type_id), None)

    def day_type_for_weekday(self, weekday: str) -> DayType | None:
        """Return the day type whose ``days`` contain the weekday."""
        return next((d for d in self.day_types if weekday in d.days), None)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Plan:
        """Create from storage dict."""
        week = data.get("week") or {}
        return cls(
            id=data["id"],
            name=data.get("name", data["id"]),
            enabled=data.get("enabled", True),
            icon=data.get("icon"),
            tags=list(data.get("tags", [])),
            profiles=[Profile.from_dict(p) for p in data.get("profiles", [])],
            default_profile=data["default_profile"],
            day_types=[DayType.from_dict(d) for d in week.get("day_types", [])],
            overrides=[Override.from_dict(o) for o in data.get("overrides", [])],
            activation=Activation.from_dict(data.get("activation")),
            holidays=Holidays.from_dict(data.get("holidays")),
            options=Options.from_dict(data.get("options")),
        )

    def to_dict(self) -> dict[str, Any]:
        """Return storage dict."""
        return {
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "icon": self.icon,
            "tags": list(self.tags),
            "profiles": [p.to_dict() for p in self.profiles],
            "default_profile": self.default_profile,
            "activation": self.activation.to_dict(),
            "holidays": self.holidays.to_dict(),
            "week": {"day_types": [d.to_dict() for d in self.day_types]},
            "overrides": [o.to_dict() for o in self.overrides],
            "options": self.options.to_dict(),
        }
