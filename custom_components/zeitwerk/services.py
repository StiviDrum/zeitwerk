"""Services: run-time control for automations and full plan editing.

Everything the card can do is also available as a service, so automations
and assistants (e.g. Claude via an MCP connection) can operate Zeitwerk.
Editing services require an admin user (calls without a user, e.g. from
automations, are allowed).
"""

from __future__ import annotations

import copy
from typing import Any

from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
    callback,
)
from homeassistant.exceptions import (
    HomeAssistantError,
    ServiceValidationError,
    Unauthorized,
)
from homeassistant.helpers import config_validation as cv

from .compat import vol
from .const import DOMAIN
from .days import DAY_KEYS, apply_day_plan, week_to_days
from .engine import PlanRunner
from .manager import PlanNotFoundError, ZeitwerkManager
from .model import MATCH_ALL, MATCH_ANY
from .schema import make_plan_id
from .websocket_api import status_dict

SERVICE_APPLY = "apply"
SERVICE_SET_PROFILE_VALUE = "set_profile_value"
SERVICE_SKIP_NEXT = "skip_next"
SERVICE_FORCE_PROFILE = "force_profile"
SERVICE_CLEAR_FORCE = "clear_force"
SERVICE_GET_PLAN = "get_plan"
SERVICE_SET_DAY_PLAN = "set_day_plan"
SERVICE_SET_OVERRIDE = "set_override"
SERVICE_REMOVE_OVERRIDE = "remove_override"
SERVICE_UPDATE_PLAN = "update_plan"
SERVICE_CREATE_PLAN = "create_plan"
SERVICE_DELETE_PLAN = "delete_plan"

# Top-level plan keys update_plan may replace; dict values are merged.
UPDATABLE_KEYS = (
    "name",
    "icon",
    "tags",
    "enabled",
    "profiles",
    "default_profile",
    "activation",
    "holidays",
    "options",
)
_MERGED_KEYS = ("activation", "holidays", "options")

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


def _plan(manager: ZeitwerkManager, plan_id: str) -> dict[str, Any]:
    try:
        return copy.deepcopy(manager.get_plan(plan_id).to_dict())
    except PlanNotFoundError as err:
        raise ServiceValidationError(
            translation_domain=DOMAIN,
            translation_key="unknown_plan",
            translation_placeholders={"plan": plan_id},
        ) from err


async def _require_admin(hass: HomeAssistant, call: ServiceCall) -> None:
    """Editing needs an admin; calls without a user (automations) are allowed."""
    if call.context.user_id is None:
        return
    user = await hass.auth.async_get_user(call.context.user_id)
    if user is None or not user.is_admin:
        raise Unauthorized(context=call.context)


def plan_overview(manager: ZeitwerkManager, plan_id: str) -> dict[str, Any]:
    """Plan dict plus per-weekday blocks and runtime status (get_plan)."""
    data = manager.get_plan(plan_id).to_dict()
    return {
        **data,
        "days": week_to_days(data),
        "status": status_dict(manager.runners.get(plan_id)),
    }


async def _save(manager: ZeitwerkManager, plan_id: str, data: dict[str, Any]) -> None:
    try:
        await manager.async_update_plan(plan_id, data)
    except (vol.Invalid, ValueError, HomeAssistantError) as err:
        raise ServiceValidationError(str(err)) from err


