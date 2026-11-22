import asyncio
import base64
import binascii
import os
import tempfile
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import probatio
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.util.unit_system import METRIC_SYSTEM

from . import plan_import, valetudo_fetch
from .const import DATA_DIR, DOMAIN, FRAMES_MAX_S, VERSION
from .coordinator import OutglowCoordinator
from .engine import CodecError, from_json, to_json
from .engine.types import Plan, Settings
from .errors import OutglowError
from .history import series
from .session import replay_json
from .store import migrate_plan

Handler = Callable[[HomeAssistant, OutglowCoordinator, dict[str, Any]], Awaitable[Any]]
NUMBER = probatio.Any(int, float)
MIMES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/svg+xml": "svg"}
BACKGROUND_MAX = 10 * 1024 * 1024
TICKS = (0.25, 0.5, 1.0)
BUDGETS = (0.1, 0.3, 1.0, 3.0, 10.0)
MIN_STEP_S = 1.0
BACKGROUND_LOCK = f"{DOMAIN}_background_lock"


def coordinator_of(hass: HomeAssistant) -> OutglowCoordinator | None:
    entries = hass.config_entries.async_loaded_entries(DOMAIN)
    if not entries:
        return None
    runtime: OutglowCoordinator = entries[0].runtime_data
    return runtime


