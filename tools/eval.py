import argparse
import bisect
import json
import math
import re
import statistics
import sys
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import Engine, from_json, importer, recording
from engine.core import Options
from engine.defaults import A_OFF, DETECT_WINDOW_S, N_ON
from engine.rules import RoomRule, RuleConfig
from engine.source import classify
from engine.topology import build
from engine.types import Context, Header, Json, Label, Observation, Plan, Record, Settings
from tools import import_prototype, synth

WARMUP_S = 300.0
ESTIMATE_STALE_S = 5.0
MOVING = 0.5
Range = tuple[float, float]


@dataclass
class Data:
    plan: Plan
    records: list[Record]
    labels: list[Label]
    empty: list[Range]
    sessions: list[Range]
    estimates: list[tuple[float, str | None, float]] = field(default_factory=list)
    rules: RuleConfig | None = None


@dataclass
class Timeline:
    rooms: tuple[str, ...]
    t: list[float] = field(default_factory=list)
    p: list[tuple[float, ...]] = field(default_factory=list)
    motion: list[tuple[bool, ...]] = field(default_factory=list)


@dataclass(frozen=True)
class Spec:
    name: str
    kind: str
    options: Options = field(default_factory=Options)
    learn: bool = True


def _slug(text: str) -> str:
    return import_prototype._slug(text)


def room_ids(plan: Plan) -> dict[str, str]:
    return {_slug(r.name): r.id for r in plan.rooms} | {_slug(r.id): r.id for r in plan.rooms}


def _line_time(line: str) -> float | None:
    match = re.match(r'\{"t":\s*([0-9.]+)', line)
    return float(match.group(1)) if match else None


def _inside(t: float, ranges: Sequence[Range]) -> bool:
    return any(a <= t <= b for a, b in ranges)


def load(
    paths: Sequence[Path], plan: Plan, names: dict[str, str], windows: Sequence[Range] | None, empty: Sequence[Range]
) -> Data:
    ids = room_ids(plan)
    lines: list[str] = []
    estimates: list[tuple[float, str | None, float]] = []
    taps: list[tuple[float, str]] = []
    header: Header | None = None
    for path in paths:
        with path.open() as f:
            for line in f:
                t = _line_time(line)
                if windows is not None and t is not None and not _inside(t, windows):
                    continue
                if '"type": "estimate"' in line or '"type":"estimate"' in line:
                    row = json.loads(line)
                    room = row.get("room")
                    estimates.append(
                        (row["t"], ids.get(_slug(str(room))) if room else None, float(row.get("activity") or 0))
                    )
                    continue
                if '"event"' in line and '"truth"' in line:
                    row = json.loads(line)
                    taps.append((row["t"], str(row.get("event"))))
                lines.append(line)
    observations: list[Observation] = []
    labels: list[Label] = []
    others: list[Record] = []
    for record in recording.read(lines, names):
        if isinstance(record, Header):
            header = header or record
        elif isinstance(record, Observation):
            observations.append(record)
        elif isinstance(record, Label):
            room = ids.get(_slug(record.room)) if record.room else None
            if record.room is None or room is not None:
                labels.append(replace(record, room=room))
        else:
            others.append(record)
    if any(o.source == "unknown" for o in observations):
        observations = list(classify(observations))
    records: list[Record] = sorted([*observations, *others], key=_time)
    sessions = _sessions(taps) or _clusters([lb for lb in labels if lb.kind == "room"])
    found_empty = [(lb.t0, lb.t1) for lb in labels if lb.kind == "empty" and lb.room is None and lb.t1 - lb.t0 >= 60]
    return Data(
        plan=plan,
        records=records,
        labels=[lb for lb in labels if lb.kind == "room"],
        empty=sorted({*empty, *found_empty}),
        sessions=sessions,
        estimates=sorted(estimates),
    )


def _sessions(taps: list[tuple[float, str]]) -> list[Range]:
    out = []
    start = None
    for t, event in sorted(taps):
        if event == "start":
            start = t
        elif event == "stop" and start is not None:
            out.append((start, t))
            start = None
    return out


def _clusters(labels: list[Label], gap: float = 120.0) -> list[Range]:
    out: list[list[float]] = []
    for lb in sorted(labels, key=lambda x: x.t0):
        if out and lb.t0 - out[-1][1] <= gap:
            out[-1][1] = max(out[-1][1], lb.t1)
        else:
            out.append([lb.t0, lb.t1])
    return [(a, b) for a, b in out]


def _time(record: Record) -> float:
    return record.t1 if isinstance(record, Label) else getattr(record, "t", 0.0)


