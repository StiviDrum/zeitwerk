"""The integration serves the card bundle and registers it with the frontend."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.core import HomeAssistant
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components import zeitwerk
from custom_components.zeitwerk.const import CARD_URL_BASE, DOMAIN


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
