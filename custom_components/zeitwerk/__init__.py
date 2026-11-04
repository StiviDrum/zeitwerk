"""Zeitwerk – profile based weekly schedules for Home Assistant."""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType
from homeassistant.loader import async_get_integration

from .const import CARD_FILENAME, CARD_URL_BASE, DOMAIN
from .manager import ZeitwerkManager
from .services import async_setup_services
from .websocket_api import async_register_websocket

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

PLATFORMS = [Platform.BINARY_SENSOR, Platform.SENSOR, Platform.SWITCH]

type ZeitwerkConfigEntry = ConfigEntry[ZeitwerkManager]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register card, services and websocket API once per Home Assistant start."""
    async_setup_services(hass)
    async_register_websocket(hass)
    await _async_register_card(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ZeitwerkConfigEntry) -> bool:
    """Set up Zeitwerk from a config entry."""
    manager = ZeitwerkManager(hass, entry.entry_id)
    await manager.async_setup()
    entry.runtime_data = manager
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
    card_path = Path(__file__).parent / "frontend" / CARD_FILENAME
    if not await hass.async_add_executor_job(card_path.is_file):
        _LOGGER.warning(
            "Card bundle %s not found – build the frontend (npm run build)", card_path
        )
        return

    integration = await async_get_integration(hass, DOMAIN)
    url = f"{CARD_URL_BASE}/{CARD_FILENAME}"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(url, str(card_path), cache_headers=True)]
    )
    # Version query parameter busts the browser cache after updates.
    add_extra_js_url(hass, f"{url}?v={integration.version}")
