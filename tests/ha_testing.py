"""Test helpers from whichever Home Assistant test package is installed.

Home Assistant 2026.11 ships the official ``pytest-homeassistant`` package;
older versions (down to the minimum in hacs.json) are tested with
``pytest-homeassistant-custom-component``. Only one of them is installed.
"""

from __future__ import annotations

try:
    from pytest_homeassistant.common import MockConfigEntry, async_fire_time_changed
    from pytest_homeassistant.typing import WebSocketGenerator
except ImportError:
    from pytest_homeassistant_custom_component.common import (  # type: ignore[no-redef]
        MockConfigEntry,
        async_fire_time_changed,
    )
    from pytest_homeassistant_custom_component.typing import (  # type: ignore[no-redef]
        WebSocketGenerator,
    )

__all__ = ["MockConfigEntry", "WebSocketGenerator", "async_fire_time_changed"]
