"""Validation of plan dicts (structure, references, HA actions/conditions)."""

from __future__ import annotations

import re
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import (
    condition as condition_helper,
    config_validation as cv,
    script as script_helper,
)
from homeassistant.util import slugify
import probatio as vol

from .const import MAX_PROFILES
from .model import (
    HOLIDAY_MODE_LIKE_DAY,
    HOLIDAY_MODE_OFF,
    HOLIDAY_MODE_OWN_DAY_TYPE,
    MANUAL_IGNORE,
    MANUAL_MINUTES_PREFIX,
    MANUAL_UNTIL_NEXT,
    MATCH_ALL,
    MATCH_ANY,
    MINUTES_PER_DAY,
    ROOM_REACTION_WINDOW,
    WEEKDAYS,
    WHEN_INACTIVE_NONE,
    WHEN_INACTIVE_PROFILE_PREFIX,
    parse_hhmm,
)

_ID_RE = re.compile(r"^[a-z0-9_]+$")
_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _id(value: Any) -> str:
    """Validate a slug-like id."""
    value = cv.string(value)
    if not _ID_RE.match(value):
        raise vol.Invalid(f"'{value}' is not a valid id (use a-z, 0-9 and _)")
    return value


def _color(value: Any) -> str:
    value = cv.string(value)
    if not _COLOR_RE.match(value):
        raise vol.Invalid(f"'{value}' is not a colour like #ff8b4a")
    return value.lower()


def _time(value: Any) -> str:
    value = cv.string(value)
    try:
        minutes = parse_hhmm(value)
    except ValueError as err:
        raise vol.Invalid(str(err)) from err
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _start_time(value: Any) -> str:
    value = _time(value)
    if value == "24:00":
        raise vol.Invalid("a block cannot start at 24:00")
    return value


def _sorted_unique(values: list[str]) -> list[str]:
    return sorted(set(values))


def _when_inactive(value: Any) -> str:
    value = cv.string(value)
    if value == WHEN_INACTIVE_NONE:
        return value
    if value.startswith(WHEN_INACTIVE_PROFILE_PREFIX):
        _id(value.removeprefix(WHEN_INACTIVE_PROFILE_PREFIX))
        return value
    raise vol.Invalid("when_inactive must be 'none' or 'profile:<profile id>'")


def _manual_override(value: Any) -> str:
    value = cv.string(value)
    if value in (MANUAL_UNTIL_NEXT, MANUAL_IGNORE):
        return value
    if value.startswith(MANUAL_MINUTES_PREFIX):
        minutes = value.removeprefix(MANUAL_MINUTES_PREFIX)
        if minutes.isdigit() and int(minutes) > 0:
            return value
    raise vol.Invalid("manual_override must be 'until_next', 'ignore' or 'minutes:<n>'")


TIME_STEPS = (5, 10, 15, 30, 60)


