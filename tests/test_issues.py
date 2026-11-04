"""Repair issues for missing entity references."""

from __future__ import annotations

from freezegun.api import FrozenDateTimeFactory
from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er, issue_registry as ir

from custom_components.zeitwerk.const import DOMAIN
from custom_components.zeitwerk.issues import issue_id, plan_entity_refs
from custom_components.zeitwerk.model import Plan

from .common import living_room_plan
from .test_engine import WED, at, start

PLAN = "wohnzimmer_heizung"


def test_plan_entity_refs() -> None:
    data = living_room_plan(
        activation={
            "conditions": [
                {
                    "condition": "or",
                    "conditions": [
                        {
                            "condition": "state",
                            "entity_id": ["input_boolean.heizperiode"],
                            "state": "on",
                        },
                        {"condition": "template", "value_template": "{{ true }}"},
                    ],
                }
            ]
        },
        holidays={
            "source": "calendar.feiertage",
            "mode": "like_day",
            "like_day": "sun",
        },
    )
    refs = plan_entity_refs(Plan.from_dict(data))
    assert refs == {
        "input_number.temperaturspeicher_wohnzimmer",
        "input_boolean.urlaub",
        "input_boolean.person_1_home",
        "input_boolean.person_2_home",
        "input_boolean.heizperiode",
        "calendar.feiertage",
    }


async def test_issue_created_and_resolved(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    plan = living_room_plan()
    plan["overrides"][0]["conditions"][0]["entity_id"] = "input_boolean.gibt_es_nicht"
    _, manager = await start(hass, freezer, at(WED, 17, 40), **plan)
    issues = ir.async_get(hass)
    issue = issues.async_get_issue(DOMAIN, issue_id(PLAN))
    assert issue is not None
    assert issue.translation_key == "missing_entities"
    assert issue.translation_placeholders == {
        "plan": "Heizung Wohnzimmer",
        "entities": "input_boolean.gibt_es_nicht",
    }

    # entity appears in the registry -> issue resolved
    er.async_get(hass).async_get_or_create(
        "input_boolean", "test", "gibt_es_nicht", suggested_object_id="gibt_es_nicht"
    )
    await hass.async_block_till_done()
    assert issues.async_get_issue(DOMAIN, issue_id(PLAN)) is None

    await manager.async_delete_plan(PLAN)
    assert issues.async_get_issue(DOMAIN, issue_id(PLAN)) is None


async def test_no_issue_for_complete_plan(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory
) -> None:
    await start(hass, freezer, at(WED, 17, 40))
    assert ir.async_get(hass).async_get_issue(DOMAIN, issue_id(PLAN)) is None
