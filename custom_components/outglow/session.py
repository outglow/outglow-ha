import logging
import math
from collections.abc import Iterable, Iterator
from dataclasses import replace
from typing import TYPE_CHECKING, Any

from homeassistant.core import CALLBACK_TYPE, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_call_later

from .const import (
    LABEL_WEIGHTS,
    RATE_DEFAULT,
    RATE_RETRY_S,
    SESSION_IDLE_S,
    SESSION_RATE,
    SESSION_RATE_MAX_S,
    STEP_MAX_S,
    SUMMARY_LEAD_S,
)
from .engine import Engine, to_json
from .engine.defaults import EMPTY_MARGIN_S, LABEL_TRIM_S
from .engine.model import from_json as model_from_json
from .engine.topology import bulb_room
from .engine.types import Frame, Json, Label, Mode, Plan, Record, Settings
from .errors import OutglowError

if TYPE_CHECKING:
    from .coordinator import OutglowCoordinator

_LOGGER = logging.getLogger(__name__)
NO_ROOM_P = 0.5
CV_FOLDS = 2
SUGGEST_MARGIN = 0.1


def step_end(step: dict[str, Any], now: float) -> float:
    return min(now, float(step["t0"]) + STEP_MAX_S.get(str(step["kind"]), STEP_MAX_S["room"]))


def session_spans(session: dict[str, Any], lead: float) -> list[tuple[float, float]]:
    spans = sorted((float(s["t0"]) - lead, float(s["t1"])) for s in session["steps"] if s["t1"] is not None)
    merged: list[tuple[float, float]] = []
    for a, b in spans:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def step_label(step: dict[str, Any]) -> Label | None:
    t0, t1 = float(step["t0"]), step["t1"]
    if t1 is None:
        return None
    t1 = float(t1)
    kind, activity = step["kind"], step["activity"]
    if kind == "empty":
        t0, t1 = t0 + EMPTY_MARGIN_S, t1 - EMPTY_MARGIN_S
        activity = "any"
    if t1 <= t0:
        return None
    weight = LABEL_WEIGHTS[activity] if kind == "room" else 1.0
    return Label(t0=t0, t1=t1, kind=kind, room=step["room"], activity=activity, source="wizard", weight=weight)


def session_labels(session: dict[str, Any]) -> list[Label]:
    labels = (step_label(step) for step in session["steps"])
    return [label for label in labels if label is not None]


def predicted(probabilities: dict[str, float], rooms: list[str]) -> int:
    ps = [probabilities.get(room, 0.0) for room in rooms]
    top = max(ps, default=0.0)
    return ps.index(top) if top >= NO_ROOM_P and ps.count(top) == 1 else len(rooms)


def _drive(engine: Engine, records: list[Record], times: Iterable[float], frames: bool) -> Iterator[Frame | None]:
    index = 0
    for t in times:
        while index < len(records) and _time(records[index]) <= t:
            engine.feed(records[index])
            index += 1
        if frames:
            yield engine.tick(t)
        else:
            engine.advance(t)
            yield None


def replay_frames(
    plan: Plan, settings: Settings, model: dict[str, Json] | None, records: Iterable[Record], times: list[float]
) -> list[Frame]:
    engine = Engine(plan, settings, model)
    return [f for f in _drive(engine, sorted(records, key=_time), times, frames=True) if f is not None]


def replay_json(
    plan: Plan, settings: Settings, model: dict[str, Json] | None, records: Iterable[Record], times: list[float]
) -> list[Json]:
    return [to_json(frame) for frame in replay_frames(plan, settings, model, records, times)]


def learned_model(
    plan: Plan, settings: Settings, model: dict[str, Json] | None, records: Iterable[Record], labels: list[Label]
) -> dict[str, Json] | None:
    items = sorted(records, key=_time)
    if not items or not labels:
        return model
    engine = Engine(plan, settings, model)
    for label in labels:
        engine.label(label)
    step = settings.global_.tick_s
    end = max(_time(items[-1]), *(label.t1 for label in labels)) + step
    first = math.ceil(_time(items[0]) / step)
    times = (i * step for i in range(first, math.floor(end / step) + 1))
    for _ in _drive(engine, items, times, frames=False):
        pass
    pending = engine.model_state()["pending"]
    return {"active": pending} if isinstance(pending, dict) else model


def _time(record: Record) -> float:
    return float(getattr(record, "t", getattr(record, "t1", 0.0)))


def _scored(step: dict[str, Any], rooms: list[str]) -> bool:
    return step["kind"] == "room" and step["room"] in rooms and step["t1"] is not None and step["activity"] != "still"


