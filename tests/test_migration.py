"""Storage migration (1/2 -> 3) and cleanup of the dropped rooms feature."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from custom_components.zeitwerk.const import DOMAIN, STORAGE_KEY, STORAGE_VERSION

from .common import living_room_plan
from .ha_testing import MockConfigEntry
from .test_engine import setup_helpers


def _v2_data() -> dict[str, Any]:
    plan = living_room_plan()
    plan["room"] = "wohnzimmer"
    plan["room_reactions"] = {"window": "away"}
    other = living_room_plan(id="other", name="Other")
    return {
        "plans": [plan, other],
        "rooms": [
            {
                "id": "wohnzimmer",
                "name": "Wohnzimmer",
                "windows": {"entities": ["binary_sensor.w"]},
            }
        ],
        "runtime": {
            "wohnzimmer_heizung": {"last_applied": "comfort"},
            "room:wohnzimmer": {"open_since": "2026-11-01T10:00:00+00:00"},
        },
    }


async def _load(hass: HomeAssistant, hass_storage: dict[str, Any], version: int):
    hass_storage[STORAGE_KEY] = {
        "version": version,
        "minor_version": 1,
        "key": STORAGE_KEY,
        "data": _v2_data() if version == 2 else {"plans": _v2_data()["plans"][:1]},
    }
    await setup_helpers(hass)
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


async def test_migrate_v2_drops_rooms(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    assert STORAGE_VERSION == 3
    entry = await _load(hass, hass_storage, 2)
    manager = entry.runtime_data
    assert set(manager.plans) == {"wohnzimmer_heizung", "other"}
    assert "room:wohnzimmer" not in manager.runtime
    assert "last_applied" in manager.runtime["wohnzimmer_heizung"]
    assert await hass.config_entries.async_unload(entry.entry_id)
    saved = hass_storage[STORAGE_KEY]
    assert saved["version"] == 3
    assert "rooms" not in saved["data"]
    assert all(
        "room" not in p and "room_reactions" not in p for p in saved["data"]["plans"]
    )
    assert not any(k.startswith("room:") for k in saved["data"]["runtime"])


async def test_migrate_v1(hass: HomeAssistant, hass_storage: dict[str, Any]) -> None:
    entry = await _load(hass, hass_storage, 1)
    assert set(entry.runtime_data.plans) == {"wohnzimmer_heizung"}
    assert await hass.config_entries.async_unload(entry.entry_id)
    saved = hass_storage[STORAGE_KEY]
    assert saved["version"] == 3
    assert "rooms" not in saved["data"]


async def test_room_registry_leftovers_removed(
    hass: HomeAssistant, hass_storage: dict[str, Any]
) -> None:
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    room_dev = dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id, identifiers={(DOMAIN, "room:wohnzimmer")}
    )
    plan_dev = dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id, identifiers={(DOMAIN, "heizung")}
    )
    ent_reg.async_get_or_create(
        "binary_sensor",
        DOMAIN,
        "room:wohnzimmer_window",
        config_entry=entry,
        device_id=room_dev.id,
        suggested_object_id="zeitwerk_wohnzimmer_window",
    )
    # entity without a device but with a room unique id
    ent_reg.async_get_or_create(
        "binary_sensor",
        DOMAIN,
        "room:bad_window",
        config_entry=entry,
        suggested_object_id="zeitwerk_bad_window",
    )
    keep = ent_reg.async_get_or_create(
        "sensor",
        DOMAIN,
        "heizung_something",
        config_entry=entry,
        device_id=plan_dev.id,
    )
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert dev_reg.async_get(room_dev.id) is None
    assert dev_reg.async_get(plan_dev.id) is not None
    assert ent_reg.async_get("binary_sensor.zeitwerk_wohnzimmer_window") is None
    assert ent_reg.async_get("binary_sensor.zeitwerk_bad_window") is None
    assert ent_reg.async_get(keep.entity_id) is not None
