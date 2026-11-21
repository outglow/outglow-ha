import math
import statistics
from dataclasses import dataclass

from .defaults import (
    ASYM_PER_H,
    ASYM_RATIO,
    CANDIDATE_RSSI_DBM,
    CANDIDATE_STEP_M,
    COVERAGE_GOOD,
    COVERAGE_WEAK,
    DETECT_WINDOW_S,
    EMPTY_ADVICE_H,
    FROZEN_ADVICE_FRAC,
    GATE_ADVICE_FRAC,
    HARD_WALL_DB,
    PARTITION_DB,
    RAISE_SENSITIVITY_TO,
    RSSI_1M_DBM,
    RSSI_SLOPE_DB,
    TOP_CANDIDATES,
)
from .emission import PairParams, information
from .ingest import DirSample, Ingest
from .model import Model
from .pairs import PairTick
from .rooms import RoomState
from .topology import HARD_WALLS, Direction, Pair, Topology, point_in_polygon, room_at, segments_cross
from .types import (
    Coverage,
    DirectionFlag,
    DirectionQuality,
    Gate,
    PairQuality,
    Plan,
    Point,
    QualityInputs,
    QualityReport,
    Recommendation,
    RoomQuality,
    Settings,
)


@dataclass(slots=True)
class Stats:
    t0: float | None
    t1: float
    ticks: int
    messages0: int
    messages: int
    rx_open: dict[str, int]
    frozen: dict[Direction, int]
    onsets: dict[Direction, int]
    prev: set[Direction]
    vetoes: dict[str, int]
    vetoed: bool

    @classmethod
    def fresh(cls, topo: Topology) -> Stats:
        return cls(
            t0=None,
            t1=0.0,
            ticks=0,
            messages0=0,
            messages=0,
            rx_open=dict.fromkeys(topo.bulbs, 0),
            frozen=dict.fromkeys(topo.directions, 0),
            onsets=dict.fromkeys(topo.directions, 0),
            prev=set(),
            vetoes=dict.fromkeys(topo.rooms, 0),
            vetoed=False,
        )

    def add(
        self,
        topo: Topology,
        t: float,
        gates: dict[str, Gate],
        samples: dict[Direction, DirSample],
        tick: PairTick,
        rooms: dict[str, RoomState],
        messages: int,
    ) -> None:
        if self.t0 is None:
            self.t0, self.messages0 = t, messages
        self.t1, self.messages = t, messages
        self.ticks += 1
        for b, g in gates.items():
            self.rx_open[b] += g == "open"
        hot = {d for d, s in tick.states.items() if s == "exceed"}
        for d, sample in samples.items():
            self.frozen[d] += "frozen" in sample.flags
        for d in hot - self.prev:
            self.onsets[d] += 1
        self.prev = hot
        if tick.veto is not None and not self.vetoed:
            for r in rooms:
                self.vetoes[r] += 1
        self.vetoed = tick.veto is not None
        for rx in tick.vetoed_rx:
            room = topo.bulb_room[rx]
            if room is not None:
                self.vetoes[room] += 1

    @property
    def hours(self) -> float:
        return 0.0 if self.t0 is None else (self.t1 - self.t0) / 3600


def coverage_class(value: float) -> Coverage:
    return "good" if value >= COVERAGE_GOOD else "weak" if value >= COVERAGE_WEAK else "none"


def _rates(topo: Topology, model: Model, stats: Stats, tick_s: float) -> dict[Direction, float]:
    bg_hours = model.bg_ticks * tick_s / 3600
    if bg_hours > 0:
        return {d: model.bg_onsets.get(d, 0.0) / bg_hours for d in topo.directions}
    hours = stats.hours
    return {d: (stats.onsets[d] / hours if hours > 0 else 0.0) for d in topo.directions}


