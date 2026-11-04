"""Websocket API used by the card."""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from datetime import timedelta
import functools
from typing import Any

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.util import dt as dt_util

from .compat import vol
from .const import DOMAIN
from .engine import PlanRunner
from .manager import EVENT_REMOVED, PlanNotFoundError, ZeitwerkManager
from .model import Plan
from .schedule import preview

MAX_PREVIEW = timedelta(days=8)

type _Handler = Callable[
    [HomeAssistant, websocket_api.ActiveConnection, dict[str, Any], ZeitwerkManager],
    Coroutine[Any, Any, None],
]


def status_dict(runner: PlanRunner | None) -> dict[str, Any] | None:
    """Serialise a plan's runtime status."""
    if runner is None:
        return None
    s = runner.status
    return {
        "profile": s.profile,
        "source": s.source,
        "day_type": s.day_type,
        "is_holiday": s.is_holiday,
        "active": s.active,
        "activation_results": s.activation_results,
        "override_results": s.override_results,
        "next_change": s.next_change.isoformat() if s.next_change else None,
        "next_profile": s.next_profile,
        "forced_until": s.forced_until.isoformat() if s.forced_until else None,
        "manual_since": s.manual_since.isoformat() if s.manual_since else None,
        "manual_until": s.manual_until.isoformat() if s.manual_until else None,
        "manual_entity": s.manual_entity,
        "error": s.error,
    }


def _plan_payload(manager: ZeitwerkManager, plan: Plan) -> dict[str, Any]:
    return {**plan.to_dict(), "status": status_dict(manager.runners.get(plan.id))}


def _with_manager(func: _Handler) -> Callable[..., Coroutine[Any, Any, None]]:
    """Resolve the manager and turn errors into websocket errors."""

    @functools.wraps(func)
    async def wrapper(
        hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
    ) -> None:
        entries = hass.config_entries.async_loaded_entries(DOMAIN)
        if not entries:
            connection.send_error(msg["id"], "not_loaded", "Zeitwerk is not set up")
            return
        try:
            await func(hass, connection, msg, entries[0].runtime_data)
        except PlanNotFoundError as err:
            connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, str(err))
        except vol.Invalid as err:
            connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, str(err))
        except HomeAssistantError as err:
            connection.send_error(
                msg["id"], websocket_api.ERR_HOME_ASSISTANT_ERROR, str(err)
            )

    return wrapper


@websocket_api.websocket_command(
    {vol.Required("type"): "zeitwerk/plans/list", vol.Optional("tag"): cv.string}
)
@websocket_api.async_response
@_with_manager
async def ws_list(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    manager: ZeitwerkManager,
) -> None:
    """List plans, optionally filtered by tag."""
    tag = msg.get("tag")
    plans = [
        _plan_payload(manager, p)
        for p in manager.plans.values()
        if tag is None or tag in p.tags
    ]
    connection.send_result(msg["id"], {"plans": plans})


@websocket_api.websocket_command(
    {vol.Required("type"): "zeitwerk/plans/get", vol.Required("plan_id"): cv.string}
)
@websocket_api.async_response
@_with_manager
async def ws_get(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    manager: ZeitwerkManager,
) -> None:
    """Return one plan."""
    plan = manager.get_plan(msg["plan_id"])
    connection.send_result(msg["id"], _plan_payload(manager, plan))


@websocket_api.websocket_command(
    {vol.Required("type"): "zeitwerk/plans/create", vol.Required("plan"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
@_with_manager
async def ws_create(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    manager: ZeitwerkManager,
) -> None:
    """Create a plan (admin)."""
    plan = await manager.async_create_plan(msg["plan"])
    connection.send_result(msg["id"], _plan_payload(manager, plan))


@websocket_api.websocket_command(
    {
        vol.Required("type"): "zeitwerk/plans/update",
        vol.Required("plan_id"): cv.string,
        vol.Required("plan"): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
@_with_manager
async def ws_update(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    manager: ZeitwerkManager,
) -> None:
    """Replace a plan (admin)."""
    plan = await manager.async_update_plan(msg["plan_id"], msg["plan"])
    connection.send_result(msg["id"], _plan_payload(manager, plan))


@websocket_api.websocket_command(
    {vol.Required("type"): "zeitwerk/plans/delete", vol.Required("plan_id"): cv.string}
)
@websocket_api.require_admin
@websocket_api.async_response
@_with_manager
async def ws_delete(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    manager: ZeitwerkManager,
) -> None:
    """Delete a plan (admin)."""
    await manager.async_delete_plan(msg["plan_id"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): "zeitwerk/plans/subscribe",
        vol.Optional("plan_id"): cv.string,
    }
)
@websocket_api.async_response
@_with_manager
async def ws_subscribe(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    manager: ZeitwerkManager,
) -> None:
    """Send all (or one) plans now and on every change."""
    only = msg.get("plan_id")
    if only is not None:
        manager.get_plan(only)

    @callback
    def forward(event: str, plan_id: str) -> None:
        if only is not None and plan_id != only:
            return
        plan = manager.plans.get(plan_id)
        connection.send_message(
            websocket_api.event_message(
                msg["id"],
                {
                    "event": event,
                    "plan_id": plan_id,
                    "plan": None
                    if event == EVENT_REMOVED or plan is None
                    else _plan_payload(manager, plan),
                },
            )
        )

    connection.subscriptions[msg["id"]] = manager.async_add_listener(forward)
    connection.send_result(msg["id"])
    plans = [
        _plan_payload(manager, p)
        for p in manager.plans.values()
        if only is None or p.id == only
    ]
    connection.send_message(
        websocket_api.event_message(msg["id"], {"event": "init", "plans": plans})
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "zeitwerk/preview",
        vol.Optional("plan_ids"): [cv.string],
        vol.Optional("tag"): cv.string,
        vol.Optional("start"): cv.datetime,
        vol.Optional("end"): cv.datetime,
    }
)
@websocket_api.async_response
@_with_manager
async def ws_preview(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: dict[str, Any],
    manager: ZeitwerkManager,
) -> None:
    """Scheduled profile segments per plan (default: today)."""
    start = msg.get("start") or dt_util.start_of_local_day()
    end = msg.get("end") or start + timedelta(days=1)
    start, end = dt_util.as_utc(start), dt_util.as_utc(end)
    if not start < end <= start + MAX_PREVIEW:
        raise vol.Invalid("end must be after start and at most 8 days later")
    tz = dt_util.get_default_time_zone()
    plan_ids = msg.get("plan_ids") or list(manager.plans)
    result: dict[str, Any] = {}
    for plan_id in plan_ids:
        plan = manager.get_plan(plan_id)
        if "tag" in msg and msg["tag"] not in plan.tags:
            continue
        runner = manager.runners.get(plan_id)
        is_holiday = runner.is_holiday if runner else (lambda _d: False)
        result[plan_id] = [
            {
                "start": s.start.isoformat(),
                "end": s.end.isoformat(),
                "profile": s.profile,
            }
            for s in preview(plan, start, end, tz, is_holiday)
        ]
    connection.send_result(msg["id"], {"plans": result})


@callback
def async_register_websocket(hass: HomeAssistant) -> None:
    """Register all websocket commands."""
    for command in (
        ws_list,
        ws_get,
        ws_create,
        ws_update,
        ws_delete,
        ws_subscribe,
        ws_preview,
    ):
        websocket_api.async_register_command(hass, command)
