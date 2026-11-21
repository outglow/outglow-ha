import asyncio
import logging
import math
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from datetime import timedelta
from pathlib import Path
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import CALLBACK_TYPE, Event, HomeAssistant, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change, async_track_time_interval

from . import leftover, repairs
from .const import (
    BRIDGE_SETTLE_S,
    CALIBRATION_DAYS,
    CALIBRATION_HOUR,
    CALIBRATION_MINUTE,
    CONF_BASE_TOPIC,
    DATA_DIR,
    DOMAIN,
    FALSE_ALARM_WINDOW_S,
    FEEDBACK_DEFAULT_S,
    FEEDBACK_LOOKBACK_S,
    FEEDBACK_ON_AFTER_S,
    FEEDBACK_ON_BEFORE_S,
    HISTORY_FILE,
    HISTORY_FLUSH_S,
    LABEL_WEIGHTS,
    LIVE_MAX_HZ,
    MANUAL_LIGHT_AFTER_S,
    MANUAL_LIGHT_BEFORE_S,
    ROOM_KEYS,
    SIGNAL_PLAN,
    TICK_STORE_P,
)
from .context import ContextTracker, EmptyInterval, HouseState
from .engine import Engine, from_json, to_json
from .engine.core import Carry
from .engine.types import (
    CalibrationResult,
    Context,
    EventKind,
    Frame,
    HistoryEvent,
    HouseEmpty,
    Json,
    Label,
    LabelKind,
    LightEvent,
    Mode,
    Observation,
    Plan,
    QualityInputs,
    QualityReport,
    Record,
    Room,
    RoomSettings,
    Scalar,
    Settings,
)
from .errors import OutglowError
from .history import History
from .learning import ModelBook, SnapshotReason
from .live import frame_delta
from .mqtt_source import MqttSource
from .plan_import import bulb_room
from .session import SessionManager
from .store import OutglowStore
from .z2m import BulbWriter, Z2MDevices

_LOGGER = logging.getLogger(__name__)
TIMING_KEPT = 1000
HOUR_S = 3600.0
CLOCK: Callable[[], float] = time.time
DAY_S = 86400.0


@dataclass(slots=True)
class LiveSubscription:
    send: Callable[[dict[str, Any]], None]
    period: float
    last: float | None = None
    previous: dict[str, Any] | None = None


