import heapq
import itertools
from datetime import datetime
from pathlib import Path
from typing import Any

import probatio
from homeassistant.core import HomeAssistant, ServiceCall, ServiceResponse, SupportsResponse
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.service import async_register_admin_service

from .const import DATA_DIR, DOMAIN, EXPORTS_DIR, LABEL_WEIGHTS, VERSION
from .coordinator import OutglowCoordinator
from .engine import recording
from .engine.types import Header, Label, Observation, Record
from .errors import OutglowError
from .history import History
from .websocket import coordinator_of

FEEDBACK_SCHEMA = probatio.Schema(
    {
        probatio.Required("room"): cv.string,
        probatio.Required("kind"): probatio.In(["false_alarm", "missed", "correct"]),
        probatio.Optional("when"): cv.datetime,
    }
)
LABEL_SCHEMA = probatio.Schema(
    {
        probatio.Optional("room"): cv.string,
        probatio.Optional("empty", default=False): cv.boolean,
        probatio.Required("activity"): probatio.In(["walk", "still", "transition"]),
        probatio.Optional("duration", default=60): probatio.All(
            probatio.Coerce(float), probatio.Range(min=1, max=86400)
        ),
    }
)
SESSION_SCHEMA = probatio.Schema({probatio.Optional("name", default="Session"): cv.string})
EXPORT_SCHEMA = probatio.Schema(
    {
        probatio.Required("start"): cv.datetime,
        probatio.Required("end"): cv.datetime,
        probatio.Optional("include_raw", default=True): cv.boolean,
    }
)
RESET_SCHEMA = probatio.Schema({probatio.Optional("room"): cv.string})
WRITE_SCHEMA = probatio.Schema(
    {
        probatio.Required("bulb"): cv.string,
        probatio.Required("setting"): probatio.In(
            ["sensing", "sensitivity", "probes", "auto_calibration", "self_tuning", "calibrate"]
        ),
        probatio.Required("value"): probatio.Any(bool, int, str),
        probatio.Required("confirm"): True,
    }
)


def _coordinator(hass: HomeAssistant) -> OutglowCoordinator:
    coordinator = coordinator_of(hass)
    if coordinator is None:
        raise ServiceValidationError("Outglow is not set up")
    return coordinator


def _room(coordinator: OutglowCoordinator, room: str) -> str:
    for item in coordinator.plan.rooms:
        if room in (item.id, item.name):
            return item.id
    raise ServiceValidationError(f"Unknown room {room}")


def _ts(value: datetime | None, coordinator: OutglowCoordinator) -> float:
    return value.timestamp() if value is not None else coordinator.now()


def _when(record: Record) -> float:
    match record:
        case Label():
            return record.t1
        case Header():
            return 0.0
        case _:
            return record.t


def export_jsonl(
    path: Path,
    history: History,
    span: tuple[float, float],
    include_raw: bool,
    header: Header,
    labels: list[Label],
    names: dict[str, str],
) -> int:
    raw = (r for r in history.iter_records(*span) if include_raw or not isinstance(r, Observation))
    merged = heapq.merge(raw, sorted(labels, key=_when), key=_when)
    path.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with path.open("w", encoding="utf-8") as out:
        for line in recording.write(itertools.chain([header], merged), names):
            out.write(f"{line}\n")
            count += 1
    return count - 1


def async_register_services(hass: HomeAssistant) -> None:
    async def feedback(call: ServiceCall) -> None:
        c = _coordinator(hass)
        await c.async_feedback(_room(c, call.data["room"]), call.data["kind"], _ts(call.data.get("when"), c))

    async def label(call: ServiceCall) -> None:
        c = _coordinator(hass)
        empty = call.data["empty"]
        room = None if empty else call.data.get("room")
        if room is None and not empty:
            raise ServiceValidationError("Give a room or empty: true")
        now = c.now()
        activity = call.data["activity"]
        item = Label(
            t0=now - call.data["duration"],
            t1=now,
            kind="empty" if empty else "transition" if activity == "transition" else "room",
            room=_room(c, room) if room is not None else None,
            activity="any" if activity == "transition" else activity,
            source="service",
            weight=LABEL_WEIGHTS["service"],
        )
        await c.async_add_labels([item], background=False)

    async def start_session(call: ServiceCall) -> None:
        c = _coordinator(hass)
        try:
            await c.sessions.async_start(call.data["name"], False)
        except OutglowError as err:
            raise ServiceValidationError(err.message) from err

    async def stop_session(call: ServiceCall) -> None:
        c = _coordinator(hass)
        try:
            await c.sessions.async_stop()
        except OutglowError as err:
            raise ServiceValidationError(err.message) from err

    async def export_recording(call: ServiceCall) -> ServiceResponse:
        c = _coordinator(hass)
        t0, t1 = call.data["start"].timestamp(), call.data["end"].timestamp()
        if t1 <= t0:
            raise ServiceValidationError("end must be after start")
        await c.async_flush_history()
        labels = await hass.async_add_executor_job(c.history.labels, t0, t1, None)
        header = Header(plan=c.plan, settings=c.settings, created=c.now(), generator=f"outglow-ha {VERSION}")
        path = Path(hass.config.path(DATA_DIR, EXPORTS_DIR, f"outglow-{int(t0)}-{int(t1)}.jsonl"))
        count = await hass.async_add_executor_job(
            export_jsonl, path, c.history, (t0, t1), call.data["include_raw"], header, labels, c.devices.names()
        )
        return {"path": str(path), "records": count}

    async def reset_learning(call: ServiceCall) -> None:
        c = _coordinator(hass)
        room = call.data.get("room")
        await c.async_reset_learning(_room(c, room) if room is not None else None)

    async def write_bulb_setting(call: ServiceCall) -> ServiceResponse:
        c = _coordinator(hass)
        target = str(call.data["bulb"])
        device = c.devices.get(target.lower()) or c.devices.by_name(target)
        if device is None:
            raise ServiceValidationError(f"Unknown bulb {target}")
        try:
            preview = c.writer.preview(device.ieee, call.data["setting"], call.data["value"], c.now())
            result = await c.writer.async_write(
                device.ieee, call.data["setting"], call.data["value"], preview["confirm_token"], c.now()
            )
        except OutglowError as err:
            raise ServiceValidationError(err.message) from err
        out: dict[str, Any] = {**result, "effects": [e["code"] for e in preview["effects"]]}
        return out

    hass.services.async_register(DOMAIN, "feedback", feedback, schema=FEEDBACK_SCHEMA)
    hass.services.async_register(DOMAIN, "label", label, schema=LABEL_SCHEMA)
    async_register_admin_service(hass, DOMAIN, "start_session", start_session, SESSION_SCHEMA)
    async_register_admin_service(hass, DOMAIN, "stop_session", stop_session, probatio.Schema({}))
    async_register_admin_service(
        hass, DOMAIN, "export_recording", export_recording, EXPORT_SCHEMA, SupportsResponse.OPTIONAL
    )
    async_register_admin_service(hass, DOMAIN, "reset_learning", reset_learning, RESET_SCHEMA)
    async_register_admin_service(
        hass, DOMAIN, "write_bulb_setting", write_bulb_setting, WRITE_SCHEMA, SupportsResponse.OPTIONAL
    )
