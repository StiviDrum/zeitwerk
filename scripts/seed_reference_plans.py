"""Create the heating reference plans (docs/SPEC.md section 9) in a dev instance.

Usage:
    python scripts/seed_reference_plans.py --token <long-lived token>
        [--url http://localhost:8123] [--holiday-source calendar.deutschland_he]

Only meant for the local dev instance (helpers from config/configuration.yaml).
Existing plans with the same id are replaced.
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
from typing import Any

import aiohttp

ROOMS = {
    "wohnzimmer": "Wohnzimmer",
    "schlafzimmer": "Schlafzimmer",
    "bad": "Bad",
    "kueche": "Küche",
    "buero": "Büro",
}

PROFILES = [
    ("comfort", "Komfort", "#ff8b4a", "mdi:sun-thermometer-outline", 22),
    ("eco", "Absenkung", "#6fa8ff", "mdi:weather-night", 18),
    ("away", "Abwesend", "#aeaeb8", "mdi:home-export-outline", 16),
    ("vacation", "Urlaub", "#c3a6ff", "mdi:airplane", 16),
]

WORKDAYS = ["mon", "tue", "wed", "thu", "fri"]
WEEKEND = ["sat", "sun"]
ALL_DAYS = WORKDAYS + WEEKEND


def _block(start: str, end: str) -> dict[str, str]:
    return {"start": start, "end": end, "profile": "comfort"}


def _week(room: str) -> list[dict[str, Any]]:
    if room == "wohnzimmer":
        return [
            {
                "id": "workday",
                "name": "Werktag",
                "days": WORKDAYS,
                "blocks": [_block("16:00", "22:00")],
            },
            {
                "id": "weekend",
                "name": "Wochenende",
                "days": WEEKEND,
                "blocks": [_block("09:00", "22:00")],
            },
        ]
    if room == "bad":
        return [
            {
                "id": "daily",
                "name": "Täglich",
                "days": ALL_DAYS,
                "blocks": [_block("06:00", "08:00"), _block("18:00", "21:00")],
            }
        ]
    return [{"id": "daily", "name": "Täglich", "days": ALL_DAYS, "blocks": []}]


def build_plan(room: str, name: str, holiday_source: str | None) -> dict[str, Any]:
    """Return the plan dict for one room."""
    target = {"entity_id": f"input_number.temperaturspeicher_{room}"}
    plan: dict[str, Any] = {
        "id": f"heizung_{room}",
        "name": f"Heizung {name}",
        "icon": "mdi:radiator",
        "tags": ["heizung"],
        "profiles": [
            {
                "id": pid,
                "name": pname,
                "color": color,
                "icon": icon,
                "actions": [
                    {
                        "action": "input_number.set_value",
                        "target": target,
                        "data": {"value": value},
                    }
                ],
            }
            for pid, pname, color, icon, value in PROFILES
        ],
        "default_profile": "eco",
        "activation": {
            "match": "all",
            "conditions": [
                {
                    "condition": "state",
                    "entity_id": "input_boolean.heizperiode",
                    "state": "on",
                }
            ],
            "when_inactive": "none",
            "reevaluate": True,
        },
        "week": {"day_types": _week(room)},
        "overrides": [
            {
                "id": "vacation",
                "name": "Urlaub",
                "profile": "vacation",
                "match": "all",
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
                        "entity_id": f"input_boolean.person_{n}_home",
                        "state": "off",
                    }
                    for n in (1, 2)
                ],
            },
        ],
    }
    if room == "wohnzimmer" and holiday_source:
        plan["holidays"] = {
            "source": holiday_source,
            "mode": "like_day",
            "like_day": "sun",
        }
    return plan


async def main() -> None:
    """Connect, replace and create the reference plans."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8123")
    parser.add_argument("--token", required=True)
    parser.add_argument("--holiday-source")
    args = parser.parse_args()

    counter = itertools.count(1)
    async with (
        aiohttp.ClientSession() as session,
        session.ws_connect(f"{args.url}/api/websocket") as ws,
    ):
        await ws.receive_json()  # auth_required
        await ws.send_json({"type": "auth", "access_token": args.token})
        if (await ws.receive_json())["type"] != "auth_ok":
            raise SystemExit("Authentication failed")

        async def command(payload: dict[str, Any]) -> dict[str, Any]:
            msg_id = next(counter)
            await ws.send_json({"id": msg_id, **payload})
            while True:
                msg = await ws.receive_json()
                if msg.get("id") == msg_id and msg.get("type") == "result":
                    return msg

        existing = await command({"type": "zeitwerk/plans/list"})
        if not existing["success"]:
            raise SystemExit(f"Zeitwerk not available: {existing['error']}")
        existing_ids = {p["id"] for p in existing["result"]["plans"]}
        for room, name in ROOMS.items():
            plan = build_plan(room, name, args.holiday_source)
            if plan["id"] in existing_ids:
                result = await command(
                    {
                        "type": "zeitwerk/plans/update",
                        "plan_id": plan["id"],
                        "plan": plan,
                    }
                )
            else:
                result = await command({"type": "zeitwerk/plans/create", "plan": plan})
            if not result["success"]:
                raise SystemExit(f"{plan['id']}: {result['error']['message']}")
            status = result["result"]["status"] or {}
            print(f"{plan['id']}: {status.get('profile')} ({status.get('source')})")


if __name__ == "__main__":
    asyncio.run(main())