class OutglowCoordinator:
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.base_topic: str = entry.data[CONF_BASE_TOPIC]
        self.clock: Callable[[], float] = CLOCK
        self.store = OutglowStore(hass)
        self.devices = Z2MDevices()
        self.writer = BulbWriter(hass, self.base_topic, self.devices, self._record_write)
        self.history = History(Path(hass.config.path(DATA_DIR, HISTORY_FILE)))
        self.source = MqttSource(hass, self.base_topic, self.devices, self, self.now)
        self.context_tracker = ContextTracker(hass, self._on_light, self._on_persons, self.now)
        self.house = HouseState()
        self.sessions = SessionManager(self)
        self.plan = Plan()
        self.settings = Settings()
        self.model = ModelBook({"engine": None, "seq": 0}, [])
        self.engine = Engine(self.plan, self.settings)
        self.frame: Frame | None = None
        self.started = 0.0
        self.house_empty: HouseEmpty = "unknown"
        self.false_alarms: dict[str, list[float]] = {}
        self.last_activity: dict[str, float] = {}
        self.light_entities: dict[str, str] = {}
        self.bulb_areas: dict[str, str | None] = {}
        self.gate_hours: dict[str, dict[int, list[int]]] = {}
        self.tick_ms: list[float] = []
        self._listeners: list[Callable[[], None]] = []
        self._live: dict[int, LiveSubscription] = {}
        self._live_seq = 0
        self._unsubs: list[CALLBACK_TYPE] = []
        self._tick_unsub: CALLBACK_TYPE | None = None
        self._occupied: dict[str, bool] = {}
        self._flushing = False
        self._loaded = False
        self._bridge_up: bool | None = None
        self._bridge_up_at = -math.inf
        self.panel_registered = False
        self.panel_conflict = False
        self.last_quality: QualityReport | None = None
        self.rolling_back: str | None = None
        self._engine_lock = asyncio.Lock()
        self._held: list[str] = []

    def now(self) -> float:
        return self.clock()

    async def async_setup(self, carry_on: bool = False) -> None:
        self.started = self.now()
        await self.hass.async_add_executor_job(self.history.open)
        self.plan = await self.store.async_load_plan()
        self.settings = self._complete_settings(await self.store.async_load_settings())
        self.model = ModelBook(await self.store.async_load_model(), await self.store.async_load_snapshots())
        self.sessions.load(await self.store.async_load_runtime())
        self.model.observe_id(self.sessions.session["session_id"] if self.sessions.session else None)
        self._loaded = True
        self.engine = Engine(self.plan, self.settings, self.model.engine_state())
        self.engine.context(self._context(self.now()))
        events = await self.hass.async_add_executor_job(
            self.history.events, self.started - FALSE_ALARM_WINDOW_S, self.started, ["false_alarm"]
        )
        for event in events:
            if event.room is not None:
                self.false_alarms.setdefault(event.room, []).append(event.t)
        await self.source.async_start()
        self._schedule_tick()
        self._unsubs.append(async_track_time_interval(self.hass, self._flush_due, timedelta(seconds=HISTORY_FLUSH_S)))
        self._unsubs.append(async_track_time_interval(self.hass, self._hourly, timedelta(hours=1)))
        self._unsubs.append(
            async_track_time_change(
                self.hass, self._calibration_due, hour=CALIBRATION_HOUR, minute=CALIBRATION_MINUTE, second=0
            )
        )
        self._unsubs.append(self.hass.bus.async_listen(EVENT_HOMEASSISTANT_STOP, self._async_on_stop))
        self._track_persons()
        self._sync_room_devices({})
        left = await leftover.async_peek(self.hass, self.base_topic)
        if left:
            self.sessions.rate_restore = {**self.sessions.rate_restore, **left}
            await self.async_save_runtime()
            await leftover.async_forget(self.hass, self.base_topic)
        await leftover.async_forget(self.hass, self.base_topic, others=True)
        await self.sessions.async_resume(carry_on)
        repairs.update(self)

    async def async_unload(self, keep_session: bool = False) -> None:
        for unsub in self._unsubs:
            unsub()
        self._unsubs.clear()
        if self._tick_unsub is not None:
            self._tick_unsub()
            self._tick_unsub = None
        self.source.async_stop()
        self.context_tracker.stop()
        if self._loaded and keep_session:
            await self.async_save_runtime()
        elif self._loaded and self.sessions.rate_restore:
            await self._async_hand_over_rates()
        self.sessions.stop()
        self._live.clear()
        self._listeners.clear()
        if self._loaded:
            self._loaded = False
            await self.async_save_model()
        await self.hass.async_add_executor_job(self.history.close)

    async def _async_hand_over_rates(self) -> None:
        if await self.sessions.async_restore_rates(retry=False):
            return
        left, self.sessions.rate_restore = self.sessions.rate_restore, {}
        await leftover.async_keep(self.hass, self.base_topic, left)
        await self.async_save_runtime()

    async def _async_on_stop(self, _event: Event) -> None:
        await self.async_flush_history()
        await self.async_save_model()
        await self.store.async_save_snapshots(self.model.snapshots)
        await self.async_save_runtime()

    def _complete_settings(self, settings: Settings, plan: Plan | None = None) -> Settings:
        rooms = {room.id: settings.rooms.get(room.id, RoomSettings()) for room in (plan or self.plan).rooms}
        return replace(settings, rooms=rooms)

    @property
    def model_version(self) -> int:
        version = self.engine.summary()["model_version"]
        return version if isinstance(version, int) else 0

    def model_summary(self) -> dict[str, Any]:
        return self.engine.summary()

    def active_model(self) -> dict[str, Json]:
        return {"active": self.engine.model_state()["active"]}

    async def async_save_model(self) -> None:
        self.model.book["engine"] = self.engine.model_state()
        await self.store.async_save_model(self.model.book)

    def schedule_save_model(self) -> None:
        self.model.book["engine"] = self.engine.model_state()
        self.store.schedule_model(self.model.book)

    def _context(self, t: float) -> Context:
        return Context(
            t=t,
            persons_home=self.house.persons_home,
            house_empty=self.house_empty,
            offline=self.devices.offline(),
        )

    def _schedule_tick(self) -> None:
        if self._tick_unsub is not None:
            self._tick_unsub()
        self._tick_unsub = async_track_time_interval(
            self.hass, self._tick_due, timedelta(seconds=self.settings.global_.tick_s)
        )

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> CALLBACK_TYPE:
        self._listeners.append(listener)

        @callback
        def remove() -> None:
            if listener in self._listeners:
                self._listeners.remove(listener)

        return remove

    @callback
    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()

    @callback
    def _tick_due(self, _now: Any) -> None:
        self.tick()

    @callback
    def tick(self) -> Frame:
        t = self.now()
        self.source.flush(t)
        self._update_house(t)
        start = time.perf_counter()
        frame = self.engine.tick(t)
        self.tick_ms = [*self.tick_ms[-(TIMING_KEPT - 1) :], (time.perf_counter() - start) * 1000]
        if not self.settings.global_.sensing:
            frame = replace(frame, status="paused")
        elif self.devices.bridge_online is False:
            frame = replace(frame, status="degraded")
        self.set_frame(frame)
        return frame

    @callback
    def set_frame(self, frame: Frame) -> None:
        self.frame = frame
        self._store_tick(frame)
        self._room_events(frame)
        self._gate_stats(frame)
        self._notify()
        self._send_live(frame)

    def _store_tick(self, frame: Frame) -> None:
        if not any(room.p > TICK_STORE_P for room in frame.rooms.values()):
            return
        rooms = {room: [round(rf.p, 3), rf.motion] for room, rf in frame.rooms.items()}
        pairs = [[pair.a, pair.b, pair.obs] for pair in frame.pairs if pair.obs is not None]
        self.history.add_tick(frame.t, rooms, pairs)

    def _room_events(self, frame: Frame) -> None:
        for room, rf in frame.rooms.items():
            before = self._occupied.get(room, False)
            if rf.occupied != before:
                self.event("motion_on" if rf.occupied else "motion_off", room, {"p": round(rf.p, 3)}, frame.t)
            self._occupied[room] = rf.occupied

    def _gate_stats(self, frame: Frame) -> None:
        hour = math.floor(frame.t / HOUR_S)
        for ieee, gate in frame.gates.items():
            hours = self.gate_hours.setdefault(ieee, {})
            bucket = hours.setdefault(hour, [0, 0])
            bucket[0] += gate == "open"
            bucket[1] += gate != "offline"
            for old in [h for h in hours if h <= hour - 24]:
                del hours[old]

    def gate_duty(self, ieee: str) -> float | None:
        buckets = self.gate_hours.get(ieee, {}).values()
        total = sum(b[1] for b in buckets)
        return round(sum(b[0] for b in buckets) / total, 4) if total else None

    def subscribe_live(self, send: Callable[[dict[str, Any]], None], rate_hz: float) -> CALLBACK_TYPE:
        self._live_seq += 1
        key = self._live_seq
        sub = LiveSubscription(send=send, period=1 / min(max(rate_hz, 0.1), LIVE_MAX_HZ))
        self._live[key] = sub
        if self.frame is not None:
            self._send_one(sub, self.frame, force=True)

        @callback
        def remove() -> None:
            self._live.pop(key, None)

        return remove

    def _send_live(self, frame: Frame) -> None:
        for sub in list(self._live.values()):
            self._send_one(sub, frame, force=False)

    def _send_one(self, sub: LiveSubscription, frame: Frame, force: bool) -> None:
        if not force and sub.last is not None and frame.t - sub.last < sub.period - 1e-6:
            return
        current = to_json(frame)
        assert isinstance(current, dict)
        delta = frame_delta(sub.previous, current) if sub.previous is not None else None
        sub.send({"kind": "delta", "delta": delta} if delta is not None else {"kind": "full", "frame": current})
        sub.previous = current
        sub.last = frame.t

    def observe(self, obs: Observation) -> None:
        if not self.settings.global_.sensing:
            return
        self.engine.observe(obs)
        self.history.add_record(obs)
        if obs.source == "activity":
            self.last_activity[obs.rx] = obs.t

    def bridge_changed(self) -> None:
        if self.devices.bridge_online and not self._bridge_up:
            self._bridge_up_at = self.now()
        self._bridge_up = self.devices.bridge_online
        self._map_lights()
        self.engine.context(self._context(self.now()))
        repairs.update(self)
        self._notify()

    def availability_changed(self, ieee: str, online: bool) -> None:
        ctx = self._context(self.now())
        self.engine.context(ctx)
        if self.settings.global_.sensing:
            self.history.add_record(ctx)
        self._notify()

    def _map_lights(self) -> None:
        dev_reg = dr.async_get(self.hass)
        ent_reg = er.async_get(self.hass)
        lights: dict[str, str] = {}
        areas: dict[str, str | None] = {}
        for bulb in self.devices.bulbs():
            found = dev_reg.async_get_devices(identifiers={("mqtt", f"zigbee2mqtt_{bulb.ieee}")})
            if not found:
                continue
            device = found[0]
            areas[bulb.ieee] = device.area_id
            for entry in er.async_entries_for_device(ent_reg, device.id):
                if entry.domain == "light":
                    lights[entry.entity_id] = bulb.ieee
        self.light_entities = lights
        self.bulb_areas = areas
        self.context_tracker.track_lights(lights)

    def light_entity(self, ieee: str) -> str | None:
        return next((entity for entity, owner in sorted(self.light_entities.items()) if owner == ieee), None)

    def room_of_bulb(self, ieee: str) -> str | None:
        for bulb in self.plan.bulbs:
            if bulb.ieee == ieee:
                return bulb_room(bulb, self.plan.rooms)
        area = self.bulb_areas.get(ieee)
        return next((room.id for room in self.plan.rooms if area and room.area_id == area), None)

    def _on_light(self, event: LightEvent, ieee: str) -> None:
        if not self.settings.global_.sensing:
            return
        self.engine.light(event)
        self.history.add_record(event)
        room = self.room_of_bulb(ieee)
        frame = self.frame
        settling = event.t - max(self._bridge_up_at, self.started) < BRIDGE_SETTLE_S
        if event.on and event.origin in ("user", "remote") and room is not None and frame is not None and not settling:
            rf = frame.rooms.get(room)
            if rf is not None and not rf.occupied:
                label = Label(
                    t0=event.t - MANUAL_LIGHT_BEFORE_S,
                    t1=event.t + MANUAL_LIGHT_AFTER_S,
                    kind="room",
                    room=room,
                    activity="any",
                    source="manual_light",
                    weight=LABEL_WEIGHTS["manual_light"],
                )
                self.hass.async_create_task(self.async_add_labels([label], background=True))

    def _track_persons(self) -> None:
        g = self.settings.global_
        self.context_tracker.track_persons(g.persons if g.use_persons else ())
        self._update_house(self.now())

    def _on_persons(self) -> None:
        self._update_house(self.now())

    def _update_house(self, t: float) -> None:
        g = self.settings.global_
        if not (g.use_persons and g.persons):
            empty: HouseEmpty = "unknown"
            closed: list[EmptyInterval] = []
            self.house = HouseState() if self.house.away_since is not None else self.house
        else:
            closed = self.house.update(t, self.context_tracker.person_states(), g.others_may_be_home)
            empty = self.house.empty(t, g.others_may_be_home)
        if empty != self.house_empty:
            previous, self.house_empty = self.house_empty, empty
            ctx = self._context(t)
            self.engine.context(ctx)
            if self.settings.global_.sensing:
                self.history.add_record(ctx)
            if empty in ("yes", "soft"):
                self.event("house_empty", None, {"soft": empty == "soft"}, t)
            elif previous in ("yes", "soft"):
                self.event("house_occupied", None, {}, t)
        for interval in closed:
            self.hass.async_create_task(self._async_empty_interval(interval))

    async def _async_empty_interval(self, interval: EmptyInterval) -> None:
        await self.async_copy_empty(interval.t0, interval.t1)
        weight = LABEL_WEIGHTS["empty_house_soft" if interval.soft else "empty_house"]
        label = Label(t0=interval.t0, t1=interval.t1, kind="empty", source="empty_house", weight=weight)
        await self.async_add_labels([label], background=True)

    async def async_copy_empty(self, t0: float, t1: float) -> None:
        if t1 <= t0:
            return
        await self.async_flush_history()
        await self.hass.async_add_executor_job(self.history.copy_to_empty, t0, t1)

    def event(self, kind: EventKind, room: str | None, data: dict[str, Scalar], t: float | None = None) -> None:
        when = self.now() if t is None else t
        self.history.add_event(HistoryEvent(t=when, kind=kind, room=room, data=data))
        if kind == "false_alarm" and room is not None:
            self.false_alarms.setdefault(room, []).append(when)

    def false_alarms_24h(self, room: str) -> int:
        cutoff = self.now() - FALSE_ALARM_WINDOW_S
        times = [t for t in self.false_alarms.get(room, []) if t >= cutoff]
        self.false_alarms[room] = times
        return len(times)

    def _record_write(self, kind: str, data: dict[str, Any]) -> None:
        self.event(
            "bulb_write", None, {k: v for k, v in data.items() if isinstance(v, str | int | float | bool | None)}
        )

    @callback
    def _flush_due(self, _now: Any) -> None:
        if self.history.pending_writes() and not self._flushing:
            self.hass.async_create_task(self.async_flush_history())

    async def async_flush_history(self) -> None:
        self._flushing = True
        try:
            batch = self.history.take_batch()
            await self.hass.async_add_executor_job(self.history.write_batch, batch)
        finally:
            self._flushing = False

    async def async_delete_history(self) -> None:
        await self.async_flush_history()
        await self.hass.async_add_executor_job(self.history.clear_motion)
        self.false_alarms.clear()
        self.gate_hours.clear()
        self._notify()

    async def async_records(self, t0: float, t1: float) -> list[Record]:
        await self.async_flush_history()
        return list(await self.hass.async_add_executor_job(self.history.records, t0, t1))

    async def async_records_spans(self, spans: list[tuple[float, float]]) -> list[Record]:
        await self.async_flush_history()
        out: list[Record] = []
        for t0, t1 in spans:
            out.extend(await self.hass.async_add_executor_job(self.history.records, t0, t1))
        return out

    @callback
    def _hourly(self, _now: Any) -> None:
        self.hass.async_create_task(self.async_hourly())

    async def async_hourly(self) -> None:
        await self.async_flush_history()
        await self.hass.async_add_executor_job(self.history.purge, self.settings.global_.retention, self.now())
        self.schedule_save_model()
        self._map_lights()
        repairs.update(self)

    @callback
    def _calibration_due(self, _now: Any) -> None:
        self.hass.async_create_task(self.async_calibrate())

    async def async_calibrate(self) -> CalibrationResult:
        t = self.now()
        with self.holding(self.snapshot("daily", t)):
            return await self._async_calibrate(t)

    async def _async_calibrate(self, t: float) -> CalibrationResult:
        open_interval = self.house.open_interval(t, self.settings.global_.others_may_be_home)
        if open_interval is not None:
            await self.async_copy_empty(open_interval.t0, open_interval.t1)
        await self.async_flush_history()
        t0 = t - CALIBRATION_DAYS * DAY_S
        spans = await self.hass.async_add_executor_job(self.history.empty_spans, t0, t)
        trial = Engine(self.plan, self.settings, self.engine.model_state())
        samples = self.history.iter_observations(t0, t, "empty_raw")
        result = await self.hass.async_add_executor_job(trial.calibrate, samples, t, spans)
        async with self._engine_lock:
            self.engine.adopt(result, t)
        self.model.book["last_calibration"] = t
        await self.async_save_model()
        self.last_quality = await self.async_quality(7)
        repairs.update(self)
        self._notify()
        return result

    async def async_quality(self, days: int) -> QualityReport:
        t = self.now()
        t0 = t - days * DAY_S
        await self.async_flush_history()
        labels = await self.hass.async_add_executor_job(self.history.labels, t0, t, "applied")
        events = await self.hass.async_add_executor_job(self.history.events, t0, t, None)
        inputs = QualityInputs(
            t0=t0, t1=t, labels=tuple(labels), events=tuple(events), empty_intervals=_empty_intervals(events, t)
        )
        return self.engine.quality(t, inputs)

    @contextmanager
    def holding[T: str | None](self, snapshot_id: T) -> Iterator[T]:
        held = [snapshot_id] if snapshot_id is not None else []
        self._held.extend(held)
        try:
            yield snapshot_id
        finally:
            for item in held:
                self._held.remove(item)

    def snapshot(self, reason: SnapshotReason, now: float) -> str:
        snapshot_id = self.model.snapshot(reason, now, self.model_version, self.engine.model_state()["active"])
        self.hass.async_create_task(self.store.async_save_snapshots(self.model.snapshots))
        self.schedule_save_model()
        return snapshot_id

    async def async_add_labels(self, labels: list[Label], background: bool) -> str | None:
        known = {room.id for room in self.plan.rooms}
        orphans = [label for label in labels if label.room is not None and label.room not in known]
        if orphans:
            await self.hass.async_add_executor_job(self.history.add_labels, orphans, "discarded", None)
        labels = [label for label in labels if label not in orphans]
        if not labels:
            return None
        if background and not self.settings.global_.learning:
            await self.hass.async_add_executor_job(self.history.add_labels, labels, "discarded", None)
            return None
        pending_id = ""
        for label in labels:
            pending_id = self.engine.label(label)
        await self.hass.async_add_executor_job(self.history.add_labels, labels, "pending", pending_id)
        for label in labels:
            data: dict[str, Scalar] = {
                "source": label.source,
                "kind": label.kind,
                "activity": label.activity,
                "pending_id": pending_id,
            }
            self.event("label", label.room, data, label.t0)
        await self.async_save_model()
        self._notify()
        return pending_id

    async def _async_drop_pending(self) -> None:
        pending_id = self.engine.pending_id()
        if pending_id is not None:
            await self.hass.async_add_executor_job(self.history.set_label_status, pending_id, "discarded")

    async def async_apply(self, pending_id: str, mode: Mode | None = None) -> dict[str, Any]:
        async with self._engine_lock:
            return await self._async_apply(pending_id, mode)

    async def _async_apply(self, pending_id: str, mode: Mode | None) -> dict[str, Any]:
        if pending_id != self.engine.pending_id():
            raise OutglowError("not_found", "No such proposal")
        t = self.now()
        with self.holding(self.snapshot("before_apply", t)) as snapshot_id:
            version = self.engine.apply(pending_id, t)
            await self.async_save_model()
            await self.hass.async_add_executor_job(self.history.set_label_status, pending_id, "applied")
        self.event("model_apply", None, {"pending_id": pending_id, "model_version": version})
        if mode is not None:
            await self._async_set_settings(replace(self.settings, global_=replace(self.settings.global_, mode=mode)))
        self._notify()
        return {"model_version": version, "snapshot_id": snapshot_id}

    async def async_discard(self, pending_id: str) -> dict[str, Any]:
        async with self._engine_lock:
            return await self._async_discard(pending_id)

    async def _async_discard(self, pending_id: str) -> dict[str, Any]:
        if pending_id != self.engine.pending_id():
            raise OutglowError("not_found", "No such proposal")
        self.engine.discard(pending_id)
        await self.async_save_model()
        await self.hass.async_add_executor_job(self.history.set_label_status, pending_id, "discarded")
        self.event("model_discard", None, {"pending_id": pending_id})
        self._notify()
        return {"model_version": self.model_version, "snapshot_id": None}

    async def async_rollback(self, snapshot_id: str) -> dict[str, Any]:
        target = self.model.find_snapshot(snapshot_id)
        if self.rolling_back is not None:
            raise OutglowError("busy", "A rollback is running")
        self.rolling_back = snapshot_id
        try:
            async with self._engine_lock:
                t = self.now()
                with self.holding(self.snapshot("before_rollback", t)) as before:
                    await self._async_drop_pending()
                    version = self.engine.restore(target, t)
                    await self.async_save_model()
        finally:
            self.rolling_back = None
        self.event("model_rollback", None, {"snapshot_id": snapshot_id, "model_version": version})
        self._notify()
        return {"model_version": version, "snapshot_id": before}

    async def async_delete_snapshots(self, snapshot_id: str | None) -> list[dict[str, Any]]:
        held = {*self._held, *([self.rolling_back] if self.rolling_back is not None else [])}
        self.model.delete(snapshot_id, held)
        await self.store.async_save_snapshots(self.model.snapshots)
        self._notify()
        return self.model.snapshot_list()

    async def async_reset_learning(self, room: str | None = None) -> dict[str, Any]:
        async with self._engine_lock:
            return await self._async_reset_learning(room)

    async def _async_reset_learning(self, room: str | None) -> dict[str, Any]:
        t = self.now()
        with self.holding(self.snapshot("before_reset", t)) as before:
            if room is None:
                await self._async_drop_pending()
            version = self.engine.reset(t, room)
            await self.async_save_model()
        self._notify()
        return {"model_version": version, "snapshot_id": before}

    async def async_save_plan(self, rev: int, plan: Plan) -> int:
        async with self._engine_lock:
            return await self._async_save_plan(rev, plan)

    async def _async_save_plan(self, rev: int, plan: Plan) -> int:
        if rev != self.plan.rev:
            raise OutglowError("rev_conflict", "The plan was saved elsewhere; reload it")
        ids = {room.id for room in plan.rooms}
        reused = sorted(ids & set(self.plan.retired_rooms))
        if reused:
            raise OutglowError("invalid_format", f"Room id {reused[0]} belonged to a removed room")
        removed = {room.id for room in self.plan.rooms} - ids
        before = {room.id: room for room in self.plan.rooms}
        retired = tuple(sorted({*self.plan.retired_rooms, *plan.retired_rooms, *removed}))
        saved = replace(plan, rev=rev + 1, retired_rooms=retired)
        settings = self._complete_settings(self.settings, saved)
        old = self.engine
        fresh, stale = await self.hass.async_add_executor_job(_successor, old.carry(), saved, settings)
        await self.store.async_save_plan(saved)
        held = self.model.snapshot("before_reset", self.now(), self.model_version, stale) if stale else None
        with self.holding(held):
            pending_id = old.pending_id()
            self.plan, self.settings = saved, settings
            self.engine = fresh.inherit(old)
            self.engine.context(self._context(self.now()))
            await self.store.async_save_settings(self.settings)
            if held is not None:
                await self.store.async_save_snapshots(self.model.snapshots)
            if removed:
                await self.hass.async_add_executor_job(self.history.discard_rooms, sorted(removed))
            if pending_id is not None and self.engine.pending_id() is None:
                await self.hass.async_add_executor_job(self.history.set_label_status, pending_id, "discarded")
                await self.async_save_model()
        self._remove_rooms(removed)
        self._sync_room_devices(before)
        async_dispatcher_send(self.hass, f"{SIGNAL_PLAN}_{self.entry.entry_id}")
        repairs.update(self)
        self.tick()
        return self.plan.rev

    def _sync_room_devices(self, before: dict[str, Room]) -> None:
        dev_reg = dr.async_get(self.hass)
        areas = ar.async_get(self.hass)
        entry_id = self.entry.entry_id
        for room in self.plan.rooms:
            identifier = (DOMAIN, f"{entry_id}_{room.id}")
            device = dev_reg.async_get_device_by_identifier(identifier, entry_id)
            old = before.get(room.id)
            if device is None:
                device = dev_reg.async_get_or_create(
                    config_entry_id=entry_id,
                    identifiers={identifier},
                    name=f"{room.name} · Outglow",
                    manufacturer="Outglow",
                    model="Room",
                )
            elif old is not None and old.name != room.name:
                dev_reg.async_update_device(device.id, name=f"{room.name} · Outglow")
            moved = old is not None and old.area_id != room.area_id
            area = areas.async_get_area(room.area_id) if room.area_id is not None else None
            if area is not None and (moved or device.area_id is None):
                dev_reg.async_update_device(device.id, area_id=area.id)

    def _remove_rooms(self, rooms: set[str]) -> None:
        if not rooms:
            return
        ent_reg = er.async_get(self.hass)
        dev_reg = dr.async_get(self.hass)
        doomed = {f"{self.entry.entry_id}_{room}_{key}" for room in rooms for key in ROOM_KEYS}
        for entry in er.async_entries_for_config_entry(ent_reg, self.entry.entry_id):
            if entry.unique_id in doomed:
                ent_reg.async_remove(entry.entity_id)
        for room in rooms:
            device = dev_reg.async_get_device_by_identifier(
                (DOMAIN, f"{self.entry.entry_id}_{room}"), self.entry.entry_id
            )
            if device is not None:
                dev_reg.async_remove_device(device.id)
            self._occupied.pop(room, None)

    async def async_set_settings(self, settings: Settings) -> Settings:
        async with self._engine_lock:
            return await self._async_set_settings(settings)

    async def _async_set_settings(self, settings: Settings) -> Settings:
        old = self.settings
        self.settings = self._complete_settings(settings)
        await self.store.async_save_settings(self.settings)
        self.engine.reconfigure(self.settings)
        if old.global_.tick_s != self.settings.global_.tick_s:
            self._schedule_tick()
        self._track_persons()
        self._notify()
        return self.settings

    async def async_update_settings(self, change: Callable[[Settings], Settings]) -> Settings:
        async with self._engine_lock:
            return await self._async_set_settings(change(self.settings))

    async def async_save_runtime(self) -> None:
        await self.store.async_save_runtime(self.sessions.runtime())

    async def async_feedback(self, room: str, kind: str, when: float) -> str | None:
        t_on = await self._async_last_motion_on(room, when)
        if kind == "missed":
            t0, t1 = when - MANUAL_LIGHT_BEFORE_S, when + MANUAL_LIGHT_AFTER_S
        elif t_on is not None:
            t0, t1 = t_on - FEEDBACK_ON_BEFORE_S, t_on + FEEDBACK_ON_AFTER_S
        else:
            t0, t1 = when - FEEDBACK_DEFAULT_S, when
        label_kind: LabelKind = "empty" if kind == "false_alarm" else "room"
        label = Label(t0=t0, t1=t1, kind=label_kind, room=room, source="feedback", weight=LABEL_WEIGHTS["feedback"])
        event_kind: EventKind = "false_alarm" if kind == "false_alarm" else "missed" if kind == "missed" else "correct"
        self.event(event_kind, room, {"source": "feedback"}, when)
        self._notify()
        return await self.async_add_labels([label], background=True)

    async def _async_last_motion_on(self, room: str, when: float) -> float | None:
        await self.async_flush_history()
        events = await self.hass.async_add_executor_job(
            self.history.events, when - FEEDBACK_LOOKBACK_S, when, ["motion_on"]
        )
        starts = [event.t for event in events if event.room == room]
        if starts:
            return max(starts)
        if self.frame is not None:
            rf = self.frame.rooms.get(room)
            if rf is not None and rf.since is not None and rf.since <= when and when - rf.since <= FEEDBACK_LOOKBACK_S:
                return rf.since
        return None

    def bulb_infos(self) -> list[dict[str, Any]]:
        frame = self.frame
        flags = {(d.rx, d.tx): d.flags for d in frame.directions} if frame else {}
        out: list[dict[str, Any]] = []
        for device in self.devices.bulbs():
            state = device.state
            raw = state.get("motion_links")
            links: list[Any] = raw if isinstance(raw, list) else []
            lines = []
            for link in links:
                tx = str(link.get("ieee_address") or "").lower() if isinstance(link, dict) else ""
                if not tx.startswith("0x") or len(tx) != 18:
                    continue
                signal = link.get("signal")
                signal = signal if isinstance(signal, int) and not isinstance(signal, bool) and signal != 0 else None
                direction = flags.get((device.ieee, tx), ())
                lines.append(
                    {
                        "tx": tx,
                        "signal": signal,
                        "frozen": "frozen" in direction,
                        "weak": "weak" in direction or (signal is not None and signal <= -88),
                    }
                )
            out.append(
                {
                    "ieee": device.ieee,
                    "name": device.name,
                    "model": device.model,
                    "available": device.available,
                    "sensing": self.devices.sensing(device),
                    "probes": _number(state.get("motion_probes")),
                    "activity_rate": self.devices.activity_rate(device.ieee),
                    "sensitivity": _number(state.get("motion_sensitivity")),
                    "auto_calibration": _bool(state.get("motion_auto_calibration")),
                    "light_entity": self.light_entity(device.ieee),
                    "area_id": self.bulb_areas.get(device.ieee),
                    "gate_duty_24h": self.gate_duty(device.ieee),
                    "lines": sorted(lines, key=lambda line: line["tx"]),
                }
            )
        return out

    def settings_json(self) -> dict[str, Any]:
        data = to_json(self.settings)
        assert isinstance(data, dict)
        return data

    def decode_settings(self, data: object) -> Settings:
        return from_json(Settings, data)


def _successor(carry: Carry, plan: Plan, settings: Settings) -> tuple[Engine, dict[str, Json] | None]:
    engine = Engine.successor(carry, plan, settings)
    active = engine.model_state()["active"] if engine.foreign_rooms() else None
    return engine, active if isinstance(active, dict) else None


def _number(value: object) -> int | float | None:
    return value if isinstance(value, int | float) and not isinstance(value, bool) else None


def _bool(value: object) -> bool | None:
    return value if isinstance(value, bool) else None


def _empty_intervals(events: list[HistoryEvent], t: float) -> tuple[tuple[float, float], ...]:
    out: list[tuple[float, float]] = []
    start: float | None = None
    for event in events:
        if event.kind == "house_empty" and start is None:
            start = event.t
        elif event.kind == "house_occupied" and start is not None:
            out.append((start, event.t))
            start = None
    if start is not None:
        out.append((start, t))
    return tuple(out)
