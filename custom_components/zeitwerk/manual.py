"""Detection helpers for manual changes of a plan's target entities.

A plan's profiles set values on target entities. A change of such a value
whose context does not come from Zeitwerk is a manual change (SPEC §3). To
avoid false positives (e.g. a thermostat reporting a new current temperature),
only the attribute a profile actually sets is watched, and a change to exactly
the value the active profile sets counts as an echo, not as a manual change.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import State

from .model import Plan

STATE = "state"

# Service data key -> attribute holding that value (None = the state itself).
_KEY_ATTRIBUTES: dict[str, str | None] = {
    "value": None,
    "option": None,
    "temperature": "temperature",
    "target_temp_high": "target_temp_high",
    "target_temp_low": "target_temp_low",
    "hvac_mode": None,
    "brightness": "brightness",
    "brightness_pct": "brightness",
    "position": "current_position",
    "percentage": "percentage",
}
_VALUE_KEYS = tuple(_KEY_ATTRIBUTES)
_TURN_ON_OFF = {"turn_on": "on", "turn_off": "off"}


@dataclass(slots=True)
class TargetWatch:
    """Watched value per target entity and expected values per profile."""

    watched: dict[str, str] = field(default_factory=dict)
    expected: dict[str, dict[str, Any]] = field(default_factory=dict)

    @property
    def entities(self) -> list[str]:
        """Target entity ids."""
        return sorted(self.watched)


def _targets(action: dict[str, Any]) -> list[str]:
    target = action.get("target") or {}
    ids = target.get("entity_id", action.get("entity_id", []))
    if isinstance(ids, str):
        ids = [ids]
    # Templates or "all" cannot be resolved statically.
    return [i for i in ids if isinstance(i, str) and "." in i and "{" not in i]


def build_watch(plan: Plan) -> TargetWatch:
    """Derive watched values from all profile actions of a plan."""
    watch = TargetWatch()
    for profile in plan.profiles:
        expected: dict[str, Any] = {}
        for action in profile.actions:
            if not isinstance(action, dict):
                continue
            service = str(action.get("action") or action.get("service") or "")
            if not service:
                continue
            data = action.get("data") or {}
            key = next((k for k in _VALUE_KEYS if k in data), None)
            for entity_id in _targets(action):
                if key is not None:
                    attr = _KEY_ATTRIBUTES[key]
                    watch.watched.setdefault(entity_id, attr or STATE)
                    value = data[key]
                    if key == "brightness_pct" and isinstance(value, int | float):
                        value = round(value * 255 / 100)
                    if not isinstance(value, str) or "{" not in value:
                        expected[entity_id] = value
                elif (verb := service.rpartition(".")[2]) in _TURN_ON_OFF:
                    watch.watched.setdefault(entity_id, STATE)
                    expected[entity_id] = _TURN_ON_OFF[verb]
                else:
                    watch.watched.setdefault(entity_id, STATE)
        watch.expected[profile.id] = expected
    return watch


def watched_value(state: State, watched: str) -> Any:
    """Return the watched value of a state object."""
    if watched == STATE:
        return state.state
    return state.attributes.get(watched)


def _same(a: Any, b: Any) -> bool:
    if a == b:
        return True
    try:
        return abs(float(a) - float(b)) < 1e-6
    except TypeError, ValueError:
        return str(a) == str(b)


def is_manual_change(
    old: State | None,
    new: State | None,
    watched: str,
    expected: Any,
) -> bool:
    """Whether a state change of a target is a relevant value change.

    ``expected`` is the value the active profile sets (``None`` if unknown).
    The caller has already ruled out Zeitwerk's own contexts.
    """
    if old is None or new is None:
        return False
    if STATE_UNAVAILABLE in (old.state, new.state) or STATE_UNKNOWN in (
        old.state,
        new.state,
    ):
        return False
    before, after = watched_value(old, watched), watched_value(new, watched)
    if after is None or _same(before, after):
        return False
    return expected is None or not _same(after, expected)