_BLOCK = vol.Schema(
    {
        vol.Required("start"): cv.string,
        vol.Required("end"): cv.string,
        vol.Required("profile"): cv.string,
    }
)


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

    # ------------------------------------------------------------ read

    async def get_plan(call: ServiceCall) -> ServiceResponse:
        manager = get_manager(hass)
        plan_id = call.data.get(ATTR_PLAN)
        ids = [plan_id] if plan_id else list(manager.plans)
        for pid in ids:
            _plan(manager, pid)  # validates the id
        return {"plans": [plan_overview(manager, pid) for pid in ids]}

    # ------------------------------------------------------------ edit

    async def set_day_plan(call: ServiceCall) -> None:
        await _require_admin(hass, call)
        manager = get_manager(hass)
        data = _plan(manager, call.data[ATTR_PLAN])
        try:
            data = apply_day_plan(
                data, call.data["days"], call.data["blocks"], hass.config.language
            )
        except (ValueError, KeyError) as err:
            raise ServiceValidationError(str(err)) from err
        await _save(manager, call.data[ATTR_PLAN], data)

    async def set_override(call: ServiceCall) -> None:
        await _require_admin(hass, call)
        manager = get_manager(hass)
        data = _plan(manager, call.data[ATTR_PLAN])
        overrides: list[dict[str, Any]] = data["overrides"]
        override_id = call.data.get("override_id")
        index = next(
            (i for i, o in enumerate(overrides) if o["id"] == override_id), None
        )
        if index is None:
            for key in ("name", "profile", "conditions"):
                if key not in call.data:
                    raise ServiceValidationError(
                        f"'{key}' is required for a new override"
                    )
            new_id = override_id or make_plan_id(
                call.data["name"], {o["id"] for o in overrides}
            )
            override: dict[str, Any] = {"id": new_id, "match": MATCH_ALL}
            overrides.append(override)
            index = len(overrides) - 1
        else:
            override = overrides[index]
        for key in ("name", "profile", "match", "conditions"):
            if key in call.data:
                override[key] = call.data[key]
        if "position" in call.data:
            overrides.pop(index)
            overrides.insert(min(call.data["position"], len(overrides)), override)
        await _save(manager, call.data[ATTR_PLAN], data)

    async def remove_override(call: ServiceCall) -> None:
        await _require_admin(hass, call)
        manager = get_manager(hass)
        data = _plan(manager, call.data[ATTR_PLAN])
        before = len(data["overrides"])
        data["overrides"] = [
            o for o in data["overrides"] if o["id"] != call.data["override_id"]
        ]
        if len(data["overrides"]) == before:
            raise ServiceValidationError(
                f"plan '{call.data[ATTR_PLAN]}' has no override "
                f"'{call.data['override_id']}'"
            )
        await _save(manager, call.data[ATTR_PLAN], data)

    async def update_plan(call: ServiceCall) -> None:
        await _require_admin(hass, call)
        manager = get_manager(hass)
        data = _plan(manager, call.data[ATTR_PLAN])
        for key in UPDATABLE_KEYS:
            if key not in call.data:
                continue
            value = call.data[key]
            if key in _MERGED_KEYS and isinstance(value, dict):
                data[key] = {**(data.get(key) or {}), **value}
            else:
                data[key] = value
        await _save(manager, call.data[ATTR_PLAN], data)

    async def create_plan(call: ServiceCall) -> ServiceResponse:
        await _require_admin(hass, call)
        manager = get_manager(hass)
        try:
            plan = await manager.async_create_plan(dict(call.data["plan"]))
        except (vol.Invalid, ValueError, HomeAssistantError) as err:
            raise ServiceValidationError(str(err)) from err
        return {"plan_id": plan.id}

    async def delete_plan(call: ServiceCall) -> None:
        await _require_admin(hass, call)
        manager = get_manager(hass)
        _plan(manager, call.data[ATTR_PLAN])
        await manager.async_delete_plan(call.data[ATTR_PLAN])

    hass.services.async_register(
        DOMAIN,
        SERVICE_GET_PLAN,
        get_plan,
        vol.Schema({vol.Optional(ATTR_PLAN): cv.string}),
        supports_response=SupportsResponse.ONLY,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_DAY_PLAN,
        set_day_plan,
        _PLAN_SCHEMA.extend(
            {
                vol.Required("days"): vol.All(
                    cv.ensure_list, [vol.In(DAY_KEYS)], vol.Length(min=1)
                ),
                vol.Required("blocks"): vol.All(cv.ensure_list, [_BLOCK]),
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_OVERRIDE,
        set_override,
        _PLAN_SCHEMA.extend(
            {
                vol.Optional("override_id"): cv.string,
                vol.Optional("name"): cv.string,
                vol.Optional(ATTR_PROFILE): cv.string,
                vol.Optional("match"): vol.In((MATCH_ALL, MATCH_ANY)),
                vol.Optional("conditions"): vol.All(cv.ensure_list, [dict]),
                vol.Optional("position"): vol.All(vol.Coerce(int), vol.Range(min=0)),
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_REMOVE_OVERRIDE,
        remove_override,
        _PLAN_SCHEMA.extend({vol.Required("override_id"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_UPDATE_PLAN,
        update_plan,
        _PLAN_SCHEMA.extend(
            {
                vol.Optional("name"): cv.string,
                vol.Optional("icon"): vol.Any(None, cv.string),
                vol.Optional("tags"): vol.All(cv.ensure_list, [cv.string]),
                vol.Optional("enabled"): cv.boolean,
                vol.Optional("profiles"): vol.All(cv.ensure_list, [dict]),
                vol.Optional("default_profile"): cv.string,
                vol.Optional("activation"): dict,
                vol.Optional("holidays"): dict,
                vol.Optional("options"): dict,
            }
        ),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_CREATE_PLAN,
        create_plan,
        vol.Schema({vol.Required("plan"): dict}),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(DOMAIN, SERVICE_DELETE_PLAN, delete_plan, _PLAN_SCHEMA)

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
