from dataclasses import replace
from typing import TYPE_CHECKING

import probatio
from homeassistant.components.repairs import RepairsFlow, RepairsFlowResult
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir

from .const import (
    ACTIVITY_MISSING_S,
    CONVERTER_GRACE_S,
    DOMAIN,
    ISSUE_RATES_LEFT,
    ISSUE_SESSION_RATES,
    PANEL_URL_PATH,
    SESSION_RATES_REPAIR_S,
)
from .errors import OutglowError
from .plan_import import bulb_room, check_plan

PLAN_UNREADABLE = "plan_unreadable"

if TYPE_CHECKING:
    from .coordinator import OutglowCoordinator


def wanted(c: OutglowCoordinator) -> dict[str, tuple[str, dict[str, str]]]:
    now = c.now()
    devices = c.devices
    out: dict[str, tuple[str, dict[str, str]]] = {}
    if c.panel_conflict:
        out["panel_conflict"] = ("panel_conflict", {"path": PANEL_URL_PATH})
    if c.plan_copy is not None:
        out[PLAN_UNREADABLE] = (PLAN_UNREADABLE, {"path": c.plan_copy})
    if devices.output == "attribute":
        out["output_attribute"] = ("output_attribute", {"base_topic": c.base_topic})
    restore = c.sessions.rate_restore
    if c.sessions.rates_overdue and restore:
        out[ISSUE_SESSION_RATES] = (
            ISSUE_SESSION_RATES,
            {
                "count": str(len(restore)),
                "bulbs": ", ".join(sorted(restore)),
                "minutes": f"{SESSION_RATES_REPAIR_S / 60:g}",
            },
        )
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
    if c.plan_problem is not None:
        out["plan_too_large"] = ("plan_too_large", {"problem": c.plan_problem})
    elif c.plan.rooms:
        planned = {bulb.ieee for bulb in c.plan.bulbs}
        outside = [d.name for d in bulbs if devices.sensing(d) and d.ieee not in planned]
        homeless = [b.ieee for b in c.plan.bulbs if bulb_room(b, c.plan.rooms) is None]
        if outside or homeless:
            out["plan_incomplete"] = (
                "plan_incomplete",
                {"bulbs": ", ".join(sorted(outside)) or "-", "outside": str(len(homeless))},
            )
    elif c.plan_copy is None and any(devices.sensing(d) for d in bulbs):
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
            is_fixable=issue_id == PLAN_UNREADABLE,
            severity=ir.IssueSeverity.WARNING,
            translation_key=key,
            translation_placeholders=placeholders,
        )


def clear(hass: HomeAssistant) -> None:
    registry = ir.async_get(hass)
    for domain, issue_id in list(registry.issues):
        if domain == DOMAIN and issue_id != ISSUE_RATES_LEFT:
            ir.async_delete_issue(hass, DOMAIN, issue_id)


class PlanCopyFlow(RepairsFlow):
    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass

    def _coordinator(self) -> OutglowCoordinator | None:
        entries = self._hass.config_entries.async_loaded_entries(DOMAIN)
        found: OutglowCoordinator | None = entries[0].runtime_data if entries else None
        return found if found is not None and found.plan_copy is not None else None

    async def async_step_init(self, user_input: dict[str, str] | None = None) -> RepairsFlowResult:
        c = self._coordinator()
        if c is None:
            return self.async_abort(reason="resolved")
        return self.async_show_menu(
            step_id="init", menu_options=["restore", "discard"], description_placeholders={"path": c.plan_copy or "-"}
        )

    async def async_step_restore(self, user_input: dict[str, str] | None = None) -> RepairsFlowResult:
        c = self._coordinator()
        if c is None:
            return self.async_abort(reason="resolved")
        plan = await c.store.async_load_copy()
        if plan is None:
            return self.async_abort(reason="still_unreadable", description_placeholders={"path": c.plan_copy or "-"})
        try:
            check_plan(plan)
            await c.async_save_plan(c.plan.rev, replace(plan, rev=c.plan.rev), resolve=True)
        except OutglowError as err:
            return self.async_abort(reason="restore_failed", description_placeholders={"message": err.message})
        return self.async_create_entry(data={})

    async def async_step_discard(self, user_input: dict[str, str] | None = None) -> RepairsFlowResult:
        c = self._coordinator()
        if c is None:
            return self.async_abort(reason="resolved")
        if user_input is None:
            rooms = ", ".join(sorted(await c.async_known_rooms())) or "-"
            return self.async_show_form(
                step_id="discard", data_schema=probatio.Schema({}), description_placeholders={"rooms": rooms}
            )
        await c.async_save_plan(c.plan.rev, c.plan, resolve=True)
        return self.async_create_entry(data={})


async def async_create_fix_flow(
    hass: HomeAssistant, issue_id: str, data: dict[str, str | int | float | None] | None
) -> RepairsFlow:
    return PlanCopyFlow(hass)