def confusion(
    plan: Plan,
    settings: Settings,
    model: dict[str, Json] | None,
    records: Iterable[Record],
    session: dict[str, Any],
) -> tuple[list[list[int]], float | None]:
    rooms = [room.id for room in plan.rooms]
    matrix = [[0] * (len(rooms) + 1) for _ in rooms]
    step_s = settings.global_.tick_s
    samples: list[tuple[float, int]] = []
    for step in session["steps"]:
        if not _scored(step, rooms):
            continue
        start = math.ceil(float(step["t0"]) / step_s)
        end = math.floor(float(step["t1"]) / step_s)
        samples.extend((i * step_s, rooms.index(step["room"])) for i in range(start, end + 1))
    samples.sort()
    engine = Engine(plan, settings, model)
    driven = _drive(engine, sorted(records, key=_time), (t for t, _ in samples), frames=False)
    for (_, row), _ in zip(samples, driven, strict=True):
        probabilities = {room: p for room, (p, _, _) in engine.rooms_now().items()}
        matrix[row][predicted(probabilities, rooms)] += 1
    return matrix, _accuracy(matrix)


def _accuracy(matrix: list[list[int]]) -> float | None:
    total = sum(sum(row) for row in matrix)
    return sum(row[i] for i, row in enumerate(matrix)) / total if total else None


def _part(t0: float, t1: float, k: int) -> tuple[float, float]:
    width = (t1 - t0) / CV_FOLDS
    return t0 + k * width, t0 + (k + 1) * width


def _label_part(label: Label, k: int) -> Label:
    t0, t1 = _part(label.t0, label.t1, k)
    return replace(label, t0=t0, t1=t1)


def _step_part(step: dict[str, Any], k: int) -> dict[str, Any]:
    t0, t1 = _part(float(step["t0"]), float(step["t1"]), k)
    return {**step, "t0": t0, "t1": t1}


def cross_validated(
    plan: Plan,
    settings: Settings,
    model: dict[str, Json] | None,
    records: list[Record],
    session: dict[str, Any],
    labels: list[Label],
) -> tuple[list[list[int]], float | None]:
    rooms = [room.id for room in plan.rooms]
    total = [[0] * (len(rooms) + 1) for _ in rooms]
    walks = [lb for lb in labels if lb.kind == "room" and lb.activity != "still"]
    rest = [lb for lb in labels if lb not in walks]
    scored = [step for step in session["steps"] if _scored(step, rooms)]
    for k in range(CV_FOLDS):
        train = rest + [_label_part(lb, j) for lb in walks for j in range(CV_FOLDS) if j != k]
        learned = learned_model(plan, settings, model, records, train)
        matrix, _ = confusion(plan, settings, learned, records, {"steps": [_step_part(s, k) for s in scored]})
        total = [[x + y for x, y in zip(a, b, strict=True)] for a, b in zip(total, matrix, strict=True)]
    return total, _accuracy(total)


def _in_mode(settings: Settings, mode: Mode) -> Settings:
    return replace(settings, global_=replace(settings.global_, mode=mode))


def summarise(
    plan: Plan,
    settings: Settings,
    model: dict[str, Json] | None,
    records: list[Record],
    session: dict[str, Any],
    labels: list[Label],
) -> dict[str, Any]:
    mode = settings.global_.mode
    before, accuracy_before = confusion(plan, settings, model, records, session)
    after, accuracy_after = (
        cross_validated(plan, settings, model, records, session, labels)
        if mode == "bayes"
        else (before, accuracy_before)
    )
    bayes: dict[str, Any] | None = None
    suggest: Mode | None = None
    if mode == "rules":
        other = _in_mode(settings, "bayes")
        b_before, b_accuracy_before = confusion(plan, other, model, records, session)
        b_after, b_accuracy_after = cross_validated(plan, other, model, records, session, labels)
        bayes = {
            "matrix_before": b_before,
            "matrix_after": b_after,
            "accuracy_before": b_accuracy_before,
            "accuracy_after": b_accuracy_after,
        }
        if b_accuracy_after is not None and b_accuracy_after >= (accuracy_before or 0.0) + SUGGEST_MARGIN:
            suggest = "bayes"
    lit = {bulb_room(plan, b) for b in plan.bulbs}
    active = model.get("active") if model else None
    empty_s = model_from_json(active if isinstance(active, dict) else None).empty_s + sum(
        max(0.0, lb.t1 - lb.t0 - 2 * LABEL_TRIM_S) for lb in labels if lb.kind == "empty" and lb.room is None
    )
    return {
        "rooms": [room.id for room in plan.rooms],
        "mode": mode,
        "matrix_before": before,
        "matrix_after": after,
        "accuracy_before": accuracy_before,
        "accuracy_after": accuracy_after,
        "bayes": bayes,
        "suggest_mode": suggest,
        "rooms_without_bulbs": [room.id for room in plan.rooms if room.id not in lit],
        "empty_house_hours": round(empty_s / 3600, 3),
    }


