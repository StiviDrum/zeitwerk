"""Persistence of plans and runtime state (``.storage/zeitwerk``)."""

from __future__ import annotations

from collections.abc import Callable
import logging
from typing import Any, TypedDict

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION

_LOGGER = logging.getLogger(__name__)

_ROOM_PLAN_KEYS = ("room", "room_reactions")
SAVE_DELAY = 2  # seconds, debounced


class StoredData(TypedDict):
    """Top level storage layout."""

    plans: list[dict[str, Any]]
    # per plan: last_applied profile, forced profile/until (ISO)
    runtime: dict[str, dict[str, Any]]


class _VersionedStore(Store[StoredData]):
    """Store with a migration hook."""

    async def _async_migrate_func(
        self,
        old_major_version: int,
        old_minor_version: int,
        old_data: dict[str, Any],
    ) -> StoredData:
        """Migrate older storage versions.

        1 -> 3 and 2 -> 3: the short-lived rooms feature (schema 2) is gone; drop
        ``rooms``, the plans' ``room``/``room_reactions`` and ``room:*`` runtime.
        """
        _LOGGER.debug(
            "Migrating storage from %s.%s", old_major_version, old_minor_version
        )
        plans = []
        for raw in old_data.get("plans", []):
            if isinstance(raw, dict):
                raw = {k: v for k, v in raw.items() if k not in _ROOM_PLAN_KEYS}  # noqa: PLW2901
            plans.append(raw)
        return {
            "plans": plans,
            "runtime": {
                k: v
                for k, v in dict(old_data.get("runtime", {})).items()
                if not str(k).startswith("room:")
            },
        }


class ZeitwerkStore:
    """Load and (debounced) save Zeitwerk data."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialise the store."""
        self._store = _VersionedStore(
            hass, STORAGE_VERSION, STORAGE_KEY, minor_version=1
        )

    async def async_load(self) -> StoredData:
        """Load stored data (empty layout when nothing is stored)."""
        data = await self._store.async_load()
        if not data:
            return {"plans": [], "runtime": {}}
        data.setdefault("plans", [])
        data.setdefault("runtime", {})
        return data

    def async_schedule_save(self, data_func: Callable[[], StoredData]) -> None:
        """Save soon (debounced); also flushed on Home Assistant shutdown."""
        self._store.async_delay_save(data_func, SAVE_DELAY)

    async def async_save(self, data: StoredData) -> None:
        """Save immediately."""
        await self._store.async_save(data)
