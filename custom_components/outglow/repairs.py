from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .const import ACTIVITY_MISSING_S, CONVERTER_GRACE_S, DOMAIN, ISSUE_RATES_LEFT, PANEL_URL_PATH
from .plan_import import bulb_room

if TYPE_CHECKING:
    from .coordinator import OutglowCoordinator


def wanted(c: OutglowCoordinator) -> dict[str, tuple[str, dict[str, str]]]:
    now = c.now()
    devices = c.devices
    out: dict[str, tuple[str, dict[str, str]]] = {}
    if c.panel_conflict:
        out["panel_conflict"] = ("panel_conflict", {"path": PANEL_URL_PATH})
    if devices.output == "attribute":
        out["output_attribute"] = ("output_attribute", {"base_topic": c.base_topic})
    if devices.bridge_online is False:
        out["bridge_offline"] = ("bridge_offline", {"base_topic": c.base_topic})
    bulbs = devices.bulbs()
    seen = devices.devices_seen
    if bulbs and not any(d.sensing_capable for d in bulbs) and seen is not None and now - seen >= CONVERTER_GRACE_S:
        out["no_converter"] = ("no_converter", {"bulbs": str(len(bulbs))})
    if now - c.started >= ACTIVITY_MISSING_S:
        for device in bulbs:
            last = c.last_activity.get(device.ieee)
            if devices.sensing(device) and (last is None or now - last >= ACTIVITY_MISSING_S):
                out[f"no_activity_reports_{device.ieee}"] = ("no_activity_reports", {"bulb": device.name})
    if c.plan.rooms:
        planned = {bulb.ieee for bulb in c.plan.bulbs}
        outside = [d.name for d in bulbs if devices.sensing(d) and d.ieee not in planned]
        homeless = [b.ieee for b in c.plan.bulbs if bulb_room(b, c.plan.rooms) is None]
        if outside or homeless:
            out["plan_incomplete"] = (
                "plan_incomplete",
                {"bulbs": ", ".join(sorted(outside)) or "-", "outside": str(len(homeless))},
            )
    elif any(devices.sensing(d) for d in bulbs):
        out["plan_missing"] = ("plan_missing", {})
    names = {room.id: room.name for room in c.plan.rooms}
    frame = c.frame
    if frame is not None and frame.status in ("ready", "degraded"):
        for room, rf in frame.rooms.items():
            if rf.coverage == "none":
                out[f"room_no_coverage_{room}"] = ("room_no_coverage", {"room": names.get(room, room)})
    quality = c.last_quality
    for rec in quality.recommendations if quality is not None else ():
        if rec.severity == "warning":
            rules = rec.kind == "no_bulbs" and rec.numbers.get("crossing", 0.0) > 0
            key = f"recommendation_{rec.kind}{'_rules' if rules else ''}"
            out[f"recommendation_{rec.id}"] = (key, {"room": names.get(rec.room, rec.room) if rec.room else "-"})
    return out


def update(c: OutglowCoordinator) -> None:
    issues = wanted(c)
    registry = ir.async_get(c.hass)
    for (domain, issue_id), _issue in list(registry.issues.items()):
        if domain == DOMAIN and issue_id not in issues and issue_id != ISSUE_RATES_LEFT:
            ir.async_delete_issue(c.hass, DOMAIN, issue_id)
    for issue_id, (key, placeholders) in sorted(issues.items()):
        ir.async_create_issue(
            c.hass,
            DOMAIN,
            issue_id,
            is_fixable=False,
            severity=ir.IssueSeverity.WARNING,
            translation_key=key,
            translation_placeholders=placeholders,
        )


def clear(hass: HomeAssistant) -> None:
    registry = ir.async_get(hass)
    for domain, issue_id in list(registry.issues):
        if domain == DOMAIN and issue_id != ISSUE_RATES_LEFT:
            ir.async_delete_issue(hass, DOMAIN, issue_id)
