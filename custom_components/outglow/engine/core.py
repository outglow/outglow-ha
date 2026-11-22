import math
from collections import deque
from collections.abc import Callable, Collection, Iterable, Iterator, Sequence
from dataclasses import dataclass, replace
from typing import Self

from . import calibrate as cal
from . import quality as qual
from .cfar import Basis, Cfar, basis
from .defaults import (
    A_ON_START,
    ASYM_MIN_H,
    ASYM_PER_H,
    ASYM_RATIO,
    CFAR_REFRESH_S,
    COVERAGE_GOOD,
    COVERAGE_WEAK,
    EMPTY_MARGIN_S,
    FIXED_LEVEL,
    IDLE_GAP_S,
    MODEL_FORMAT,
    N_ON,
    QUIET_BACKGROUND_P,
    QUIET_BACKGROUND_S,
    QUIET_BACKGROUND_WEIGHT,
    SOFT_EMPTY_WEIGHT,
    TOP_PAIRS,
    TRAIL_LENGTH,
)
from .emission import Emission, PairParams, code_of, information, params, states_of
from .ingest import DirSample, Ingest
from .learn import CENS, CENSORED, EXCEED, NO_DATA, NONE, QUIET, Learner, TickRecord
from .model import Model, RoomCal
from .model import from_json as model_from_json
from .model import to_json as model_to_json
from .pairs import PairLayer, PairTick
from .rooms import Rooms, posterior, state_prior
from .rules import RuleConfig, Rules
from .topology import Direction, Pair, Topology, build
from .types import (
    CalibrationResult,
    CalibrationStatus,
    Context,
    Coverage,
    DirectionFlag,
    DirectionFrame,
    DirectionState,
    Frame,
    Header,
    HouseEmpty,
    Json,
    Label,
    LightEvent,
    Mode,
    Observation,
    PairFrame,
    PairObservation,
    Plan,
    QualityInputs,
    QualityReport,
    Record,
    RoomCalibration,
    RoomFrame,
    RoomSettings,
    Settings,
    Status,
)

STATE_CODES: dict[DirectionState, int] = {"quiet": QUIET, "exceed": EXCEED, "none": NO_DATA, "quiet_censored": CENS}


@dataclass(frozen=True, slots=True)
class Options:
    mode: Mode | None = None
    agree: bool = True
    veto: bool = True
    explain: bool = True
    learned: bool = True
    cfar: bool = True
    geometric: bool = True
    firmware: bool | None = None
    rules: RuleConfig | None = None


@dataclass(frozen=True, slots=True)
class Carry:
    topology: Topology
    active: Model
    records: tuple[TickRecord, ...]
    recorded: int
    weak: frozenset[Direction] = frozenset()


@dataclass(frozen=True, slots=True)
class Derived:
    model: Model
    weak: frozenset[Pair]
    params: dict[Pair, PairParams]
    emission: Emission
    coverage: dict[str, float]
    pair_weight: dict[Pair, float]
    cfar: Basis
    topo: Topology
    source: dict[str, Json] | None = None


@dataclass(frozen=True, slots=True)
class ModelCopy:
    active: Model
    pending: Model | None
    pending_seq: int
    pending_created: float

    def state(self) -> dict[str, Json]:
        return _state(self.active, self.pending, self.pending_seq, self.pending_created)

    def active_state(self) -> dict[str, Json]:
        return {"active": model_to_json(self.active)}


@dataclass(frozen=True, slots=True)
class _Lesson:
    t: float
    rec: TickRecord | None
    seq: int
    prev: TickRecord | None
    weight: float


@dataclass(slots=True)
class _Tick:
    t: float
    samples: dict[Direction, DirSample]
    z: dict[Direction, float | None]
    pairs: PairTick
    codes: tuple[int | None, ...]


