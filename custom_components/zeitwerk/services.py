"""Services for automations (plan editing happens via the websocket API)."""

from __future__ import annotations

from homeassistant.core import HomeAssistant, ServiceCall, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv

from .compat import vol
from .const import DOMAIN
from .engine import PlanRunner
from .manager import PlanNotFoundError, ZeitwerkManager

SERVICE_APPLY = "apply"
SERVICE_SET_PROFILE_VALUE = "set_profile_value"
SERVICE_SKIP_NEXT = "skip_next"
SERVICE_FORCE_PROFILE = "force_profile"
SERVICE_CLEAR_FORCE = "clear_force"

ATTR_PLAN = "plan"
ATTR_PROFILE = "profile"

_PLAN_SCHEMA = vol.Schema({vol.Required(ATTR_PLAN): cv.string})


def get_manager(hass: HomeAssistant) -> ZeitwerkManager:
    """Return the manager of the loaded config entry."""
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    if not entries:
        raise ServiceValidationError(
            translation_domain=DOMAIN, translation_key="not_loaded"
        )
    return entries[0].runtime_data


def _runner(hass: HomeAssistant, plan_id: str) -> PlanRunner:
    try:
        return get_manager(hass).get_runner(plan_id)
    except PlanNotFoundError as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="unknown_plan",
            translation_placeholders={"plan": plan_id},
        ) from err


@callback
def async_setup_services(hass: HomeAssistant) -> None:
    """Register Zeitwerk services."""

    async def apply(call: ServiceCall) -> None:
        await _runner(hass, call.data[ATTR_PLAN]).async_apply_current()

    async def set_profile_value(call: ServiceCall) -> None:
        _runner(hass, call.data[ATTR_PLAN])  # validates the plan id
        try:
            await get_manager(hass).async_set_profile_value(
                call.data[ATTR_PLAN],
                call.data[ATTR_PROFILE],
                call.data["value"],
                entity_id=call.data.get("entity_id"),
                key=call.data.get("key"),
            )
        except vol.Invalid as err:
            raise ServiceValidationError(str(err)) from err

    async def skip_next(call: ServiceCall) -> None:
        await _runner(hass, call.data[ATTR_PLAN]).async_skip_next()

    async def force_profile(call: ServiceCall) -> None:
        runner = _runner(hass, call.data[ATTR_PLAN])
        try:
            await runner.async_force_profile(
                call.data[ATTR_PROFILE], call.data.get("duration")
            )
        except HomeAssistantError as err:
            raise ServiceValidationError(str(err)) from err

    async def clear_force(call: ServiceCall) -> None:
        await _runner(hass, call.data[ATTR_PLAN]).async_clear_forced()

    hass.services.async_register(DOMAIN, SERVICE_APPLY, apply, _PLAN_SCHEMA)
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_PROFILE_VALUE,
        set_profile_value,
        _PLAN_SCHEMA.extend(
            {
                vol.Required(ATTR_PROFILE): cv.string,
                vol.Required("value"): vol.Any(
                    vol.Coerce(float), cv.boolean, cv.string
                ),
                vol.Optional("entity_id"): cv.entity_id,
                vol.Optional("key"): cv.string,
            }
        ),
    )
    hass.services.async_register(DOMAIN, SERVICE_SKIP_NEXT, skip_next, _PLAN_SCHEMA)
    hass.services.async_register(
        DOMAIN,
        SERVICE_FORCE_PROFILE,
        force_profile,
        _PLAN_SCHEMA.extend(
            {
                vol.Required(ATTR_PROFILE): cv.string,
                vol.Optional("duration"): cv.positive_time_period,
            }
        ),
    )
    hass.services.async_register(DOMAIN, SERVICE_CLEAR_FORCE, clear_force, _PLAN_SCHEMA)
