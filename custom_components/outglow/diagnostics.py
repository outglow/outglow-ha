import hashlib
import re
from typing import Any

from homeassistant.core import HomeAssistant

from . import OutglowConfigEntry
from .engine import to_json

IEEE = re.compile(r"0x[0-9a-f]{16}")
REDACTED = "**REDACTED**"
NAME_KEYS = {"name", "friendly_name", "z2m", "light_entity", "area_id", "persons", "likely_person"}


def _p99(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(0.99 * len(ordered)))], 3)


class Redactor:
    def __init__(self, salt: str) -> None:
        self._salt = salt

    def ieee(self, value: str) -> str:
        return "bulb_" + hashlib.sha256(f"{self._salt}:{value}".encode()).hexdigest()[:8]

    def text(self, value: str) -> str:
        return IEEE.sub(lambda m: self.ieee(m.group(0)), value)

    def __call__(self, value: Any, key: str | None = None) -> Any:
        if key in NAME_KEYS and value not in (None, [], ""):
            return REDACTED
        if isinstance(value, dict):
            return {self.text(str(k)): self(v, str(k)) for k, v in value.items()}
        if isinstance(value, list | tuple):
            return [self(v) for v in value]
        if isinstance(value, str):
            return self.text(value)
        return value


def _plan_shape(plan: dict[str, Any]) -> dict[str, Any]:
    rooms = []
    for room in plan.get("rooms", []):
        xs = [p[0] for p in room.get("outline", [])]
        ys = [p[1] for p in room.get("outline", [])]
        size = [round(max(xs) - min(xs), 1), round(max(ys) - min(ys), 1)] if xs else None
        rooms.append({"id": room["id"], "points": len(xs), "size_m": size, "entrance": room.get("entrance")})
    return {
        "rev": plan.get("rev"),
        "rooms": rooms,
        "walls": [w.get("kind") for w in plan.get("walls", [])],
        "doors": len(plan.get("doors", [])),
        "adjacent": plan.get("adjacent", []),
        "bulbs": [{"ieee": b["ieee"], "height": b.get("height"), "room": b.get("room")} for b in plan.get("bulbs", [])],
        "excluded_directions": len(plan.get("excluded_directions", [])),
        "background": plan.get("background") is not None,
    }


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: OutglowConfigEntry) -> dict[str, Any]:
    c = entry.runtime_data
    redact = Redactor(entry.entry_id)
    plan = to_json(c.plan)
    counts = await hass.async_add_executor_job(c.history.counts)
    settings = c.settings_json()
    frame = to_json(c.frame) if c.frame is not None else None
    data = {
        "base_topic": c.base_topic,
        "z2m": {
            "version": c.devices.version,
            "output": c.devices.output,
            "bridge_online": c.devices.bridge_online,
            "devices_seen": c.devices.devices_seen is not None,
        },
        "plan": _plan_shape(plan if isinstance(plan, dict) else {}),
        "settings": settings,
        "bulbs": c.bulb_infos(),
        "model": c.model_summary(),
        "snapshots": c.model.snapshot_list(),
        "frame": frame,
        "history_rows": counts,
        "stats": {
            "messages": c.source.messages,
            "tick_ms_p99": _p99(c.tick_ms),
            "tick_ms_max": round(max(c.tick_ms), 3) if c.tick_ms else None,
            "ticks_measured": len(c.tick_ms),
            "house_empty": c.house_empty,
            "session_delay_s_p99": _p99(c.sessions.delays),
        },
    }
    result: dict[str, Any] = redact(data)
    return result