def _slice(records: list[Record], a: float, b: float) -> list[Record]:
    return [r for r in records if a <= _time(r) <= b]


def _ticks(a: float, b: float, step: float) -> Iterator[float]:
    k = math.ceil(a / step)
    while k * step <= b:
        yield k * step
        k += 1


def engine_run(
    data: Data,
    settings: Settings,
    options: Options,
    model: dict[str, Json] | None,
    ranges: Sequence[Range],
    feed: Callable[[Range], list[Record]] | None = None,
) -> tuple[Timeline, Engine]:
    engine = Engine(data.plan, settings, model, options)
    rooms = build(data.plan).rooms
    line = Timeline(rooms=rooms)
    step = settings.global_.tick_s
    for a, b in sorted(ranges):
        extra = feed((a, b)) if feed else []
        items = sorted([*_slice(data.records, a - WARMUP_S, b), *extra], key=_time)
        i = 0
        for t in _ticks(a - WARMUP_S, b, step):
            while i < len(items) and _time(items[i]) <= t:
                engine.feed(items[i])
                i += 1
            engine.advance(t)
            if t >= a:
                now = engine.rooms_now()
                line.t.append(t)
                line.p.append(tuple(now[r][0] for r in rooms))
                line.motion.append(tuple(now[r][1] for r in rooms))
        while i < len(items):
            engine.feed(items[i])
            i += 1
        engine.advance(b + 2 * step)
    return line, engine


def train(
    data: Data, spec: Spec, settings: Settings, empty: Sequence[Range], sessions: Sequence[Range]
) -> dict[str, Json] | None:
    if not spec.learn or spec.kind != "bayes":
        return None
    learn = replace(settings, global_=replace(settings.global_, learning=True))
    labels = {s: [lb for lb in data.labels if s[0] <= lb.t0 and lb.t1 <= s[1]] for s in sessions}

    def feed(r: Range) -> list[Record]:
        if r in labels:
            return list(labels[r])
        return [Label(t0=r[0], t1=r[1], kind="empty", source="empty_house")]

    _, engine = engine_run(data, learn, spec.options, None, [*empty, *sessions], feed)
    pending = engine.pending_id()
    if pending is not None:
        engine.apply(pending, max(b for _, b in [*empty, *sessions]))
    return engine.model_state()


def baseline_b0(data: Data, ranges: Sequence[Range], step: float) -> Timeline:
    topo = build(data.plan)
    line = Timeline(rooms=topo.rooms)
    for a, b in sorted(ranges):
        occupancy: dict[str, bool] = {}
        items = [r for r in _slice(data.records, a - WARMUP_S, b) if isinstance(r, Observation)]
        i = 0
        for t in _ticks(a - WARMUP_S, b, step):
            while i < len(items) and items[i].t <= t:
                if items[i].occupancy is not None:
                    occupancy[items[i].rx] = bool(items[i].occupancy)
                i += 1
            if t >= a:
                motion = tuple(
                    any(occupancy.get(x, False) for x in topo.bulbs if topo.bulb_room[x] == r) for r in topo.rooms
                )
                line.t.append(t)
                line.p.append(tuple(float(m) for m in motion))
                line.motion.append(motion)
    return line


def baseline_b2(data: Data, ranges: Sequence[Range], step: float) -> Timeline:
    rooms = build(data.plan).rooms
    line = Timeline(rooms=rooms)
    for a, b in sorted(ranges):
        items = [e for e in data.estimates if a - WARMUP_S <= e[0] <= b]
        i = 0
        last: tuple[float, str | None, float] | None = None
        for t in _ticks(a, b, step):
            while i < len(items) and items[i][0] <= t:
                last = items[i]
                i += 1
            live = last is not None and t - last[0] <= ESTIMATE_STALE_S and last[2] > MOVING
            motion = tuple(live and last is not None and last[1] == r for r in rooms)
            line.t.append(t)
            line.p.append(tuple(float(m) for m in motion))
            line.motion.append(motion)
    return line


def decisions(line: Timeline, a_on: float, n_on: int) -> Timeline:
    out = Timeline(rooms=line.rooms, t=line.t, p=line.p)
    run = [0] * len(line.rooms)
    on = [False] * len(line.rooms)
    prev_t = None
    for t, ps in zip(line.t, line.p, strict=True):
        if prev_t is not None and t - prev_t > 1.0:
            run, on = [0] * len(line.rooms), [False] * len(line.rooms)
        prev_t = t
        for i, p in enumerate(ps):
            run[i] = run[i] + 1 if p >= a_on else 0
            if p < A_OFF:
                on[i] = False
            elif run[i] >= n_on:
                on[i] = True
        out.motion.append(tuple(on))
    return out