def _time_step(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value not in TIME_STEPS:
        raise vol.Invalid(
            "time_step must be one of "
            + ", ".join(str(v) for v in TIME_STEPS)
            + " (minutes)"
        )
    return value


_LIST_OF_DICTS = vol.All(cv.ensure_list, [dict])

BLOCK_SCHEMA = vol.Schema(
    {
        vol.Required("start"): _start_time,
        vol.Required("end"): _time,
        vol.Required("profile"): _id,
    }
)

DAY_TYPE_SCHEMA = vol.Schema(
    {
        vol.Required("id"): _id,
        vol.Required("name"): cv.string,
        vol.Optional("days", default=list): vol.All(cv.ensure_list, [vol.In(WEEKDAYS)]),
        vol.Optional("blocks", default=list): [BLOCK_SCHEMA],
        vol.Optional("resume_points"): vol.All(
            cv.ensure_list, [_start_time], _sorted_unique
        ),
        vol.Optional("resume_forced"): cv.boolean,
    }
)

PROFILE_SCHEMA = vol.Schema(
    {
        vol.Required("id"): _id,
        vol.Required("name"): cv.string,
        vol.Optional("color", default=None): vol.Any(None, _color),
        vol.Optional("icon", default=None): vol.Any(None, cv.icon),
        vol.Optional("actions", default=list): _LIST_OF_DICTS,
    }
)

OVERRIDE_SCHEMA = vol.Schema(
    {
        vol.Required("id"): _id,
        vol.Required("name"): cv.string,
        vol.Required("profile"): _id,
        vol.Optional("match", default=MATCH_ALL): vol.In([MATCH_ALL, MATCH_ANY]),
        vol.Optional("conditions", default=list): _LIST_OF_DICTS,
    }
)

ACTIVATION_SCHEMA = vol.Schema(
    {
        vol.Optional("match", default=MATCH_ALL): vol.In([MATCH_ALL, MATCH_ANY]),
        vol.Optional("conditions", default=list): _LIST_OF_DICTS,
        vol.Optional("when_inactive", default=WHEN_INACTIVE_NONE): _when_inactive,
        vol.Optional("reevaluate", default=True): cv.boolean,
    }
)

HOLIDAYS_SCHEMA = vol.Schema(
    {
        vol.Optional("source", default=None): vol.Any(
            None, cv.entity_domain(["calendar", "binary_sensor"])
        ),
        vol.Optional("mode", default=HOLIDAY_MODE_OFF): vol.In(
            [HOLIDAY_MODE_OFF, HOLIDAY_MODE_LIKE_DAY, HOLIDAY_MODE_OWN_DAY_TYPE]
        ),
        vol.Optional("like_day", default=None): vol.Any(None, vol.In(WEEKDAYS)),
        vol.Optional("day_type", default=None): vol.Any(None, _id),
    }
)

OPTIONS_SCHEMA = vol.Schema(
    {
        vol.Optional("reapply_on_start", default=True): cv.boolean,
        vol.Optional("reapply_on_profile_change", default=True): cv.boolean,
        vol.Optional("manual_override", default=MANUAL_UNTIL_NEXT): _manual_override,
        vol.Optional("time_step"): _time_step,
    }
)

PLAN_SCHEMA = vol.Schema(
    {
        vol.Required("id"): _id,
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1)),
        vol.Optional("enabled", default=True): cv.boolean,
        vol.Optional("icon", default=None): vol.Any(None, cv.icon),
        vol.Optional("tags", default=list): vol.All(cv.ensure_list, [cv.string]),
        vol.Required("profiles"): vol.All(
            [PROFILE_SCHEMA],
            vol.Length(
                min=1, max=MAX_PROFILES, msg=f"a plan has 1 to {MAX_PROFILES} profiles"
            ),
        ),
        vol.Required("default_profile"): _id,
        vol.Optional("activation", default=dict): ACTIVATION_SCHEMA,
        vol.Optional("holidays", default=dict): HOLIDAYS_SCHEMA,
        vol.Optional("week", default=dict): vol.Schema(
            {vol.Optional("day_types", default=list): [DAY_TYPE_SCHEMA]}
        ),
        vol.Optional("overrides", default=list): [OVERRIDE_SCHEMA],
        vol.Optional("options", default=dict): OPTIONS_SCHEMA,
        vol.Optional("room"): vol.Any(None, _id),
        vol.Optional("room_reactions"): vol.Schema(
            {vol.Optional(ROOM_REACTION_WINDOW): vol.Any(None, _id)}
        ),
    }
)

MAX_DELAY = 3600


def _delay(value: Any) -> int:
    """Validate a delay in seconds (0..3600)."""
    if isinstance(value, bool):
        raise vol.Invalid("delay must be a number of seconds")
    try:
        seconds = int(value)
    except (TypeError, ValueError) as err:
        raise vol.Invalid(f"'{value}' is not a number of seconds") from err
    if not 0 <= seconds <= MAX_DELAY:
        raise vol.Invalid(f"delay must be between 0 and {MAX_DELAY} seconds")
    return seconds


def _entity_list(value: Any) -> list[str]:
    """Validate a list of entity ids (duplicates dropped, order kept)."""
    ids = vol.All(cv.ensure_list, [cv.entity_id])(value)
    return list(dict.fromkeys(ids))


# "new" is the panel route for creating a room (/zeitwerk/room/new).
RESERVED_ROOM_IDS: frozenset[str] = frozenset({"new"})


def _room_id(value: Any) -> str:
    value = _id(value)
    if value in RESERVED_ROOM_IDS:
        raise vol.Invalid(f"'{value}' is reserved and cannot be used as a room id")
    return value