class Engine:
    def __init__(
        self, plan: Plan, settings: Settings, model: dict[str, Json] | None = None, options: Options | None = None
    ) -> None:
        self._plan = plan
        self._settings = settings
        self._options = options or Options()
        self._topo = build(plan)
        self._mode: Mode = self._options.mode or settings.global_.mode
        self._firmware = settings.global_.firmware_channel if self._options.firmware is None else self._options.firmware
        raw = model or {}
        nested = isinstance(raw.get("active"), dict)
        active = raw.get("active") if nested else raw
        pending = raw.get("pending") if nested else None
        seq = raw.get("pending_seq") if nested else 0
        self._active = model_from_json(active if isinstance(active, dict) else None)
        self._pending = model_from_json(pending) if isinstance(pending, dict) else None
        self._pending_seq = seq if isinstance(seq, int) and not isinstance(seq, bool) else 0
        self._pending_created = _num_or(raw.get("pending_created"), 0.0)
        self._pending_rooms: frozenset[str] | None = None
        self._ingest = Ingest(self._topo)
        self._cfar = Cfar(self._topo.directions, None if self._options.cfar else FIXED_LEVEL)
        self._pairs = PairLayer(self._topo, self._options.agree, self._options.veto)
        self._rules = Rules(self._topo, self._options.rules)
        self._states = states_of(self._topo.rooms)
        self._learner = Learner(self._topo, settings.global_.tick_s)
        self._room_settings = {r: settings.rooms.get(r, RoomSettings()) for r in self._topo.rooms}
        self._rooms = Rooms(self._topo, {r: s.reaction for r, s in self._room_settings.items()}, {})
        self._hold = {r: s.hold_time_s for r, s in self._room_settings.items()}
        self._exceed: dict[Direction, bool] = {}
        self._house: HouseEmpty = "unknown"
        self._labels: list[Label] = []
        self._refreshed = -math.inf
        self._empty_run = 0
        self._quiet_run = 0
        self._last: _Tick | None = None
        self._trail: deque[tuple[str, float]] = deque(maxlen=TRAIL_LENGTH)
        self.stats = qual.Stats.fresh(self._topo)
        self._carried: int | None = None
        self._staged: Derived | None = None
        self._held: list[_Lesson] | None = None
        self._load(self._active, self.derive(self._active, self.weak_pairs()))

    def reconfigure(self, settings: Settings) -> None:
        self._settings = settings
        self._mode = self._options.mode or settings.global_.mode
        self._firmware = settings.global_.firmware_channel if self._options.firmware is None else self._options.firmware
        self._learner.retime(settings.global_.tick_s)
        self._room_settings = {r: settings.rooms.get(r, RoomSettings()) for r in self._topo.rooms}
        self._rooms.reaction = {r: s.reaction for r, s in self._room_settings.items()}
        self._hold = {r: s.hold_time_s for r, s in self._room_settings.items()}
        self._noisy = self._asymmetric(self._active)

    def carry(self) -> Carry:
        weak = frozenset(d for d in self._topo.directions if self._ingest.weak(d))
        return Carry(self._topo, self._active.clone(), tuple(self._learner.buffer), self._learner.recorded, weak)

    @classmethod
    def successor(cls, carry: Carry, plan: Plan, settings: Settings) -> Self:
        engine = cls(plan, settings, {"active": model_to_json(carry.active)})
        engine._learner.adopt(carry.topology, carry.records)
        engine._carried = carry.recorded
        foreign = engine.foreign_rooms()
        if foreign:
            weak = frozenset(p for p in engine._topo.pairs if p in carry.weak or (p[1], p[0]) in carry.weak)
            engine._staged = engine.derive(_forget(engine._active.clone(), foreign), weak)
        return engine

    def inherit(self, old: Engine, t: float | None = None) -> Self:
        self._ingest.inherit(old._ingest)
        self._pairs.inherit(old._pairs)
        self._rooms.inherit(old._rooms)
        directions = set(self._topo.directions)
        self._exceed = {d: on for d, on in old._exceed.items() if d in directions}
        self._house = old._house
        self._labels = [lb for lb in old._labels if lb.room is None or lb.room in self._rooms.state]
        self._trail.extend(item for item in old._trail if item[0] in self._rooms.state)
        self._learner.inherit(old._learner, self._carried)
        self._carried = None
        self._pending = old._pending
        self._pending_seq = old._pending_seq
        self._pending_created = old._pending_created
        self._pending_rooms = old._pending_rooms
        if _same_shape(old._topo, self._topo):
            self.stats = old.stats
            self._empty_run = old._empty_run
            self._quiet_run = old._quiet_run
        foreign = self.foreign_rooms()
        _forget(self._active, foreign)
        staged, self._staged = self._staged, None
        if foreign and t is not None:
            self._promote(self._active, t, staged)
        if self._pending is not None:
            _forget(self._pending, set(_model_rooms(self._pending)) - set(self._topo.rooms))
        learned = self._pending_rooms is None or not self._pending_rooms.isdisjoint(self._topo.rooms)
        if not self._labels and not learned:
            self._pending = None
        return self

    def foreign_rooms(self) -> frozenset[str]:
        return frozenset(_model_rooms(self._active)) - frozenset(self._topo.rooms)

    @property
    def topology(self) -> Topology:
        return self._topo

    @property
    def mode(self) -> Mode:
        return self._mode

    def derive(self, model: Model, weak: frozenset[Pair]) -> Derived:
        topo = self._topo
        pair_params = params(topo, model, weak.__contains__, self._options.geometric, self._options.learned)
        emission = Emission(topo, pair_params, self._states, binary=not self._options.agree)
        info = {p: [information(pair_params[p], r) for r in topo.rooms] for p in topo.pairs}
        coverage = {r: sum(info[p][i] for p in topo.pairs) for i, r in enumerate(topo.rooms)}
        weight = {p: round(min(1.0, max(info[p], default=0.0)), 3) for p in topo.pairs}
        cfar = basis(topo.directions, model, self._cfar.fixed)
        return Derived(model, weak, pair_params, emission, coverage, weight, cfar, topo)

    def derive_state(self, active: dict[str, Json], weak: frozenset[Pair]) -> Derived:
        return replace(self.derive(model_from_json(active), weak), source=active)

    def weak_pairs(self) -> frozenset[Pair]:
        return frozenset(p for p in self._topo.pairs if self._ingest.weak(p) or self._ingest.weak((p[1], p[0])))

    def pending_model(self) -> Model | None:
        return None if self._pending is None else self._pending.clone()

    def reset_model(self, room: str | None = None) -> Model:
        return Model() if room is None else _forget(self._active.clone(), {room})

    def _load(self, model: Model, ready: Derived) -> None:
        self._params = ready.params
        self._emission = ready.emission
        self._coverage = ready.coverage
        self._pair_weight = ready.pair_weight
        self._cfar.load(ready.cfar)
        self._rooms.a_on = {r: model.rooms[r].a_on if r in model.rooms else A_ON_START for r in self._topo.rooms}
        self._noisy = self._asymmetric(model)
        self._refreshed = -math.inf

    def _asymmetric(self, model: Model) -> frozenset[Direction]:
        hours = model.bg_ticks * self._settings.global_.tick_s / 3600
        if hours < ASYM_MIN_H:
            return frozenset()
        rate = {d: model.bg_onsets.get(d, 0.0) / hours for d in self._topo.directions}
        return frozenset(d for d, r in rate.items() if r >= ASYM_PER_H and r >= ASYM_RATIO * rate[(d[1], d[0])])

    def observe(self, obs: Observation) -> None:
        self._ingest.observe(obs)

    def context(self, ctx: Context) -> None:
        self._ingest.set_offline(ctx.offline)
        self._ingest.set_cfar(ctx.cfar)
        self._house = ctx.house_empty
        for event in ctx.light_events:
            self.light(event)

    def light(self, event: LightEvent) -> None:
        self._ingest.light(event.ieee, event.t)

    def label(self, label: Label) -> str:
        self._labels.append(label)
        self._ensure_pending(label.t1)
        return f"p-{self._active.version + 1:04d}-{self._pending_seq:04d}"

    def feed(self, record: Record) -> Self:
        match record:
            case Observation():
                self.observe(record)
            case Context():
                self.context(record)
            case LightEvent():
                self.light(record)
            case Label():
                self._labels.append(record)
            case Header() | Frame():
                pass
        return self

    def advance(self, t: float) -> None:
        if not self._settings.global_.sensing:
            return
        if t - self._refreshed >= CFAR_REFRESH_S:
            self._cfar.refresh(self._ingest.signal)
            self._refreshed = t
        gates = self._ingest.gates(t)
        samples = self._ingest.tick(t, gates)
        raw: dict[Direction, DirectionState] = {}
        z: dict[Direction, float | None] = {}
        for d, sample in samples.items():
            state, z[d] = self._cfar.state(d, sample, self._exceed.get(d, False))
            if self._firmware and state == "quiet" and self._ingest.motion(d):
                state = "exceed"
            raw[d] = state
            self._exceed[d] = state == "exceed"
        tick = self._pairs.step(t, raw, self._noisy)
        codes = tuple(code_of(tick.obs[p]) for p in self._topo.pairs)
        self._last = _Tick(t, samples, z, tick, codes)
        before = {r: s.motion for r, s in self._rooms.state.items()}
        if self._mode == "rules":
            self._rules.live(self._ingest.delivering)
            zones = self._rules.zones(self._ingest.motion)
            self._rooms.decide(t, {r: 1.0 if on else 0.0 for r, on in zones.items()}, self._house, self._hold, True)
        else:
            self._rooms.decide(t, self._infer(t, codes), self._house, self._hold, False)
        for r, s in self._rooms.state.items():
            if s.motion and not before[r]:
                self._trail.append((r, t))
        self._record(t, tick, samples, codes)
        self.stats.add(self._topo, t, gates, samples, tick, self._rooms.state, self._ingest.messages)
        self._process_labels(t)

    def _infer(self, t: float, codes: tuple[int | None, ...]) -> dict[str, float]:
        if not self._topo.rooms:
            return {}
        q = self._rooms.predict(t)
        ll = self._emission.loglik(codes)
        if self._options.explain:
            return posterior(state_prior(q, self._states), ll, self._states, self._topo.rooms)
        off = ll[self._states.index(frozenset())]
        out = {}
        for r in self._topo.rooms:
            on = ll[self._states.index(frozenset((r,)))]
            out[r] = posterior([1 - q[r], q[r]], [off, on], (frozenset(), frozenset((r,))), (r,))[r]
        return out

    def _record(
        self, t: float, tick: PairTick, samples: dict[Direction, DirSample], codes: tuple[int | None, ...]
    ) -> None:
        levels = bytes(
            CENSORED if s.censored else NONE if s.level is None else min(s.level, 250) for s in samples.values()
        )
        states = bytes(STATE_CODES[tick.states[d]] for d in self._topo.directions)
        rec = TickRecord(
            t=t,
            levels=levels,
            states=states,
            codes=bytes(NONE if c is None else c for c in codes),
            p=tuple(self._rooms.state[r].p for r in self._topo.rooms),
            empty=self._house,
        )
        prev = self._learner.buffer[-1] if self._learner.buffer else None
        self._learner.record(rec)
        self._empty_run = (
            self._empty_run + 1 if self._house in ("yes", "soft") and self._settings.global_.learning else 0
        )
        if not self._settings.global_.learning:
            return
        margin = max(1, round(EMPTY_MARGIN_S / self._settings.global_.tick_s))
        if self._empty_run > 2 * margin:
            target = self._learner.buffer[-margin - 1]
            weight = 1.0 if target.empty == "yes" else SOFT_EMPTY_WEIGHT
            self._teach(_Lesson(t, None, self._learner.recorded - margin - 1, None, weight))
        quiet = self._house not in ("yes", "soft") and all(p < QUIET_BACKGROUND_P for p in rec.p)
        self._quiet_run = self._quiet_run + 1 if quiet else 0
        if (
            self._settings.global_.quiet_background
            and self._quiet_run * self._settings.global_.tick_s >= QUIET_BACKGROUND_S
        ):
            self._teach(_Lesson(t, rec, 0, prev, QUIET_BACKGROUND_WEIGHT))

    def _teach(self, lesson: _Lesson) -> None:
        if self._held is not None:
            self._held.append(lesson)
            return
        model = self._ensure_pending(lesson.t)
        if lesson.rec is None:
            self._learner.empty_tick(model, lesson.seq, lesson.weight)
        else:
            self._learner.background(model, lesson.rec, lesson.prev, lesson.weight)
        self._touch(None)

    def hold_background(self) -> None:
        self._held = [] if self._held is None else self._held

    def release_background(self) -> None:
        held, self._held = self._held or [], None
        for lesson in held:
            self._teach(lesson)

    def _process_labels(self, t: float) -> None:
        ready = [lb for lb in self._labels if lb.t1 <= t]
        self._labels = [lb for lb in self._labels if lb.t1 > t]
        for lb in ready:
            if self._learner.label(self._ensure_pending(t), lb):
                self._touch(lb.room if lb.kind == "room" and lb.activity != "still" else None)

    def _ensure_pending(self, t: float) -> Model:
        if self._pending is None:
            self._pending = self._active.clone()
            self._pending_seq += 1
            self._pending_created = t
            self._pending_rooms = frozenset()
        return self._pending

    def _touch(self, room: str | None) -> None:
        if self._pending_rooms is not None:
            self._pending_rooms = None if room is None else self._pending_rooms | {room}

    def tick(self, t: float) -> Frame:
        self.advance(t)
        if not self._settings.global_.sensing or self._last is None or self._last.t != t:
            return Frame(
                t=t,
                status=self._status(),
                model_version=self._active.version,
                rooms={r: RoomFrame(coverage=self._coverage_class(r)) for r in self._topo.rooms},
                gates=self._ingest.gates(t),
            )
        return self._frame(self._last)

    def rooms_now(self) -> dict[str, tuple[float, bool, bool]]:
        t = self._last.t if self._last is not None else 0.0
        return {r: (s.p, s.motion, self._rooms.occupied(r, t, self._hold[r])) for r, s in self._rooms.state.items()}

    def _coverage_class(self, room: str) -> Coverage:
        c = self._coverage[room]
        return "good" if c >= COVERAGE_GOOD else "weak" if c >= COVERAGE_WEAK else "none"

    def _status(self) -> Status:
        if not self._settings.global_.sensing:
            return "paused"
        if any(g == "offline" for g in self._ingest.gates(self._last.t if self._last else 0.0).values()):
            return "degraded"
        return "ready" if any(level.ready for level in self._cfar.levels.values()) else "learning"

    def _frame(self, tick: _Tick) -> Frame:
        t = tick.t
        directions = []
        for d in self._topo.directions:
            sample = tick.samples[d]
            state = tick.pairs.states[d]
            flags: list[DirectionFlag] = list(sample.flags)
            if d in self._noisy:
                flags.append("asymmetric_noisy")
            if d[0] in tick.pairs.vetoed_rx:
                flags.append("vetoed")
            o = tick.pairs.obs[(min(d), max(d))]
            if state == "exceed" and o.obs == 1:
                flags.append("single_direction" if o.single else "one_sided")
            directions.append(
                DirectionFrame(rx=d[0], tx=d[1], level=sample.level, z=tick.z[d], state=state, flags=tuple(flags))
            )
        pairs = []
        for p in self._topo.pairs:
            value = tick.pairs.obs[p].obs
            obs: PairObservation | None = None if value is None else (2 if value == 2 else 1 if value == 1 else 0)
            pairs.append(PairFrame(a=p[0], b=p[1], obs=obs, weight=self._pair_weight[p]))
        rooms = {}
        for r, s in self._rooms.state.items():
            top: tuple[tuple[str, str], ...] = ()
            if self._mode == "bayes" and s.p > 0.05:
                top = tuple(p for v, p in self._emission.contribution(tick.codes, r)[:TOP_PAIRS] if v > 0)
            rooms[r] = RoomFrame(
                p=round(s.p, 4),
                motion=s.motion,
                occupied=self._rooms.occupied(r, t, self._hold[r]),
                since=s.since,
                coverage=self._coverage_class(r),
                top_pairs=top,
            )
        xy = {r: (round(c[0], 2), round(c[1], 2)) for r, c in self._topo.centres.items() if rooms[r].motion}
        return Frame(
            t=t,
            status=self._status(),
            model_version=self._active.version,
            directions=tuple(directions),
            pairs=tuple(pairs),
            rooms=rooms,
            veto=tick.pairs.veto,
            gates=self._ingest.gates(t),
            trail=tuple(self._trail),
            illustrative_xy=xy,
        )

    def calibrate(
        self, empty_samples: Iterable[Observation], t: float, intervals: Sequence[tuple[float, float]] | None = None
    ) -> CalibrationResult:
        trackers = {r: cal.Peaks(N_ON[self._room_settings[r].reaction]) for r in self._topo.rooms}
        span = _Span()
        for p in self._replay_p(span.watch(empty_samples)):
            for r, value in p.items():
                trackers[r].push(value)
        hours = span.hours() if intervals is None else sum(max(0.0, b - a) for a, b in intervals) / 3600
        model = self._pending or self._active
        rooms = {}
        for r in self._topo.rooms:
            before = self._rooms.a_on[r]
            budget = self._room_settings[r].false_alarm_budget
            a_on, rate = cal.choose(trackers[r].result(), hours, budget, before)
            detection = cal.detection(model.entries.get(r, []), a_on)
            status: CalibrationStatus = "uncertain" if rate is None else "unchanged" if a_on == before else "ok"
            rooms[r] = RoomCalibration(
                a_on=a_on,
                previous_a_on=before,
                false_per_day=rate,
                detection=detection,
                empty_hours=hours,
                status=status,
            )
        result = CalibrationResult(t=t, rooms=rooms)
        self.adopt(result, t)
        return result

    def adopt(self, result: CalibrationResult, t: float) -> None:
        mine = {
            r: RoomCal(a_on=c.a_on, false_per_day=c.false_per_day, detection=c.detection)
            for r, c in result.rooms.items()
            if r in self._topo.rooms
        }
        for r, c in mine.items():
            if c.a_on == self._rooms.a_on[r]:
                self._active.rooms[r] = replace(c)
        current = self._pending or self._active
        moved = any(c.a_on != (current.rooms[r].a_on if r in current.rooms else A_ON_START) for r, c in mine.items())
        if self._pending is None and not moved:
            return
        self._ensure_pending(t).rooms.update(mine)
        self._touch(None)

    def _replay_p(self, samples: Iterable[Observation]) -> Iterator[dict[str, float]]:
        settings = replace(self._settings, global_=replace(self._settings.global_, learning=False, mode="bayes"))
        engine = Engine(
            self._plan, settings, {"active": model_to_json(self._active)}, replace(self._options, mode="bayes")
        )
        for t, batch in _bursts(samples, settings.global_.tick_s):
            for obs in batch:
                engine.observe(obs)
            engine.advance(t)
            yield {r: p for r, (p, _, _) in engine.rooms_now().items()}

    def quality(self, t: float, history: QualityInputs) -> QualityReport:
        return qual.report(
            self._plan, self._topo, self._params, self._active, self.stats, self._ingest, t, history, self._settings
        )

    def summary(self) -> dict[str, Json]:
        pending: Json = None
        if self._pending is not None:
            changes: list[Json] = []
            for r in self._topo.rooms:
                before = self._active.rooms.get(r)
                after = self._pending.rooms.get(r)
                changes.append(
                    {
                        "room": r,
                        "a_on_before": before.a_on if before else A_ON_START,
                        "a_on_after": after.a_on if after else A_ON_START,
                        "detection_before": before.detection if before else None,
                        "detection_after": after.detection if after else None,
                        "false_per_day_before": before.false_per_day if before else None,
                        "false_per_day_after": after.false_per_day if after else None,
                    }
                )
            labels: dict[str, Json] = {
                k: v - self._active.labels.get(k, 0)
                for k, v in sorted(self._pending.labels.items())
                if v - self._active.labels.get(k, 0) > 0
            }
            pending = {
                "pending_id": self.pending_id(),
                "created": self._pending_created,
                "labels": labels,
                "rooms": changes,
            }
        return {
            "model_version": self._active.version,
            "updated": self._active.updated,
            "learning": self._settings.global_.learning,
            "empty_house_hours": round(self._active.empty_s / 3600, 3),
            "labels": dict(sorted(self._active.labels.items())),
            "pending": pending,
        }

    def applied_empty_s(self) -> float:
        return self.empty_preview()()

    def empty_preview(self) -> Callable[[], float]:
        model = (self._active if self._pending is None else self._pending).clone()
        learner = self._learner.copy()
        labels = tuple(self._labels)

        def run() -> float:
            for label in labels:
                learner.label(model, label)
            return model.empty_s

        return run

    def pending_id(self) -> str | None:
        return None if self._pending is None else f"p-{self._active.version + 1:04d}-{self._pending_seq:04d}"

    def apply(self, pending_id: str, t: float, ready: Derived | None = None) -> int:
        if self._pending is None or pending_id != self.pending_id():
            raise KeyError(pending_id)
        model, self._pending = self._pending, None
        return self._promote(model, t, ready)

    def reset(self, t: float, room: str | None = None, ready: Derived | None = None) -> int:
        if room is None:
            self._pending = None
        elif self._pending is not None:
            _forget(self._pending, {room})
        return self._promote(self.reset_model(room), t, ready)

    def restore(self, active: dict[str, Json], t: float, ready: Derived | None = None) -> int:
        self._pending = None
        model = ready.model if ready is not None and ready.source is active else model_from_json(active)
        return self._promote(model, t, ready)

    def _promote(self, model: Model, t: float, ready: Derived | None = None) -> int:
        derived = self._fitting(model, ready)
        model.version = self._active.version + 1
        model.updated = t
        self._active = model
        self._load(model, derived)
        return model.version

    def _fitting(self, model: Model, ready: Derived | None) -> Derived:
        return ready if ready is not None and self._fits(model, ready) else self.derive(model, self.weak_pairs())

    def _fits(self, model: Model, ready: Derived) -> bool:
        return ready.topo is self._topo and ready.weak == self.weak_pairs() and ready.model == model

    def pending_fits(self, ready: Derived) -> bool:
        return self._pending is not None and self._fits(self._pending, ready)

    def discard(self, pending_id: str) -> None:
        if self._pending is None or pending_id != self.pending_id():
            raise KeyError(pending_id)
        self._pending = None

    def model_state(self) -> dict[str, Json]:
        return _state(self._active, self._pending, self._pending_seq, self._pending_created)

    def model_copy(self) -> ModelCopy:
        pending = None if self._pending is None else self._pending.clone()
        return ModelCopy(self._active.clone(), pending, self._pending_seq, self._pending_created)

    @classmethod
    def replay(
        cls, records: Iterable[Record], plan: Plan, settings: Settings, options: Options | None = None
    ) -> Iterator[Frame]:
        engine = cls(plan, settings, options=options)
        step = settings.global_.tick_s
        index: int | None = None
        for record in records:
            t = _record_time(record)
            if t is None:
                continue
            if index is None:
                index = math.ceil(t / step)
            while index * step <= t:
                yield engine.tick(index * step)
                index += 1
            engine.feed(record)
        if index is not None:
            yield engine.tick(index * step)


