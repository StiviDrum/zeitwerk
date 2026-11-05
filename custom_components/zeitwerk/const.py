"""Constants for the Zeitwerk integration."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "zeitwerk"
NAME: Final = "Zeitwerk"

STORAGE_KEY: Final = "zeitwerk"
STORAGE_VERSION: Final = 1

CARD_FILENAME: Final = "zeitwerk-card.js"
CARD_URL_BASE: Final = "/zeitwerk_static"

SIGNAL_PLAN_STATUS: Final = "zeitwerk_plan_status_{}"

# A plan has 1 to MAX_PROFILES profiles.
MAX_PROFILES: Final = 5
