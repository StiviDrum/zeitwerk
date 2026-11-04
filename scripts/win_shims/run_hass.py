"""Start Home Assistant on native Windows for local development only.

Home Assistant refuses to start on Windows (no WSL). For the Zeitwerk dev
instance we skip that check; everything else is unchanged. Never use this for
a real installation.
"""

import sys

import homeassistant.__main__ as ha_main
from homeassistant.helpers import signal as ha_signal

ha_main.validate_os = lambda: None
# asyncio on Windows has no add_signal_handler; stop with Ctrl+C instead.
ha_signal.async_register_signal_handling = lambda hass: None

if __name__ == "__main__":
    sys.exit(ha_main.main())