ROOM_SCHEMA = vol.Schema(
    {
        vol.Required("id"): _room_id,
        vol.Required("name"): vol.All(cv.string, vol.Length(min=1)),
        vol.Optional("area_id", default=None): vol.Any(None, cv.string),
        vol.Optional("icon", default=None): vol.Any(None, cv.icon),
        vol.Optional("windows", default=dict): vol.Schema(
            {
                vol.Optional("entities", default=list): _entity_list,
                vol.Optional("open_delay", default=60): _delay,
                vol.Optional("close_delay", default=0): _delay,
            }
        ),
        vol.Optional("sensors", default=dict): vol.Schema(
            {
                vol.Optional("temperature", default=None): vol.Any(None, cv.entity_id),
                vol.Optional("humidity", default=None): vol.Any(None, cv.entity_id),
            }
        ),
    }
)


def validate_room(data: dict[str, Any]) -> dict[str, Any]:
    """Structural validation of a room dict; returns the normalised dict."""
    return ROOM_SCHEMA(data)


def _unique(ids: list[str], what: str) -> None:
    seen: set[str] = set()
    for item in ids:
        if item in seen:
            raise vol.Invalid(f"duplicate {what} id '{item}'")
        seen.add(item)


def _intervals(blocks: list[dict[str, Any]]) -> list[tuple[int, int, int]]:
    """Map blocks onto the 24 h circle as (start, end, index) pieces."""
    pieces: list[tuple[int, int, int]] = []
    for index, block in enumerate(blocks):
        start, end = parse_hhmm(block["start"]), parse_hhmm(block["end"])
        if end > start:
            pieces.append((start, end, index))
        else:  # across midnight
            pieces.append((start, MINUTES_PER_DAY, index))
            if end > 0:
                pieces.append((0, end, index))
    return sorted(pieces)


def validate_plan_semantics(plan: dict[str, Any]) -> dict[str, Any]:
    """Check references and consistency of an already structurally valid plan."""
    profile_ids = [p["id"] for p in plan["profiles"]]
    _unique(profile_ids, "profile")
    profiles = set(profile_ids)

    def ref(profile_id: str, where: str) -> None:
        if profile_id not in profiles:
            raise vol.Invalid(f"{where}: unknown profile '{profile_id}'")

    ref(plan["default_profile"], "default_profile")

    day_types = plan["week"]["day_types"]
    _unique([d["id"] for d in day_types], "day type")
    owner: dict[str, str] = {}
    for day_type in day_types:
        for day in day_type["days"]:
            if day in owner:
                raise vol.Invalid(
                    f"weekday '{day}' belongs to day types '{owner[day]}' and "
                    f"'{day_type['id']}' – each weekday may have only one day type"
                )
            owner[day] = day_type["id"]
        for block in day_type["blocks"]:
            ref(block["profile"], f"day type '{day_type['id']}' block")
            if block["start"] == block["end"]:
                raise vol.Invalid(
                    f"day type '{day_type['id']}': block {block['start']}–"
                    f"{block['end']} has no duration"
                )
        prev_end, prev_index = -1, -1
        for start, end, index in _intervals(day_type["blocks"]):
            if start < prev_end and index != prev_index:
                b1 = day_type["blocks"][prev_index]
                b2 = day_type["blocks"][index]
                raise vol.Invalid(
                    f"day type '{day_type['id']}': blocks {b1['start']}–{b1['end']} "
                    f"and {b2['start']}–{b2['end']} overlap"
                )
            if end > prev_end:
                prev_end, prev_index = end, index

    _unique([o["id"] for o in plan["overrides"]], "override")
    for override in plan["overrides"]:
        ref(override["profile"], f"override '{override['id']}'")

    inactive = plan["activation"]["when_inactive"]
    if inactive.startswith(WHEN_INACTIVE_PROFILE_PREFIX):
        ref(
            inactive.removeprefix(WHEN_INACTIVE_PROFILE_PREFIX),
            "activation.when_inactive",
        )

    holidays = plan["holidays"]
    if holidays["mode"] != HOLIDAY_MODE_OFF and not holidays["source"]:
        raise vol.Invalid(
            "holidays: a source entity is required when mode is not 'off'"
        )
    if holidays["mode"] == HOLIDAY_MODE_LIKE_DAY and not holidays["like_day"]:
        raise vol.Invalid(
            "holidays: like_day (e.g. 'sun') is required for mode 'like_day'"
        )
    if holidays["mode"] == HOLIDAY_MODE_OWN_DAY_TYPE and holidays["day_type"] not in {
        d["id"] for d in day_types
    }:
        raise vol.Invalid(
            "holidays: day_type must reference an existing day type for mode "
            "'own_day_type'"
        )

    reactions = {k: v for k, v in (plan.get("room_reactions") or {}).items() if v}
    if not plan.get("room"):
        if reactions:
            raise vol.Invalid("room_reactions need a room: set 'room' first")
        plan.pop("room", None)
    for event, profile_id in reactions.items():
        ref(profile_id, f"room_reactions.{event}")
    if reactions:
        plan["room_reactions"] = reactions
    else:
        plan.pop("room_reactions", None)
    return plan


