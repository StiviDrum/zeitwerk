"""Zeitwerk – profile based weekly schedules for Home Assistant."""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import (
    CARD_FILENAME,
    CARD_URL_BASE,
    DATA_PANEL_MODULE_URL,
    DOMAIN,
    PANEL_ELEMENT,
    PANEL_FILENAME,
    PANEL_URL_PATH,
)
from .manager import ZeitwerkManager
from .services import async_setup_services
from .websocket_api import async_register_websocket

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

CARD_PATH = Path(__file__).parent / "frontend" / CARD_FILENAME
PANEL_PATH = Path(__file__).parent / "frontend" / PANEL_FILENAME

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR, Platform.SWITCH]

type ZeitwerkConfigEntry = ConfigEntry[ZeitwerkManager]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register card, services and websocket API once per Home Assistant start."""
    async_setup_services(hass)
    async_register_websocket(hass)
    await _async_register_card(hass)
    await _async_serve_panel(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ZeitwerkConfigEntry) -> bool:
    """Set up Zeitwerk from a config entry."""
    manager = ZeitwerkManager(hass, entry.entry_id)
    await manager.async_setup()
    entry.runtime_data = manager
    await _async_register_panel(hass, entry)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ZeitwerkConfigEntry) -> bool:
    """Unload a config entry."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        await entry.runtime_data.async_unload()
    return unloaded


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the card JS and add it to the frontend (no manual resource needed)."""
    card_path = CARD_PATH

    def _bundle_hash() -> str | None:
        if not card_path.is_file():
            return None
        return hashlib.sha256(card_path.read_bytes()).hexdigest()[:12]

    digest = await hass.async_add_executor_job(_bundle_hash)
    if digest is None:
        _LOGGER.warning(
            "Card bundle %s not found – build the frontend (npm run build)", card_path
        )
        return

    url = f"{CARD_URL_BASE}/{CARD_FILENAME}"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(url, str(card_path), cache_headers=True)]
    )
    # Content hash busts the browser cache after updates and dev rebuilds.
    add_extra_js_url(hass, f"{url}?v={digest}")


async def _async_serve_panel(hass: HomeAssistant) -> None:
    """Serve the sidebar panel bundle (once; static paths cannot be re-added)."""
    panel_path = PANEL_PATH

    def _bundle_hash() -> str | None:
        if not panel_path.is_file():
            return None
        return hashlib.sha256(panel_path.read_bytes()).hexdigest()[:12]

    digest = await hass.async_add_executor_job(_bundle_hash)
    if digest is None:
        _LOGGER.warning(
            "Panel bundle %s not found – build the frontend (npm run build)",
            panel_path,
        )
        return
    url = f"{CARD_URL_BASE}/{PANEL_FILENAME}"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(url, str(panel_path), cache_headers=True)]
    )
    hass.data[DATA_PANEL_MODULE_URL] = f"{url}?v={digest}"


async def _async_register_panel(
    hass: HomeAssistant, entry: ZeitwerkConfigEntry
) -> None:
    """Add the admin-only sidebar panel; removed again on unload."""
    if (module_url := hass.data.get(DATA_PANEL_MODULE_URL)) is None:
        return
    if frontend.async_panel_exists(hass, PANEL_URL_PATH):
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title="Zeitwerk",
        sidebar_icon="mdi:calendar-clock",
        module_url=module_url,
        require_admin=True,
        embed_iframe=False,
    )
    entry.async_on_unload(
        lambda: frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    )