class _Span:
    def __init__(self) -> None:
        self.first: float | None = None
        self.last: float | None = None

    def watch(self, samples: Iterable[Observation]) -> Iterator[Observation]:
        for obs in samples:
            self.first = obs.t if self.first is None else self.first
            self.last = obs.t
            yield obs

    def hours(self) -> float:
        return 0.0 if self.first is None or self.last is None else (self.last - self.first) / 3600


def _bursts(samples: Iterable[Observation], step: float) -> Iterator[tuple[float, list[Observation]]]:
    items = iter(samples)
    upcoming = next(items, None)
    if upcoming is None:
        return
    k = math.ceil(upcoming.t / step)
    last = k
    while upcoming is not None or (k - last) * step < IDLE_GAP_S:
        t = k * step
        batch = []
        while upcoming is not None and upcoming.t <= t:
            batch.append(upcoming)
            upcoming = next(items, None)
        if batch:
            last = k
        yield t, batch
        if upcoming is not None and (k - last) * step >= IDLE_GAP_S and upcoming.t - t > IDLE_GAP_S:
            k = math.ceil(upcoming.t / step)
        else:
            k += 1


def _state(active: Model, pending: Model | None, seq: int, created: float) -> dict[str, Json]:
    return {
        "format": MODEL_FORMAT,
        "model_version": active.version,
        "active": model_to_json(active),
        "pending": None if pending is None else model_to_json(pending),
        "pending_seq": seq,
        "pending_created": created,
    }


def _same_shape(a: Topology, b: Topology) -> bool:
    return (a.rooms, a.bulbs, a.pairs, a.directions) == (b.rooms, b.bulbs, b.pairs, b.directions)


def _forget(model: Model, rooms: Collection[str]) -> Model:
    if rooms:
        model.emit = {k: v for k, v in model.emit.items() if k[1] not in rooms}
        model.rooms = {r: c for r, c in model.rooms.items() if r not in rooms}
        model.entries = {r: e for r, e in model.entries.items() if r not in rooms}
    return model


def _model_rooms(model: Model) -> Iterator[str]:
    yield from (room for _, room in model.emit)
    yield from model.rooms
    yield from model.entries


def _num_or(value: Json, default: float) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _record_time(record: Record) -> float | None:
    match record:
        case Header():
            return None
        case Label():
            return record.t1
        case _:
            return record.t
