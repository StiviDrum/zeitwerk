"""Repair issues for plans that reference entities which do not exist."""

from __future__ import annotations

from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er, issue_registry as ir

from .const import DOMAIN
from .model import Plan

ISSUE_MISSING_ENTITIES = "missing_entities"


def _entity_ids(value: Any) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, str) and "." in v and "{" not in v]


def _walk(node: Any, found: set[str]) -> None:
    """Collect ``entity_id`` values (incl. ``target.entity_id``) recursively."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "entity_id":
                found.update(_entity_ids(value))
            else:
                _walk(value, found)
    elif isinstance(node, list):
        for item in node:
            _walk(item, found)


def plan_entity_refs(plan: Plan) -> set[str]:
    """All entity ids a plan refers to (targets, conditions, holiday source)."""
    found: set[str] = set()
    for profile in plan.profiles:
        _walk(profile.actions, found)
    _walk(plan.activation.conditions, found)
    for override in plan.overrides:
        _walk(override.conditions, found)
    if plan.holidays.enabled and plan.holidays.source:
        found.add(plan.holidays.source)
    return found


def issue_id(plan_id: str) -> str:
    """Repair issue id of a plan."""
    return f"{ISSUE_MISSING_ENTITIES}_{plan_id}"


@callback
def async_check_plan(hass: HomeAssistant, plan: Plan) -> list[str]:
    """Create or remove the repair issue of a plan; return missing entity ids."""
    registry = er.async_get(hass)
    missing = sorted(
        entity_id
        for entity_id in plan_entity_refs(plan)
        if hass.states.get(entity_id) is None and registry.async_get(entity_id) is None
    )
    if missing:
        ir.async_create_issue(
            hass,
            DOMAIN,
            issue_id(plan.id),
            is_fixable=False,
            is_persistent=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key=ISSUE_MISSING_ENTITIES,
            translation_placeholders={
                "plan": plan.name,
                "entities": ", ".join(missing),
            },
        )
    else:
        ir.async_delete_issue(hass, DOMAIN, issue_id(plan.id))
    return missing


@callback
def async_clear_plan(hass: HomeAssistant, plan_id: str) -> None:
    """Remove a deleted plan's repair issue."""
    ir.async_delete_issue(hass, DOMAIN, issue_id(plan_id))