class SessionManager:
    def __init__(self, coordinator: OutglowCoordinator) -> None:
        self._c = coordinator
        self.session: dict[str, Any] | None = None
        self.rate_restore: dict[str, float] = {}
        self.rate_until: float | None = None
        self._unsub_restore: CALLBACK_TYPE | None = None
        self._unsub_idle: CALLBACK_TYPE | None = None
        self.delays: list[float] = []

    def load(self, runtime: dict[str, Any]) -> None:
        session = runtime.get("session")
        self.session = session if isinstance(session, dict) else None
        restore = runtime.get("rate_restore")
        items = restore.items() if isinstance(restore, dict) else ()
        self.rate_restore = {str(ieee): stored_rate(value) for ieee, value in items}
        until = runtime.get("rate_until")
        self.rate_until = float(until) if isinstance(until, int | float) else None

    def runtime(self) -> dict[str, Any]:
        return {"session": self.session, "rate_restore": self.rate_restore, "rate_until": self.rate_until}

    async def async_resume(self, carry_on: bool = False) -> None:
        now = self._c.now()
        session = self.session
        running = session is not None and session["state"] == "running"
        if running and carry_on and session is not None and now < self._idle_deadline(session):
            self._schedule_idle()
            if self.rate_restore and self.rate_until is not None and now < self.rate_until:
                self._schedule_restore()
            elif self.rate_restore:
                await self.async_restore_rates()
            return
        if running:
            await self._async_finish(now, summary=False, reason="restart")
        if self.rate_restore:
            await self.async_restore_rates()

    def get(self) -> dict[str, Any] | None:
        return self._view(self.session) if self.session is not None else None

    def _view(self, session: dict[str, Any]) -> dict[str, Any]:
        frame = self._c.frame
        reacting = sum(1 for pair in frame.pairs if pair.obs) if frame is not None else 0
        return {
            **session,
            "raised_rate": bool(session["raised_rate"]),
            "live_feedback": {"pairs_reacting": reacting, "veto": frame is not None and frame.veto is not None},
        }

    async def async_start(self, name: str, raise_rate: bool) -> dict[str, Any]:
        if self.session is not None and self.session["state"] == "running":
            raise OutglowError("busy", "A session is already running")
        now = self._c.now()
        with self._c.holding(self._c.snapshot("before_session", now)):
            session_id = f"s-{self._c.model.next_seq():04d}"
            self._c.schedule_save_model()
            session: dict[str, Any] = {
                "session_id": session_id,
                "name": name,
                "started": now,
                "state": "running",
                "raised_rate": False,
                "steps": [],
                "summary": None,
            }
            self.session = session
            await self._c.async_save_runtime()
            if raise_rate:
                await self._async_raise_rates(now)
        self._c.event("session_start", None, {"session_id": session_id, "raised_rate": raise_rate})
        self._schedule_idle()
        return self._view(session)

    def _idle_deadline(self, session: dict[str, Any]) -> float:
        steps = session["steps"]
        last = step_end(steps[-1], math.inf) if steps else float(session["started"])
        return last + SESSION_IDLE_S

    def _cancel_idle(self) -> None:
        if self._unsub_idle is not None:
            self._unsub_idle()
            self._unsub_idle = None

    def _schedule_idle(self) -> None:
        self._cancel_idle()
        if self.session is None or self.session["state"] != "running":
            return
        delay = max(0.0, self._idle_deadline(self.session) - self._c.now())
        self._unsub_idle = async_call_later(self._c.hass, delay, self._idle_due)

    @callback
    def _idle_due(self, _now: Any) -> None:
        self._unsub_idle = None
        session = self.session
        if session is None or session["state"] != "running":
            return
        if self._c.now() < self._idle_deadline(session):
            self._schedule_idle()
            return
        self._c.hass.async_create_task(self._async_finish(self._c.now(), summary=True, reason="idle"))

    async def _async_raise_rates(self, now: float) -> None:
        if self.session is None:
            return
        devices = self._c.devices
        bulbs = [d for d in devices.bulbs() if d.available and devices.sensing(d)] if devices.info_seen else []
        for device in bulbs:
            if device.ieee not in self.rate_restore:
                self.rate_restore[device.ieee] = stored_rate(devices.activity_rate(device.ieee))
        self.rate_until = now + SESSION_RATE_MAX_S
        self.session["raised_rate"] = bool(bulbs)
        await self._c.async_save_runtime()
        try:
            for device in bulbs:
                await self._c.writer.async_set_activity_rate(device.ieee, SESSION_RATE, "session")
        except HomeAssistantError as err:
            _LOGGER.warning("Could not raise the activity rate (%s); restoring", err)
            self.session["raised_rate"] = False
            await self.async_restore_rates()
            return
        self._schedule_restore()

    def _cancel_restore(self) -> None:
        if self._unsub_restore is not None:
            self._unsub_restore()
            self._unsub_restore = None

    def _schedule_restore(self) -> None:
        self._cancel_restore()
        if self.rate_until is None:
            return
        delay = max(0.0, self.rate_until - self._c.now())
        self._unsub_restore = async_call_later(self._c.hass, delay, self._restore_due)

    @callback
    def _restore_due(self, _now: Any) -> None:
        self._unsub_restore = None
        self._c.hass.async_create_task(self.async_restore_rates())

    async def async_restore_rates(self, retry: bool = True) -> bool:
        self._cancel_restore()
        self.rate_until = None
        for ieee, rate in sorted(self.rate_restore.items()):
            try:
                await self._c.writer.async_set_activity_rate(ieee, rate, "session_restore")
            except HomeAssistantError as err:
                _LOGGER.warning("Could not restore the activity rate of %s (%s); trying again", ieee, err)
                break
            del self.rate_restore[ieee]
        await self._c.async_save_runtime()
        if self.rate_restore and retry:
            self._unsub_restore = async_call_later(self._c.hass, RATE_RETRY_S, self._restore_due)
        return not self.rate_restore

    async def async_label(self, kind: str, room: str | None, activity: str, ts: float | None) -> dict[str, Any]:
        session = self.session
        if session is None or session["state"] != "running":
            raise OutglowError("no_session", "No session is running")
        known = {r.id for r in self._c.plan.rooms}
        if (kind == "room" and room is None) or (room is not None and kind != "empty" and room not in known):
            raise OutglowError("not_found", "No such room")
        now = self._c.now()
        if ts is not None:
            self.delays = [*self.delays[-99:], now - ts]
        self._close_step(now)
        session["steps"].append(
            {
                "index": len(session["steps"]),
                "kind": kind,
                "room": room if kind != "empty" else None,
                "activity": activity,
                "t0": now,
                "t1": None,
            }
        )
        await self._c.async_save_runtime()
        self._schedule_idle()
        return self._view(session)

    def _close_step(self, now: float) -> None:
        if self.session is not None and self.session["steps"] and self.session["steps"][-1]["t1"] is None:
            self.session["steps"][-1]["t1"] = step_end(self.session["steps"][-1], now)

    async def async_stop(self) -> dict[str, Any]:
        if self.session is None or self.session["state"] != "running":
            raise OutglowError("no_session", "No session is running")
        return await self._async_finish(self._c.now(), summary=True)

    async def _async_finish(self, now: float, summary: bool, reason: str = "user") -> dict[str, Any]:
        session = self.session
        if session is None:
            raise OutglowError("no_session", "No session is running")
        self._cancel_idle()
        self._close_step(now)
        session["state"] = "stopped"
        if self.rate_restore:
            await self.async_restore_rates()
        labels = session_labels(session)
        pending_id = await self._c.async_add_labels(labels, background=False) if labels else None
        for step in session["steps"]:
            if step["kind"] == "empty" and step["t1"] is not None:
                await self._c.async_copy_empty(float(step["t0"]) + EMPTY_MARGIN_S, float(step["t1"]) - EMPTY_MARGIN_S)
        if summary:
            session["summary"] = await self._async_summary(session, labels, pending_id, now)
        self._c.event(
            "session_stop", None, {"session_id": session["session_id"], "labels": len(labels), "reason": reason}
        )
        await self._c.async_save_runtime()
        return self._view(session)

    async def _async_summary(
        self, session: dict[str, Any], labels: list[Label], pending_id: str | None, now: float
    ) -> dict[str, Any]:
        c = self._c
        records = await c.async_records_spans(session_spans(session, SUMMARY_LEAD_S))
        result = await c.hass.async_add_executor_job(
            summarise, c.plan, c.settings, c.active_model(), records, session, labels
        )
        frame = c.frame
        weak = [room for room, rf in (frame.rooms.items() if frame else []) if rf.coverage != "good"]
        return {**result, "weak_rooms": sorted(weak), "pending_id": pending_id}

    @callback
    def stop(self) -> None:
        self._cancel_restore()
        self._cancel_idle()


def stored_rate(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return float(RATE_DEFAULT)
    return float(value)