def _onsets(line: Timeline, i: int, ranges: Sequence[Range]) -> list[float]:
    out = []
    prev = False
    prev_t = None
    for t, m in zip(line.t, line.motion, strict=True):
        if prev_t is not None and t - prev_t > 1.0:
            prev = False
        prev_t = t
        if m[i] and not prev and _inside(t, ranges):
            out.append(t)
        prev = m[i]
    return out


def metrics(line: Timeline, data: Data, empty: Sequence[Range], sessions: Sequence[Range]) -> dict[str, Json]:
    topo = build(data.plan)
    hours = sum(b - a for a, b in empty) / 3600

    def span(a: float, b: float) -> range:
        return range(bisect.bisect_left(line.t, a), bisect.bisect_right(line.t, b))

    rooms: dict[str, Json] = {}
    in_sessions = [lb for lb in data.labels if any(s[0] <= lb.t0 and lb.t1 <= s[1] for s in sessions)]
    total_fa = 0
    acc_hit = acc_n = 0
    where = motion_rooms(line)
    for i, r in enumerate(line.rooms):
        fa = len(_onsets(line, i, empty))
        total_fa += fa
        segs = [
            lb for lb in in_sessions if lb.room == r and lb.activity != "still" and lb.t1 - lb.t0 >= DETECT_WINDOW_S
        ]
        latencies: list[float] = []
        firsts: list[float] = []
        cover_hit = cover_n = 0
        for lb in segs:
            ticks = span(lb.t0, lb.t1)
            first = [line.t[k] - lb.t0 for k in ticks if line.motion[k][i] and line.t[k] <= lb.t0 + DETECT_WINDOW_S]
            if first:
                latencies.append(min(first))
            anywhere = [line.t[k] - lb.t0 for k in ticks if line.motion[k][i]]
            if anywhere:
                firsts.append(min(anywhere))
            cover_hit += sum(line.motion[k][i] for k in ticks)
            cover_n += len(ticks)
        cross_adj = cross_far = 0
        cross_s = 0.0
        for lb in in_sessions:
            if lb.room is None or lb.activity == "still":
                continue
            cross_s += lb.t1 - lb.t0
            if lb.room == r:
                ticks = span(lb.t0, lb.t1)
                acc_hit += sum(where[k] == i for k in ticks)
                acc_n += len(ticks)
                continue
            n = len(_onsets(line, i, [(lb.t0, lb.t1)]))
            if topo.is_adjacent(r, lb.room):
                cross_adj += n
            else:
                cross_far += n
        rooms[r] = {
            "false_alarms": fa,
            "false_per_h": round(fa / hours, 3) if hours else None,
            "false_per_day": round(24 * fa / hours, 2) if hours else None,
            "entries": len(segs),
            "detected": len(latencies),
            "detection": round(len(latencies) / len(segs), 3) if segs else None,
            "latency_median_s": round(statistics.median(latencies), 2) if latencies else None,
            "latency_p90_s": round(sorted(latencies)[max(0, math.ceil(0.9 * len(latencies)) - 1)], 2)
            if latencies
            else None,
            "first_motion_s": round(statistics.median(firsts), 2) if firsts else None,
            "walk_coverage": round(cover_hit / cover_n, 3) if cover_n else None,
            "cross_adjacent_per_h": round(3600 * cross_adj / cross_s, 2) if cross_s else None,
            "cross_far_per_h": round(3600 * cross_far / cross_s, 2) if cross_s else None,
        }
    return {
        "empty_hours": round(hours, 3),
        "false_alarms": total_fa,
        "false_per_h": round(total_fa / hours, 3) if hours else None,
        "room_accuracy": round(acc_hit / acc_n, 3) if acc_n else None,
        "rooms": rooms,
    }


def motion_rooms(line: Timeline) -> list[int | None]:
    since: list[float | None] = [None] * len(line.rooms)
    out: list[int | None] = []
    prev_t = None
    for t, m in zip(line.t, line.motion, strict=True):
        if prev_t is not None and t - prev_t > 1.0:
            since = [None] * len(line.rooms)
        prev_t = t
        since = [(s if s is not None else t) if on else None for s, on in zip(since, m, strict=True)]
        live = [(s, i) for i, s in enumerate(since) if s is not None]
        out.append(max(live)[1] if live else None)
    return out


