import json
from collections.abc import Callable
from typing import Any

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_mqtt_message

from custom_components.outglow.const import CONF_BASE_TOPIC, DOMAIN
from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine.types import Label

BASE = "zigbee2mqtt"
T0 = 1_800_000_000.0
BULBS = {
    "0x0000000000000001": "Test/Living 1",
    "0x0000000000000002": "Living 2",
    "0x0000000000000003": "Hall",
    "0x0000000000000004": "Office",
}
OTHER = "0x00000000000000aa"


class Clock:
    def __init__(self, t: float = T0) -> None:
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> float:
        self.t += seconds
        return self.t


def device(ieee: str, name: str, model: str = "outglow-tw", sensing: bool = True) -> dict[str, Any]:
    exposes: list[dict[str, Any]] = [{"type": "light", "features": [{"name": "state", "property": "state"}]}]
    if sensing:
        exposes.append({"type": "list", "name": "motion_links", "property": "motion_links"})
    return {
        "ieee_address": ieee,
        "friendly_name": name,
        "type": "Router",
        "model_id": model,
        "definition": {"model": model, "vendor": "Outglow", "exposes": exposes},
    }


def devices_payload(sensing: bool = True) -> list[dict[str, Any]]:
    out = [{"ieee_address": "0x00000000000000ff", "friendly_name": "Coordinator", "type": "Coordinator"}]
    out += [device(ieee, name, sensing=sensing) for ieee, name in BULBS.items()]
    out.append(device(OTHER, "Plug", model="TS011F", sensing=False))
    return out


def info_payload(output: str = "json", rate: int | None = 2) -> dict[str, Any]:
    options = {ieee: {"friendly_name": name, "motion_activity_rate": rate} for ieee, name in BULBS.items()}
    return {"version": "2.9.1", "config": {"advanced": {"output": output}, "devices": options}}


def links(rx: str, activity: int = 10, motion: bool = False, signal: int = -70) -> list[dict[str, Any]]:
    return [
        {
            "address": f"0x{i:04x}",
            "ieee_address": tx,
            "signal": signal,
            "noise": 0.5,
            "activity": activity,
            "motion": motion,
            "slot": i,
            "sensitivity": 40,
            "calibrated_sensitivity": 40,
        }
        for i, tx in enumerate(sorted(BULBS))
        if tx != rx
    ]


def bulb_state(rx: str, activity: int = 10, motion: bool = False, state: str = "ON") -> dict[str, Any]:
    return {
        "state": state,
        "brightness": 120,
        "color_temp": 300,
        "linkquality": 120,
        "motion_sensing": "ON",
        "motion_probes": 5,
        "motion_sensitivity": 40,
        "motion_auto_calibration": False,
        "motion_self_tuning": False,
        "motion_calibration_left": 0,
        "occupancy": motion,
        "room_occupancy": motion,
        "motion_links": links(rx, activity, motion),
    }


def plan_json(rev: int = 0) -> dict[str, Any]:
    return {
        "version": 1,
        "rev": rev,
        "floor_id": None,
        "north_deg": 0.0,
        "view_rotation_deg": 0.0,
        "background": None,
        "rooms": [
            {
                "id": "living",
                "name": "Living room",
                "outline": [[0, 0], [5, 0], [5, 4], [0, 4]],
                "colour": "#4e9af1",
                "area_id": None,
                "entrance": False,
            },
            {
                "id": "hall",
                "name": "Hall",
                "outline": [[5, 0], [7, 0], [7, 6], [5, 6]],
                "colour": "#f28b30",
                "area_id": None,
                "entrance": True,
            },
            {
                "id": "office",
                "name": "Office",
                "outline": [[2, 4], [5, 4], [5, 7], [2, 7]],
                "colour": "#42b883",
                "area_id": None,
                "entrance": False,
            },
        ],
        "walls": [],
        "doors": [],
        "adjacent": [["living", "hall"], ["hall", "office"]],
        "bulbs": [
            {"ieee": "0x0000000000000001", "x": 1.5, "y": 1.5, "height": "ceiling", "room": None},
            {"ieee": "0x0000000000000002", "x": 3.8, "y": 2.5, "height": "ceiling", "room": None},
            {"ieee": "0x0000000000000003", "x": 6.0, "y": 3.0, "height": "ceiling", "room": None},
            {"ieee": "0x0000000000000004", "x": 3.5, "y": 5.5, "height": "ceiling", "room": None},
        ],
        "excluded_directions": [],
    }


async def setup_outglow(hass: HomeAssistant, clock: Clock | None = None) -> tuple[MockConfigEntry, OutglowCoordinator]:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: BASE}, unique_id=BASE)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    coordinator: OutglowCoordinator = entry.runtime_data
    if clock is not None:
        coordinator.clock = clock
    return entry, coordinator


def fire(hass: HomeAssistant, topic: str, payload: object) -> None:
    text = payload if isinstance(payload, str) else json.dumps(payload)
    async_fire_mqtt_message(hass, f"{BASE}/{topic}", text)


async def bridge(hass: HomeAssistant, sensing: bool = True, output: str = "json", rate: int | None = 2) -> None:
    fire(hass, "bridge/info", info_payload(output, rate))
    fire(hass, "bridge/devices", devices_payload(sensing))
    fire(hass, "bridge/state", {"state": "online"})
    await hass.async_block_till_done()


async def with_plan(hass: HomeAssistant, coordinator: OutglowCoordinator) -> None:
    from custom_components.outglow.engine import from_json
    from custom_components.outglow.engine.types import Plan

    await coordinator.async_save_plan(coordinator.plan.rev, from_json(Plan, plan_json(coordinator.plan.rev)))
    await hass.async_block_till_done()


Sender = Callable[..., Any]


async def pending_labels(hass: HomeAssistant, coordinator: OutglowCoordinator) -> list[Label]:
    await coordinator.async_flush_history()
    labels: list[Label] = await hass.async_add_executor_job(coordinator.history.labels, 0.0, 1e12, "pending")
    return labels
