"""Execution of profile actions via Home Assistant's script helper."""

from __future__ import annotations

from collections import deque
import logging
from typing import Any

from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import config_validation as cv, script as script_helper
from homeassistant.helpers.script import Script

from .const import DOMAIN
from .model import Plan, Profile

_LOGGER = logging.getLogger(__name__)

# Remember recent contexts so manual changes can be told apart (0.3).
_CONTEXT_HISTORY = 50


class ProfileExecutor:
    """Compiled scripts of one plan's profiles."""

    def __init__(self, hass: HomeAssistant, plan: Plan) -> None:
        """Initialise the executor."""
        self.hass = hass
        self.plan = plan
        self._scripts: dict[str, Script] = {}
        self.contexts: deque[str] = deque(maxlen=_CONTEXT_HISTORY)

    async def async_setup(self) -> None:
        """Validate and compile all profile action sequences."""
        for profile in self.plan.profiles:
            self._scripts[profile.id] = await self._async_compile(profile)

    async def _async_compile(self, profile: Profile) -> Script:
        sequence: list[
            dict[str, Any]
        ] = await script_helper.async_validate_actions_config(
            self.hass, cv.SCRIPT_SCHEMA(profile.actions)
        )
        return Script(
            self.hass,
            sequence,
            f"{self.plan.name}: {profile.name}",
            DOMAIN,
            script_mode=script_helper.SCRIPT_MODE_RESTART,
            logger=_LOGGER,
        )

    def is_own_context(self, context: Context | None) -> bool:
        """Whether a state change was caused by this executor."""
        return context is not None and (
            context.id in self.contexts or context.parent_id in self.contexts
        )

    def async_run(self, profile_id: str) -> Context | None:
        """Start the profile's actions in the background; return their context."""
        script = self._scripts.get(profile_id)
        if script is None:
            _LOGGER.warning("Plan %s: unknown profile %s", self.plan.id, profile_id)
            return None
        context = Context()
        self.contexts.append(context.id)
        _LOGGER.debug("Plan %s: applying profile %s", self.plan.id, profile_id)
        self.hass.async_create_task(
            script.async_run(context=context),
            f"zeitwerk {self.plan.id} apply {profile_id}",
            eager_start=True,
        )
        return context

    async def async_unload(self) -> None:
        """Stop running scripts and release resources."""
        for script in self._scripts.values():
            unload = getattr(script, "async_unload", None)
            if unload is not None:
                await unload()
            else:  # pragma: no cover - older HA
                await script.async_stop()
        self._scripts.clear()