def specs(rules: RuleConfig | None) -> list[Spec]:
    out = [Spec("B0", "b0")]
    if rules is not None:
        out.append(Spec("B1-owner", "rules", Options(mode="rules", rules=rules)))
    out += [
        Spec("B1-old", "rules", Options(mode="rules", rules=RuleConfig(default=RoomRule(kind="receiver")))),
        Spec("B1", "rules", Options(mode="rules")),
        Spec(
            "B1-any-direction",
            "rules",
            Options(mode="rules", rules=RuleConfig(default=RoomRule(both_directions=False))),
        ),
        Spec("B2", "b2"),
        Spec("engine", "bayes", Options(mode="bayes")),
        Spec("no-agreement", "bayes", Options(mode="bayes", agree=False)),
        Spec("no-veto", "bayes", Options(mode="bayes", veto=False)),
        Spec("no-explain", "bayes", Options(mode="bayes", explain=False)),
        Spec("no-learning", "bayes", Options(mode="bayes", learned=False), learn=False),
        Spec("no-cfar", "bayes", Options(mode="bayes", cfar=False)),
        Spec("no-geometry", "bayes", Options(mode="bayes", geometric=False)),
        Spec("fw-channel", "bayes", Options(mode="bayes", firmware=True)),
    ]
    return out


def folds(ranges: Sequence[Range], k: int) -> list[list[Range]]:
    if k <= 1:
        return [list(ranges)]
    out: list[list[Range]] = [[] for _ in range(k)]
    for a, b in ranges:
        width = (b - a) / k
        for j in range(k):
            out[j].append((a + j * width, a + (j + 1) * width))
    return out


def evaluate_spec(spec: Spec, data: Data, settings: Settings, k: int) -> tuple[dict[str, Json], list[Timeline]]:
    step = settings.global_.tick_s
    test = replace(settings, global_=replace(settings.global_, learning=False))
    parts = folds(data.empty, k)
    lines: list[Timeline] = []
    tested_empty: list[Range] = []
    for j, part in enumerate(parts):
        rest = [r for i, p in enumerate(parts) if i != j for r in p]
        model = train(data, spec, settings, rest if k > 1 else part, data.sessions)
        lines.append(_run(spec, data, test, model, part, step))
        tested_empty += part
    for j, session in enumerate(data.sessions):
        others = [s for i, s in enumerate(data.sessions) if i != j]
        model = train(data, spec, settings, data.empty, others)
        lines.append(_run(spec, data, test, model, [session], step))
    merged = _merge(lines)
    result = metrics(merged, data, tested_empty, data.sessions)
    return result, lines


def _run(
    spec: Spec, data: Data, settings: Settings, model: dict[str, Json] | None, ranges: Sequence[Range], step: float
) -> Timeline:
    if spec.kind == "b0":
        return baseline_b0(data, ranges, step)
    if spec.kind == "b2":
        return baseline_b2(data, ranges, step)
    return engine_run(data, settings, spec.options, model, ranges)[0]


def _merge(lines: Iterable[Timeline]) -> Timeline:
    items = list(lines)
    out = Timeline(rooms=items[0].rooms if items else ())
    rows = sorted((t, p, m) for line in items for t, p, m in zip(line.t, line.p, line.motion, strict=True))
    for t, p, m in rows:
        out.t.append(t)
        out.p.append(p)
        out.motion.append(m)
    return out


def _num(value: Json) -> float:
    return float(value) if isinstance(value, int | float) else 0.0


def roc(line: Timeline, data: Data, n_on: int) -> list[dict[str, Json]]:
    out = []
    for a_on in (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99):
        m = metrics(decisions(line, a_on, n_on), data, data.empty, data.sessions)
        rooms = m["rooms"]
        assert isinstance(rooms, dict)
        det = [_num(v["detection"]) for v in rooms.values() if isinstance(v, dict) and v["detection"] is not None]
        cov = [
            _num(v["walk_coverage"]) for v in rooms.values() if isinstance(v, dict) and v["walk_coverage"] is not None
        ]
        out.append(
            {
                "a_on": a_on,
                "false_per_h": m["false_per_h"],
                "detection": round(sum(det) / len(det), 3) if det else None,
                "walk_coverage": round(sum(cov) / len(cov), 3) if cov else None,
            }
        )
    return out


def evaluate(data: Data, settings: Settings, k: int, names: Sequence[str] | None = None) -> dict[str, Json]:
    report: dict[str, Json] = {
        "empty_hours": round(sum(b - a for a, b in data.empty) / 3600, 3),
        "sessions": len(data.sessions),
        "labels": len(data.labels),
        "models": {},
    }
    models = report["models"]
    assert isinstance(models, dict)
    for spec in specs(data.rules):
        if names and spec.name not in names:
            continue
        result, lines = evaluate_spec(spec, data, settings, k)
        if spec.kind == "bayes":
            curve: list[Json] = list(roc(_merge(lines), data, N_ON["normal"]))
            result["roc"] = curve
        models[spec.name] = result
    return report


