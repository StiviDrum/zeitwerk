"""Window state of a room (one tracker per room, shared by all its plans).

Open = at least one window entity is ``on``/``open`` for ``open_delay`` seconds;
closed again after all are closed for ``close_delay`` seconds. An entity that
turns ``unavailable`` / ``unknown`` keeps its last known open/closed value (a
dropping sensor must not end "window open"); one that has been unavailable since
start counts as closed. Such entities are reported as a problem (orchestrator
decision, overrides docs/SPEC.md §10 wording).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.helpers.event import (
    async_call_later,
    async_track_state_change_event,
)
from homeassistant.util import dt as dt_util

from .model import Room

OPEN_STATES = frozenset({"on", "open"})
PROBLEM_STATES = frozenset({STATE_UNAVAILABLE, STATE_UNKNOWN})


class RoomWindowTracker:
    """Debounced open/closed state of a room's window entities."""

    def __init__(
        self,
        hass: HomeAssistant,
        room: Room,
        on_update: Callable[[], None] | None = None,
        runtime: dict[str, Any] | None = None,
        on_runtime_changed: Callable[[], None] | None = None,
    ) -> None:
        """Initialise; ``on_update`` fires on every relevant change (entities).

        ``runtime`` is the persisted per-room dict (``window``: open + since) so a
        core restart does not make an open window flap.
        """
        self.hass = hass
        self.room = room
        self.is_open = False
        self.open_since: datetime | None = None
        self._on_update = on_update
        self.runtime = runtime if runtime is not None else {}
        self._on_runtime_changed = on_runtime_changed
        self._listeners: list[Callable[[], None]] = []
        self._raw = False
        # Last known open (True) / closed (False) value per entity.
        self._known: dict[str, bool] = {}
        self._raw_since = dt_util.utcnow()
        self._unsub_states: CALLBACK_TYPE | None = None
        self._unsub_timer: CALLBACK_TYPE | None = None
        self._running = False

    # ------------------------------------------------------------- lifecycle

    @callback
    def async_start(self) -> None:
        """Start listening and evaluate once (restart: old states count at once)."""
        self._running = True
        self._subscribe()
        self._evaluate(initial=True)

    @callback
    def async_reconfigure(self, room: Room) -> None:
        """Apply changed room settings in place without resetting the state.

        The debounced state stays; a pending delay keeps its start time and is
        re-armed with the new delay. Unchanged entities/delays (rename) do nothing.
        """
        old = self.room.windows
        self.room = room
        new = room.windows
        if not self._running or (
            new.entities == old.entities
            and new.open_delay == old.open_delay
            and new.close_delay == old.close_delay
        ):
            return
        if new.entities != old.entities:
            self._known = {k: v for k, v in self._known.items() if k in new.entities}
            if self._unsub_states:
                self._unsub_states()
                self._unsub_states = None
            self._subscribe()
            now = dt_util.utcnow()
            raw = self._compute_raw()
            if raw != self._raw:
                self._raw, self._raw_since = raw, now
        self._settle(dt_util.utcnow())

    @callback
    def async_stop(self) -> None:
        """Remove state listener and timer."""
        self._running = False
        self._unsubscribe()

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        """Listen for changes of the effective open/closed state."""
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    def _subscribe(self) -> None:
        if self.room.windows.entities:
            self._unsub_states = async_track_state_change_event(
                self.hass, self.room.windows.entities, self._async_state_changed
            )

    def _unsubscribe(self) -> None:
        if self._unsub_states:
            self._unsub_states()
            self._unsub_states = None
        self._cancel_timer()

    def _cancel_timer(self) -> None:
        if self._unsub_timer:
            self._unsub_timer()
            self._unsub_timer = None

    # ----------------------------------------------------------------- state

    @property
    def entity_states(self) -> dict[str, str | None]:
        """State of every window entity (None = entity does not exist)."""
        result: dict[str, str | None] = {}
        for entity_id in self.room.windows.entities:
            state = self.hass.states.get(entity_id)
            result[entity_id] = state.state if state else None
        return result

    @property
    def unavailable(self) -> list[str]:
        """Window entities that are unavailable, unknown or missing."""
        return [
            entity_id
            for entity_id, state in self.entity_states.items()
            if state is None or state in PROBLEM_STATES
        ]

    def _compute_raw(self) -> bool:
        for entity_id, state in self.entity_states.items():
            if state is None:
                self._known.pop(entity_id, None)  # removed/renamed: counts closed
            elif state not in PROBLEM_STATES:
                self._known[entity_id] = state in OPEN_STATES
        return any(
            self._known.get(entity_id, False)
            for entity_id in self.room.windows.entities
        )

    def _initial_since(self) -> datetime:
        """Since when the open entities are open (earliest ``last_changed``)."""
        times = [
            state.last_changed
            for entity_id in self.room.windows.entities
            if (state := self.hass.states.get(entity_id)) is not None
            and state.state in OPEN_STATES
        ]
        return min(times, default=dt_util.utcnow())

    # ------------------------------------------------------------ evaluation

    @callback
    def _async_state_changed(self, _event: Event) -> None:
        if self._running:
            self._evaluate(initial=False)

    @callback
    def _async_timer_fired(self, _now: datetime) -> None:
        self._unsub_timer = None
        if self._running and self._raw != self.is_open:
            self._set(self._raw)

    def _evaluate(self, *, initial: bool) -> None:
        now = dt_util.utcnow()
        if initial and self._restore(now):
            self._notify(changed=False)
            return
        raw = self._compute_raw()
        if initial:
            self._raw = raw
            self._raw_since = self._initial_since() if raw else now
        elif raw != self._raw:
            self._raw, self._raw_since = raw, now
        self._settle(now)

    def _restore(self, now: datetime) -> bool:
        """Core restart: reuse the persisted open state if a window is still open.

        Entities that are unavailable/unknown count as (last known) open, since the
        persisted state says a window was open.
        """
        stored = self.runtime.get("window") or {}
        since = dt_util.parse_datetime(stored.get("since") or "")
        if not stored.get("open") or since is None:
            return False
        for entity_id, state in self.entity_states.items():
            if state in PROBLEM_STATES:
                self._known[entity_id] = True
        if not self._compute_raw():
            self._known.clear()
            return False
        self._raw, self._raw_since = True, since
        self.is_open, self.open_since = True, since
        return True

    def _settle(self, now: datetime) -> None:
        """Compare raw and debounced state; set it or arm the delay timer."""
        self._cancel_timer()
        if self._raw != self.is_open:
            delay = (
                self.room.windows.open_delay
                if self._raw
                else self.room.windows.close_delay
            )
            due = self._raw_since + timedelta(seconds=delay)
            if due <= now:
                self._set(self._raw)
                return
            self._unsub_timer = async_call_later(
                self.hass, (due - now).total_seconds(), self._async_timer_fired
            )
        self._notify(changed=False)

    def _set(self, is_open: bool) -> None:
        self.is_open = is_open
        self.open_since = self._raw_since if is_open else None
        self.runtime["window"] = {
            "open": is_open,
            "since": self.open_since.isoformat() if self.open_since else None,
        }
        if self._on_runtime_changed:
            self._on_runtime_changed()
        self._notify(changed=True)

    def _notify(self, *, changed: bool) -> None:
        if self._on_update:
            self._on_update()
        if changed:
            for listener in list(self._listeners):
                listener()