def _room_quality(room: str, coverage: float, history: QualityInputs, days: int, vetoes: int) -> RoomQuality:
    ons = [e.t for e in history.events if e.kind == "motion_on" and e.room == room]
    in_empty = sum(any(a <= t <= b for a, b in history.empty_intervals) for t in ons)
    feedback = sum(1 for e in history.events if e.kind == "false_alarm" and e.room == room)
    segments = [
        lb
        for lb in history.labels
        if lb.kind == "room" and lb.room == room and lb.activity != "still" and lb.t1 - lb.t0 >= DETECT_WINDOW_S
    ]
    latencies = []
    for lb in segments:
        hit = [t - lb.t0 for t in ons if lb.t0 <= t <= lb.t0 + DETECT_WINDOW_S]
        if hit:
            latencies.append(min(hit))
    has_data = bool(history.empty_intervals) or feedback > 0
    return RoomQuality(
        room=room,
        false_alarms_per_day=round((in_empty + feedback) / days, 3) if has_data else None,
        entry_detection=round(len(latencies) / len(segments), 3) if segments else None,
        latency_median_s=round(statistics.median(latencies), 2) if latencies else None,
        latency_p90_s=round(_quantile(latencies, 0.9), 2) if latencies else None,
        coverage=round(coverage, 3),
        coverage_class=coverage_class(coverage),
        vetoes=vetoes,
    )


def _quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, math.ceil(q * len(ordered)) - 1)]


def predicted_rssi(plan: Plan, a: Point, b: Point) -> float:
    d = max(math.dist(a, b), 0.5)
    walls = 0
    previous = room_at(plan, a)
    for i in range(1, 25):
        s = i / 24
        here = room_at(plan, (a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])))
        walls += here != previous
        previous = here
    hard = sum(1 for w in plan.walls if w.kind in HARD_WALLS and segments_cross(a, b, w.a, w.b))
    return RSSI_1M_DBM - RSSI_SLOPE_DB * math.log10(d) - PARTITION_DB * walls - (HARD_WALL_DB - PARTITION_DB) * hard


def candidates(plan: Plan, topo: Topology, room: str, base: PairParams) -> list[tuple[float, Point]]:
    outline = next(r.outline for r in plan.rooms if r.id == room)
    xs = [p[0] for p in outline]
    ys = [p[1] for p in outline]
    out = []
    x = math.floor(min(xs) / CANDIDATE_STEP_M) * CANDIDATE_STEP_M
    while x <= max(xs):
        y = math.floor(min(ys) / CANDIDATE_STEP_M) * CANDIDATE_STEP_M
        while y <= max(ys):
            p = (round(x, 2), round(y, 2))
            if point_in_polygon(p, outline):
                gain = 0.0
                for b in topo.bulbs:
                    if predicted_rssi(plan, p, topo.bulb_xy[b]) < CANDIDATE_RSSI_DBM:
                        continue
                    other = topo.bulb_room[b]
                    theta = 0.15 if other == room else 0.45 if topo.is_adjacent(room, other) else 0.1
                    gain += information(PairParams({room: theta}, base.eta, base.eps1, base.eps2, base.beta), room)
                out.append((round(gain, 3), p))
            y += CANDIDATE_STEP_M
        x += CANDIDATE_STEP_M
    return sorted(out, key=lambda c: (-c[0], c[1]))[:TOP_CANDIDATES]