def validate_plan(
    data: dict[str, Any], rooms: set[str] | None = None
) -> dict[str, Any]:
    """Structural + semantic validation (sync). Returns normalised plan dict.

    ``rooms`` (known room ids) enables the check that ``room`` exists.
    """
    plan = validate_plan_semantics(PLAN_SCHEMA(data))
    if rooms is not None and plan.get("room") and plan["room"] not in rooms:
        known = ", ".join(sorted(rooms)) or "none yet"
        raise vol.Invalid(f"room: unknown room '{plan['room']}' (known rooms: {known})")
    return plan


async def async_validate_plan(
    hass: HomeAssistant, data: dict[str, Any], rooms: set[str] | None = None
) -> dict[str, Any]:
    """Full validation incl. HA actions and conditions.

    The returned dict keeps actions/conditions as given (JSON serialisable); they
    are compiled again when the plan is loaded by the engine.
    """
    plan = validate_plan(data, rooms)
    for profile in plan["profiles"]:
        try:
            await script_helper.async_validate_actions_config(
                hass, cv.SCRIPT_SCHEMA(profile["actions"])
            )
        except vol.Invalid as err:
            raise vol.Invalid(f"profile '{profile['id']}' actions: {err}") from err
    groups = [("activation", plan["activation"]["conditions"])] + [
        (f"override '{o['id']}'", o["conditions"]) for o in plan["overrides"]
    ]
    for where, conditions in groups:
        try:
            await condition_helper.async_validate_conditions_config(
                hass, cv.CONDITIONS_SCHEMA(conditions)
            )
        except vol.Invalid as err:
            raise vol.Invalid(f"{where} conditions: {err}") from err
    return plan


def replace_missing_profiles(plan: dict[str, Any]) -> dict[str, Any]:
    """Point references to removed profiles at the default profile.

    Blocks of a removed profile are dropped (gaps run the default profile),
    overrides and ``when_inactive`` switch to the default profile.
    """
    profiles = {p["id"] for p in plan.get("profiles", [])}
    default = plan.get("default_profile")
    if default not in profiles:
        return plan
    for day_type in plan.get("week", {}).get("day_types", []):
        day_type["blocks"] = [
            b for b in day_type.get("blocks", []) if b.get("profile") in profiles
        ]
    for override in plan.get("overrides", []):
        if override.get("profile") not in profiles:
            override["profile"] = default
    activation = plan.get("activation") or {}
    when = activation.get("when_inactive", WHEN_INACTIVE_NONE)
    if (
        when.startswith(WHEN_INACTIVE_PROFILE_PREFIX)
        and when.removeprefix(WHEN_INACTIVE_PROFILE_PREFIX) not in profiles
    ):
        activation["when_inactive"] = f"{WHEN_INACTIVE_PROFILE_PREFIX}{default}"
    # A window reaction onto a removed profile is dropped (plan ignores windows).
    if reactions := plan.get("room_reactions"):
        kept = {k: v for k, v in reactions.items() if v in profiles}
        if kept:
            plan["room_reactions"] = kept
        else:
            plan.pop("room_reactions")
    return plan


def make_plan_id(name: str, existing: set[str], fallback: str = "plan") -> str:
    """Derive a unique slug id from a plan (or room) name."""
    base = slugify(name) or fallback
    candidate, counter = base, 2
    while candidate in existing:
        candidate = f"{base}_{counter}"
        counter += 1
    return candidate