def _command(name: str, fields: dict[Any, Any] | None = None) -> Callable[[Handler], Any]:
    def wrap(handler: Handler) -> Any:
        async def run(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
            coordinator = coordinator_of(hass)
            if coordinator is None:
                connection.send_error(msg["id"], "not_found", "Outglow is not set up")
                return
            try:
                result = await handler(hass, coordinator, msg)
            except OutglowError as err:
                connection.send_error(msg["id"], err.code, err.message)
                return
            except CodecError as err:
                connection.send_error(msg["id"], "invalid_format", str(err))
                return
            connection.send_result(msg["id"], result)

        schema = {probatio.Required("type"): name, **(fields or {})}
        return websocket_api.websocket_command(schema)(websocket_api.require_admin(websocket_api.async_response(run)))

    return wrap


def check_plan(plan: Plan) -> list[dict[str, Any]]:
    plan_import.check_plan(plan)
    plan_import.limit(plan)
    return plan_import.pinned_elsewhere(plan)


def check_settings(settings: Settings) -> None:
    g = settings.global_
    if g.tick_s not in TICKS:
        raise OutglowError("invalid_format", "tick_s must be 0.25, 0.5 or 1")
    if any(not person.startswith("person.") for person in g.persons):
        raise OutglowError("invalid_format", "persons must be person entities")
    r = g.retention
    if min(r.raw_h, r.empty_raw_d, r.ticks_d, r.events_d) < 1:
        raise OutglowError("invalid_format", "Retention must be at least 1")
    for room in settings.rooms.values():
        if not any(abs(room.false_alarm_budget - b) < 1e-9 for b in BUDGETS):
            raise OutglowError("invalid_format", "Unknown false alarm budget")
        if not 10 <= room.hold_time_s <= 3600 or not 30 <= room.light_off_delay_s <= 3600:
            raise OutglowError("invalid_format", "Time out of range")


def decode_settings(data: object) -> Settings:
    settings = from_json(Settings, data)
    check_settings(settings)
    return settings


def background_dir(hass: HomeAssistant) -> Path:
    return Path(hass.config.path(DATA_DIR))


def background_lock(hass: HomeAssistant) -> asyncio.Lock:
    lock: asyncio.Lock = hass.data.setdefault(BACKGROUND_LOCK, asyncio.Lock())
    return lock


def _write_background(folder: Path, ext: str, data: bytes) -> tuple[str, bool]:
    folder.mkdir(parents=True, exist_ok=True)
    name = plan_import.background_file(data, ext)
    path = folder / name
    if path.is_file():
        return name, False
    handle, partial = tempfile.mkstemp(dir=folder, prefix=".plan-", suffix=".part")
    try:
        with os.fdopen(handle, "wb") as out:
            out.write(data)
        os.replace(partial, path)
    except BaseException:
        Path(partial).unlink(missing_ok=True)
        raise
    return name, True


def _remove_backgrounds(folder: Path, keep: set[str]) -> None:
    for path in folder.glob("plan*.*") if folder.is_dir() else []:
        if plan_import.BACKGROUND_FILE.fullmatch(path.name) and path.name not in keep:
            path.unlink(missing_ok=True)
    for path in folder.glob(".plan-*.part") if folder.is_dir() else []:
        if path.is_file():
            path.unlink(missing_ok=True)


def _unlink(path: Path) -> None:
    path.unlink(missing_ok=True)


def _background_exists(folder: Path, name: str) -> bool:
    return (folder / name).is_file()


def _decode_image(image: dict[str, Any]) -> bytes:
    try:
        data = base64.b64decode(image["data_base64"], validate=True)
    except (binascii.Error, ValueError) as err:
        raise OutglowError("invalid_format", "Not base64") from err
    if image.get("deflated"):
        data = plan_import.inflate(data, BACKGROUND_MAX, "The image")
    if not data or len(data) > BACKGROUND_MAX:
        raise OutglowError("invalid_format", "Image is empty or too large")
    return data


def _read_background(folder: Path, name: str | None) -> dict[str, Any]:
    candidates = [folder / name] if name else sorted(folder.glob("plan.*"))
    for path in candidates:
        ext = path.suffix.removeprefix(".")
        mime = next((m for m, e in MIMES.items() if e == ext), None)
        if mime is not None and path.is_file():
            return {
                "image": {"mime": mime, "data_base64": base64.b64encode(path.read_bytes()).decode()},
                "file": path.name,
            }
    return {"image": None, "file": None}


@callback
def async_register_commands(hass: HomeAssistant) -> None:
    for handler in (
        ws_info,
        ws_bulbs,
        ws_plan_get,
        ws_plan_save,
        ws_plan_import,
        ws_valetudo_robots,
        ws_valetudo_fetch,
        ws_background_get,
        ws_background_set,
        ws_live_subscribe,
        ws_history_range,
        ws_history_frames,
        ws_feedback,
        ws_session_start,
        ws_session_label,
        ws_session_stop,
        ws_session_get,
        ws_quality,
        ws_settings_get,
        ws_settings_set,
        ws_model_get,
        ws_model_snapshots,
        ws_model_apply,
        ws_model_discard,
        ws_model_rollback,
        ws_model_snapshot_delete,
        ws_model_reset,
        ws_bulb_write_preview,
        ws_bulb_write,
    ):
        websocket_api.async_register_command(hass, handler)


@_command("outglow/info")
async def ws_info(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    frame = c.frame
    status = frame.status if frame is not None else ("learning" if c.settings.global_.sensing else "paused")
    return {
        "version": VERSION,
        "entry_id": c.entry.entry_id,
        "status": status,
        "base_topic": c.base_topic,
        "units": "metric" if hass.config.units is METRIC_SYSTEM else "imperial",
        "capabilities": {
            "has_persons": bool(hass.states.async_entity_ids("person")),
            "has_ble": "bluetooth" in hass.config.components,
            "z2m_version": c.devices.version,
        },
    }


@_command("outglow/bulbs")
async def ws_bulbs(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return {"bulbs": c.bulb_infos()}


@_command("outglow/plan/get")
async def ws_plan_get(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return {"rev": c.plan.rev, "plan": to_json(c.plan), "reserved_rooms": sorted(await c.async_known_rooms())}


UPLOAD = {
    probatio.Required("mime"): probatio.In(list(MIMES)),
    probatio.Required("data_base64"): str,
    probatio.Optional("deflated", default=False): bool,
}


@_command(
    "outglow/plan/save",
    {
        probatio.Required("rev"): int,
        probatio.Required("plan"): dict,
        probatio.Optional("background_image", default=None): probatio.Any(None, UPLOAD),
    },
)
async def ws_plan_save(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    plan = from_json(Plan, migrate_plan(msg["plan"]))
    warnings = await hass.async_add_executor_job(check_plan, plan)
    folder = background_dir(hass)
    image = msg.get("background_image")
    upload = None
    if image is not None:
        if plan.background is None:
            raise OutglowError("invalid_format", "A background image needs plan.background")
        upload = MIMES[image["mime"]], await hass.async_add_executor_job(_decode_image, image)
    async with background_lock(hass):
        previous = c.plan.background.file if c.plan.background is not None else None
        written = None
        if upload is not None and plan.background is not None:
            name, fresh = await hass.async_add_executor_job(_write_background, folder, *upload)
            written = name if fresh else None
            plan = replace(plan, background=replace(plan.background, file=name))
        elif plan.background is not None and not await hass.async_add_executor_job(
            _background_exists, folder, plan.background.file
        ):
            plan = replace(plan, background=None)
        try:
            saved = await c.async_save_plan(msg["rev"], plan)
        except BaseException:
            shown = c.plan.background.file if c.plan.background is not None else None
            if written is not None and written != shown:
                await hass.async_add_executor_job(_unlink, folder / written)
            raise
        keep = {name for name in (previous, plan.background.file if plan.background else None) if name}
        await hass.async_add_executor_job(_remove_backgrounds, folder, keep)
    return {
        "rev": saved.rev,
        "warnings": warnings,
        "background": to_json(plan.background) if plan.background is not None else None,
        "retired_rooms": list(saved.retired_rooms),
    }


CURRENT = probatio.Optional("current", default=None)


def _current(msg: dict[str, Any]) -> Plan | None:
    data = msg.get("current")
    return from_json(Plan, migrate_plan(data)) if isinstance(data, dict) else None


def _imported(imported: plan_import.Imported) -> dict[str, Any]:
    image = (
        {"mime": "image/svg+xml", "data_base64": base64.b64encode(imported.background).decode()}
        if imported.background is not None
        else None
    )
    return {
        "plan": to_json(imported.plan),
        "warnings": imported.warnings,
        "source": imported.source,
        "background_image": image,
        "kept": imported.kept,
    }


@_command(
    "outglow/plan/import",
    {
        probatio.Required("format"): probatio.In(["auto", "mieszkanie_yaml", "outglow_json", "valetudo_json"]),
        probatio.Optional("text", default=None): probatio.Any(None, str),
        probatio.Optional("deflated_base64", default=None): probatio.Any(None, str),
        CURRENT: probatio.Any(None, dict),
    },
)
async def ws_plan_import(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    known = {d.ieee: d.name for d in c.devices.bulbs()}
    current = _current(msg)
    text: str | None = msg.get("text")
    deflated: str | None = msg.get("deflated_base64")

    def run() -> dict[str, Any]:
        if text is not None and deflated is None:
            return _imported(plan_import.load(msg["format"], text, known, current))
        if deflated is not None and text is None:
            return _imported(plan_import.load(msg["format"], plan_import.inflate_text(deflated), known, current))
        raise OutglowError("invalid_format", "Give either text or deflated_base64")

    return await hass.async_add_executor_job(run)


@_command("outglow/plan/valetudo/robots")
async def ws_valetudo_robots(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return {"url": await c.store.async_load_valetudo_url(), "robots": valetudo_fetch.robots(hass)}


@_command(
    "outglow/plan/valetudo/fetch",
    {
        probatio.Optional("robot", default=None): probatio.Any(None, str),
        probatio.Optional("url", default=None): probatio.Any(None, str),
        CURRENT: probatio.Any(None, dict),
    },
)
async def ws_valetudo_fetch(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    current = _current(msg)
    url, robot = (msg.get("url") or "").strip(), msg.get("robot")
    if url:
        payload = await valetudo_fetch.async_http_map(hass, url)
    elif robot:
        payload = await valetudo_fetch.async_mqtt_map(hass, robot)
    else:
        raise OutglowError("invalid_format", "Give a robot or its address")
    known = {d.ieee: d.name for d in c.devices.bulbs()}
    result = await hass.async_add_executor_job(lambda: _imported(valetudo_fetch.load(payload, known, current)))
    if url:
        await c.store.async_save_valetudo_url(url)
    return result


@_command("outglow/plan/background/get")
async def ws_background_get(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    name = c.plan.background.file if c.plan.background is not None else None
    return await hass.async_add_executor_job(_read_background, background_dir(hass), name)


@_command(
    "outglow/plan/background/set",
    {probatio.Required("mime"): probatio.In(list(MIMES)), probatio.Required("data_base64"): str},
)
async def ws_background_set(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    data = await hass.async_add_executor_job(_decode_image, msg)
    async with background_lock(hass):
        name, _ = await hass.async_add_executor_job(_write_background, background_dir(hass), MIMES[msg["mime"]], data)
    return {"file": name}


@websocket_api.websocket_command(
    {probatio.Required("type"): "outglow/live/subscribe", probatio.Required("rate_hz"): NUMBER}
)
@websocket_api.require_admin
@callback
def ws_live_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    c = coordinator_of(hass)
    if c is None:
        connection.send_error(msg["id"], "not_found", "Outglow is not set up")
        return
    if msg["rate_hz"] <= 0:
        connection.send_error(msg["id"], "invalid_format", "rate_hz must be positive")
        return

    @callback
    def send(event: dict[str, Any]) -> None:
        connection.send_message(websocket_api.event_message(msg["id"], event))

    connection.send_result(msg["id"], None)
    connection.subscriptions[msg["id"]] = c.subscribe_live(send, float(msg["rate_hz"]))


@_command(
    "outglow/history/range",
    {
        probatio.Required("start"): NUMBER,
        probatio.Required("end"): NUMBER,
        probatio.Required("step_s"): NUMBER,
        probatio.Optional("pairs", default=False): bool,
    },
)
async def ws_history_range(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    start, end, step = float(msg["start"]), float(msg["end"]), max(float(msg["step_s"]), MIN_STEP_S)
    if end < start:
        raise OutglowError("invalid_format", "end is before start")
    await c.async_flush_history()
    ids = [room.id for room in c.plan.rooms]
    rooms, pairs = await hass.async_add_executor_job(
        lambda: series(c.history.ticks(start, end), start, end, step, ids, bool(msg["pairs"]))
    )
    events = await hass.async_add_executor_job(c.history.events, start, end, None)
    return {"rooms": rooms, "events": [to_json(e) for e in events], "pairs": pairs}


@_command("outglow/history/frames", {probatio.Required("start"): NUMBER, probatio.Required("end"): NUMBER})
async def ws_history_frames(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    start, end = float(msg["start"]), float(msg["end"])
    if end < start:
        raise OutglowError("invalid_format", "end is before start")
    truncated = end - start > FRAMES_MAX_S
    end = min(end, start + FRAMES_MAX_S)
    records = await c.async_records(start - 30.0, end)
    oldest = await hass.async_add_executor_job(c.history.oldest_raw)
    truncated = truncated or oldest is None or oldest > start
    step = c.settings.global_.tick_s
    first = int(-(-start // step))
    times = [i * step for i in range(first, int(end // step) + 1)]
    model = await c.async_active_model()
    frames = await hass.async_add_executor_job(replay_json, c.engine_plan(), c.engine_settings(), model, records, times)
    return {"frames": frames, "truncated": truncated}


@_command(
    "outglow/feedback",
    {
        probatio.Required("room"): str,
        probatio.Required("kind"): probatio.In(["false_alarm", "missed", "correct"]),
        probatio.Optional("when"): probatio.Any(None, NUMBER),
    },
)
async def ws_feedback(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    if msg["room"] not in {room.id for room in c.plan.rooms}:
        raise OutglowError("not_found", "No such room")
    when = msg.get("when")
    pending_id = await c.async_feedback(msg["room"], msg["kind"], c.now() if when is None else float(when))
    return {"pending_id": pending_id}


@_command(
    "outglow/session/start",
    {probatio.Required("name"): str, probatio.Optional("raise_rate", default=False): bool},
)
async def ws_session_start(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return await c.sessions.async_start(msg["name"], bool(msg["raise_rate"]))


@_command(
    "outglow/session/label",
    {
        probatio.Required("kind"): probatio.In(["room", "empty", "transition"]),
        probatio.Optional("room"): str,
        probatio.Required("activity"): probatio.In(["walk", "still", "any"]),
        probatio.Optional("ts"): NUMBER,
    },
)
async def ws_session_label(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    ts = msg.get("ts")
    return await c.sessions.async_label(msg["kind"], msg.get("room"), msg["activity"], float(ts) if ts else None)


@_command("outglow/session/stop")
async def ws_session_stop(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return await c.sessions.async_stop()


@_command("outglow/session/get")
async def ws_session_get(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return {"session": c.sessions.get()}


@_command("outglow/quality", {probatio.Required("days"): probatio.All(int, probatio.Range(min=1, max=30))})
async def ws_quality(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    report = await c.async_quality(msg["days"])
    return to_json(report)


@_command("outglow/settings/get")
async def ws_settings_get(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return c.settings_json()


@_command("outglow/settings/set", {probatio.Required("rooms"): dict, probatio.Required("global"): dict})
async def ws_settings_set(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    settings = decode_settings({"rooms": msg["rooms"], "global": msg["global"]})
    await c.async_set_settings(settings)
    return c.settings_json()


@_command("outglow/model/get")
async def ws_model_get(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return c.model_summary()


@_command("outglow/model/snapshots")
async def ws_model_snapshots(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return {"snapshots": c.model.snapshot_list()}


@_command(
    "outglow/model/apply",
    {probatio.Required("pending_id"): str, probatio.Optional("mode"): probatio.In(["rules", "bayes"])},
)
async def ws_model_apply(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return await c.async_apply(msg["pending_id"], msg.get("mode"))


@_command("outglow/model/discard", {probatio.Required("pending_id"): str})
async def ws_model_discard(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return await c.async_discard(msg["pending_id"])


@_command("outglow/model/rollback", {probatio.Required("snapshot_id"): str})
async def ws_model_rollback(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return await c.async_rollback(msg["snapshot_id"])


@_command("outglow/model/snapshot/delete", {probatio.Optional("snapshot_id"): str, probatio.Optional("all"): bool})
async def ws_model_snapshot_delete(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    if ("snapshot_id" in msg) == bool(msg.get("all")):
        raise OutglowError("invalid_format", "Give either snapshot_id or all: true")
    return {"snapshots": await c.async_delete_snapshots(msg.get("snapshot_id"))}


@_command("outglow/model/reset", {probatio.Optional("room"): probatio.Any(None, str)})
async def ws_model_reset(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    room = msg.get("room")
    if room is not None and room not in {r.id for r in c.plan.rooms}:
        raise OutglowError("not_found", "No such room")
    return await c.async_reset_learning(room)


BULB_FIELDS = {
    probatio.Required("ieee"): str,
    probatio.Required("setting"): str,
    probatio.Required("value"): probatio.Any(bool, int, str),
}


@_command("outglow/bulb/write_preview", BULB_FIELDS)
async def ws_bulb_write_preview(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return c.writer.preview(msg["ieee"], msg["setting"], msg["value"], c.now())


@_command("outglow/bulb/write", {**BULB_FIELDS, probatio.Required("confirm_token"): str})
async def ws_bulb_write(hass: HomeAssistant, c: OutglowCoordinator, msg: dict[str, Any]) -> Any:
    return await c.writer.async_write(msg["ieee"], msg["setting"], msg["value"], msg["confirm_token"], c.now())
