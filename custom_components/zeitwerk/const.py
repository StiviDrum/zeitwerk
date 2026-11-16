"""Constants for the Zeitwerk integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "zeitwerk"
NAME: Final = "Zeitwerk"

STORAGE_KEY: Final = "zeitwerk"
STORAGE_VERSION: Final = 2

CARD_FILENAME: Final = "zeitwerk-card.js"
CARD_URL_BASE: Final = "/zeitwerk_static"

PANEL_FILENAME: Final = "zeitwerk-panel.js"
PANEL_URL_PATH: Final = "zeitwerk"
PANEL_ELEMENT: Final = "zeitwerk-panel"
DATA_PANEL_MODULE_URL: Final = "zeitwerk_panel_module_url"

SIGNAL_PLAN_STATUS: Final = "zeitwerk_plan_status_{}"
SIGNAL_ROOM_STATUS: Final = "zeitwerk_room_status_{}"

# A plan has 1 to MAX_PROFILES profiles.
MAX_PROFILES: Final = 5
