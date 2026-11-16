"""The integration serves the card bundle and registers it with the frontend."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.core import HomeAssistant
import pytest

from custom_components import zeitwerk
from custom_components.zeitwerk.const import CARD_URL_BASE, DOMAIN

from .ha_testing import MockConfigEntry


@pytest.fixture
def card_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    bundle = tmp_path / "zeitwerk-card.js"
    bundle.write_text("console.log('zeitwerk');")
    monkeypatch.setattr(zeitwerk, "CARD_PATH", bundle)
    return bundle


async def _setup(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_card_registered_and_served(
    hass: HomeAssistant, hass_client, card_bundle: Path
) -> None:
    await _setup(hass)
    urls = [
        u for u in hass.data[DATA_EXTRA_MODULE_URL].urls if u.startswith(CARD_URL_BASE)
    ]
    assert len(urls) == 1
    assert urls[0].startswith(f"{CARD_URL_BASE}/zeitwerk-card.js?v=")

    client = await hass_client()
    resp = await client.get(urls[0])
    assert resp.status == 200
    assert "zeitwerk" in await resp.text()


async def test_missing_bundle_only_warns(
    hass: HomeAssistant,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(zeitwerk, "CARD_PATH", tmp_path / "missing.js")
    await _setup(hass)
    assert "Card bundle" in caplog.text
    assert not any(
        u.startswith(CARD_URL_BASE) for u in hass.data[DATA_EXTRA_MODULE_URL].urls
    )


@pytest.fixture
def panel_bundle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    bundle = tmp_path / "zeitwerk-panel.js"
    bundle.write_text("console.log('panel');")
    monkeypatch.setattr(zeitwerk, "PANEL_PATH", bundle)
    return bundle


async def test_panel_registered_reloaded_and_removed(
    hass: HomeAssistant, hass_client, card_bundle: Path, panel_bundle: Path
) -> None:
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    panel = hass.data[frontend.DATA_PANELS]["zeitwerk"]
    assert panel.require_admin is True
    assert panel.sidebar_title == "Zeitwerk"
    assert panel.sidebar_icon == "mdi:calendar-clock"
    module_url = panel.config["_panel_custom"]["module_url"]
    assert module_url.startswith(f"{CARD_URL_BASE}/zeitwerk-panel.js?v=")
    assert panel.config["_panel_custom"]["name"] == "zeitwerk-panel"

    resp = await (await hass_client()).get(module_url)
    assert resp.status == 200

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert not frontend.async_panel_exists(hass, "zeitwerk")

    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert frontend.async_panel_exists(hass, "zeitwerk")


async def test_missing_panel_bundle_no_panel(
    hass: HomeAssistant,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(zeitwerk, "PANEL_PATH", tmp_path / "missing.js")
    await _setup(hass)
    assert "Panel bundle" in caplog.text
    assert not frontend.async_panel_exists(hass, "zeitwerk")
