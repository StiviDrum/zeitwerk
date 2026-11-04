"""Compatibility shims across supported Home Assistant versions."""

from __future__ import annotations

# Home Assistant 2026.10 replaced voluptuous with the API compatible "probatio".
# Older versions (>= the minimum in hacs.json) still ship voluptuous.
try:
    import probatio as vol
except ImportError:  # pragma: no cover - depends on installed HA version
    import voluptuous as vol  # type: ignore[no-redef]

__all__ = ["vol"]