def report(
    plan: Plan,
    topo: Topology,
    pair_params: dict[Pair, PairParams],
    model: Model,
    stats: Stats,
    ingest: Ingest,
    t: float,
    history: QualityInputs,
    settings: Settings,
) -> QualityReport:
    tick_s = settings.global_.tick_s
    days = max(1, math.ceil((history.t1 - history.t0) / 86400))
    empty_h = sum(max(0.0, b - a) for a, b in history.empty_intervals) / 3600
    rate = _rates(topo, model, stats, tick_s)
    ticks = max(stats.ticks, 1)
    directions = []
    recs: list[Recommendation] = []
    for d in topo.directions:
        rev = rate[(d[1], d[0])]
        frozen = stats.frozen[d] / ticks
        flags: list[DirectionFlag] = []
        noisy = rate[d] >= ASYM_PER_H and rate[d] >= ASYM_RATIO * rev
        if noisy:
            flags.append("asymmetric_noisy")
        if ingest.weak(d):
            flags.append("weak")
        if frozen >= FROZEN_ADVICE_FRAC:
            flags.append("frozen")
        pair = (min(d), max(d))
        directions.append(
            DirectionQuality(
                rx=d[0],
                tx=d[1],
                exceed_per_h=round(rate[d], 3),
                exceed_per_day=round(rate[d] * 24, 3),
                asymmetry=round(rate[d] / rev, 3) if rev > 0 else None,
                frozen_frac=round(frozen, 4),
                signal_dbm=ingest.signal(d),
                gate_open_frac=round(stats.rx_open[d[0]] / ticks, 4),
                theta={r: round(v, 4) for r, v in pair_params[pair].theta.items()},
                flags=tuple(flags),
            )
        )
        if noisy and d not in topo.excluded:
            recs.append(
                Recommendation(
                    id=f"skip_direction:{d[0]}:{d[1]}",
                    kind="skip_direction",
                    severity="warning",
                    action="skip_direction",
                    rx=d[0],
                    tx=d[1],
                    numbers={"per_h": round(rate[d], 1), "reverse_per_h": round(rev, 1)},
                )
            )
        if frozen >= FROZEN_ADVICE_FRAC:
            recs.append(
                Recommendation(
                    id=f"frozen_direction:{d[0]}:{d[1]}",
                    kind="frozen_direction",
                    rx=d[0],
                    tx=d[1],
                    numbers={"signal_dbm": float(ingest.signal(d) or 0), "frozen_pct": round(100 * frozen, 1)},
                )
            )
    info = {p: {r: round(information(pair_params[p], r), 4) for r in topo.rooms} for p in topo.pairs}
    for b in topo.bulbs:
        open_frac = stats.rx_open[b] / ticks
        useful = max((v for p in topo.pairs if b in p for v in info[p].values()), default=0.0)
        if stats.ticks and open_frac < GATE_ADVICE_FRAC and useful >= COVERAGE_WEAK:
            recs.append(
                Recommendation(
                    id=f"raise_sensitivity:{b}",
                    kind="raise_sensitivity",
                    severity="warning",
                    action="bulb_write",
                    bulb=b,
                    numbers={"gate_open_pct": round(100 * open_frac, 2), "sensitivity": RAISE_SENSITIVITY_TO},
                )
            )
    rooms = []
    for r in topo.rooms:
        cover = sum(info[p][r] for p in topo.pairs)
        rooms.append(_room_quality(r, cover, history, days, stats.vetoes[r]))
        if cover < COVERAGE_GOOD:
            base = next(iter(pair_params.values()), PairParams({}, 0.6, 0.02, 0.001, 0.005))
            found = candidates(plan, topo, r, base)
            recs.append(
                Recommendation(
                    id=f"weak_coverage:{r}",
                    kind="weak_coverage",
                    severity="warning" if cover < COVERAGE_WEAK else "info",
                    action="show_candidates",
                    room=r,
                    numbers={
                        "coverage": round(cover, 3),
                        "pairs": float(sum(1 for p in topo.pairs if info[p][r] >= 0.05)),
                        "gain": found[0][0] if found else 0.0,
                    },
                    candidates=tuple(c[1] for c in found),
                )
            )
    lit = {topo.bulb_room[b] for b in topo.bulbs}
    for r in (r for r in topo.rooms if r not in lit):
        crossing = sum(1 for p in topo.pairs if r in topo.crossed[p])
        rules = settings.global_.mode == "rules"
        recs.append(
            Recommendation(
                id=f"no_bulbs:{r}",
                kind="no_bulbs",
                severity="warning" if rules or not crossing else "info",
                room=r,
                numbers={"crossing": float(crossing), "rules": float(rules)},
            )
        )
    if model.empty_s / 3600 < EMPTY_ADVICE_H:
        recs.append(
            Recommendation(
                id="more_empty_house",
                kind="more_empty_house",
                action="wizard",
                numbers={"minutes": round(model.empty_s / 60, 1)},
            )
        )
    hours = stats.hours
    return QualityReport(
        t=t,
        days=days,
        empty_house_hours=round(empty_h, 3),
        network_frames_per_s=round((stats.messages - stats.messages0) / (hours * 3600), 3) if hours > 0 else 0.0,
        rooms=tuple(rooms),
        directions=tuple(directions),
        pairs=tuple(PairQuality(a=p[0], b=p[1], information=info[p]) for p in topo.pairs),
        recommendations=tuple(recs),
    )