def markdown(title: str, report: dict[str, Json]) -> str:
    models = report["models"]
    assert isinstance(models, dict)
    rooms: list[str] = []
    for m in models.values():
        assert isinstance(m, dict)
        assert isinstance(m["rooms"], dict)
        rooms = list(m["rooms"])
        break
    head = ["model", "FA/h (empty)"] + [f"{r}: FA · det · cover · lat · first" for r in rooms] + ["room acc."]
    lines = [f"## {title}", "", f"Empty hours: {report['empty_hours']}, sessions: {report['sessions']}", ""]
    lines += ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for name, m in models.items():
        assert isinstance(m, dict)
        assert isinstance(m["rooms"], dict)
        cells = [name, str(m["false_per_h"])]
        for r in rooms:
            v = m["rooms"][r]
            assert isinstance(v, dict)
            det = f"{v['detected']}/{v['entries']}"
            cells.append(
                f"{v['false_alarms']} · {det} · {v['walk_coverage']} · {v['latency_median_s']} · {v['first_motion_s']}"
            )
        cells.append(str(m["room_accuracy"]))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def synthetic(seed: int, duration: float, empty: float) -> dict[str, Data]:
    out = {}
    for template in sorted(synth.PHYSICS):
        records = list(
            synth.simulate_physics(template, seed, duration, empty, persons=1 if template == "studio" else 2)
        )
        plan = synth.PHYSICS[template]
        observations = [r for r in records if not isinstance(r, Header | Label | Context)]
        labels = [r for r in records if isinstance(r, Label)]
        rooms = [lb for lb in labels if lb.kind == "room"]
        out[template] = Data(
            plan=plan,
            records=sorted(observations, key=_time),
            labels=rooms,
            empty=[(lb.t0, lb.t1) for lb in labels if lb.kind == "empty"],
            sessions=[(rooms[0].t0, rooms[-1].t1)] if rooms else [],
        )
    return out


def _range(text: str) -> Range:
    a, _, b = text.partition(":")
    return float(a), float(b)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline evaluation: baselines, engine, ablations (architecture.md 8)")
    parser.add_argument("recordings", type=Path, nargs="*")
    parser.add_argument("--plan", type=Path, help="plan JSON")
    parser.add_argument("--mieszkanie", type=Path, help="prototype plan (mieszkanie.yaml); also maps bulb names")
    parser.add_argument("--zones", type=Path, help="outglow_zones.py: SKIP and ZONE_RULES (B1-owner)")
    parser.add_argument("--empty", type=_range, action="append", default=[], help="empty-house window t0:t1")
    parser.add_argument("--window", type=_range, action="append", default=None, help="only read t0:t1")
    parser.add_argument("--folds", type=int, default=2)
    parser.add_argument("--models", nargs="*")
    parser.add_argument("--synthetic", action="store_true", help="evaluate the 4 synthetic templates")
    parser.add_argument("--duration", type=float, default=7200.0)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--markdown", type=Path)
    args = parser.parse_args(argv)
    settings = Settings()
    out: dict[str, Json] = {}
    text = []
    if args.synthetic:
        for name, data in synthetic(args.seed, args.duration, args.duration / 2).items():
            out[f"synthetic/{name}"] = report = evaluate(data, settings, args.folds, args.models)
            text.append(markdown(f"synthetic {name}", report))
    if args.recordings:
        names: dict[str, str] = {}
        plan = Plan()
        if args.mieszkanie:
            imported = import_prototype.load(args.mieszkanie)
            plan, names = imported.plan, imported.names
        if args.plan:
            plan = from_json(Plan, json.loads(args.plan.read_text()))
        rules = None
        if args.zones:
            skip, rules = import_prototype.zones_config(args.zones.read_text(), plan)
            plan = replace(plan, excluded_directions=importer.skip_directions(skip))
        windows = None
        if args.window:
            windows = [(a - WARMUP_S, b) for a, b in args.window]
        header_plan = plan
        data = load(args.recordings, header_plan, names, windows, args.empty)
        if not data.plan.rooms:
            first = next(iter(recording.read(args.recordings[0].open())), None)
            if isinstance(first, Header) and first.plan is not None:
                data.plan = first.plan
        data.rules = rules
        out["recordings"] = report = evaluate(data, settings, args.folds, args.models)
        text.append(markdown("recordings", report))
    if args.json:
        args.json.write_text(json.dumps(out, indent=2) + "\n")
    if args.markdown:
        args.markdown.write_text("\n".join(text))
    sys.stdout.write("\n".join(text) if text else json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
