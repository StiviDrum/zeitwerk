"""Test helpers: reference plans from SPEC §9."""

from __future__ import annotations

import copy
from typing import Any

_LIVING_ROOM: dict[str, Any] = {
    "id": "wohnzimmer_heizung",
    "name": "Heizung Wohnzimmer",
    "icon": "mdi:radiator",
    "tags": ["heizung"],
    "profiles": [
        {
            "id": "comfort",
            "name": "Komfort",
            "color": "#ff8b4a",
            "actions": [
                {
                    "action": "input_number.set_value",
                    "target": {
                        "entity_id": "input_number.temperaturspeicher_wohnzimmer"
                    },
                    "data": {"value": 22},
                }
            ],
        },
        {
            "id": "eco",
            "name": "Absenkung",
            "color": "#6fa8ff",
            "actions": [
                {
                    "action": "input_number.set_value",
                    "target": {
                        "entity_id": "input_number.temperaturspeicher_wohnzimmer"
                    },
                    "data": {"value": 18},
                }
            ],
        },
        {
            "id": "away",
            "name": "Abwesend",
            "color": "#aeaeb8",
            "actions": [
                {
                    "action": "input_number.set_value",
                    "target": {
                        "entity_id": "input_number.temperaturspeicher_wohnzimmer"
                    },
                    "data": {"value": 16},
                }
            ],
        },
    ],
    "default_profile": "eco",
    "week": {
        "day_types": [
            {
                "id": "workday",
                "name": "Werktag",
                "days": ["mon", "tue", "wed", "thu", "fri"],
                "blocks": [{"start": "16:00", "end": "22:00", "profile": "comfort"}],
            },
            {
                "id": "weekend",
                "name": "Wochenende",
                "days": ["sat", "sun"],
                "blocks": [{"start": "09:00", "end": "22:00", "profile": "comfort"}],
            },
        ]
    },
    "overrides": [
        {
            "id": "vacation",
            "name": "Urlaub",
            "profile": "away",
            "conditions": [
                {
                    "condition": "state",
                    "entity_id": "input_boolean.urlaub",
                    "state": "on",
                }
            ],
        },
        {
            "id": "nobody_home",
            "name": "Niemand zu Hause",
            "profile": "away",
            "match": "all",
            "conditions": [
                {
                    "condition": "state",
                    "entity_id": "input_boolean.person_1_home",
                    "state": "off",
                },
                {
                    "condition": "state",
                    "entity_id": "input_boolean.person_2_home",
                    "state": "off",
                },
            ],
        },
    ],
}


def living_room_plan(**changes: Any) -> dict[str, Any]:
    """Return a fresh copy of the living room reference plan with changes."""
    plan = copy.deepcopy(_LIVING_ROOM)
    plan.update(changes)
    return plan
