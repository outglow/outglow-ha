import argparse
import json
import math
import random
import sys
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import recording, to_json
from engine.types import (
    Context,
    DirectionFrame,
    Door,
    Frame,
    Gate,
    Header,
    Label,
    LightEvent,
    LightState,
    LinkReading,
    Observation,
    PairFrame,
    PairObservation,
    Plan,
    PlanBulb,
    Point,
    Record,
    Room,
    RoomFrame,
    Settings,
    Source,
    Wall,
)

START = 1_800_000_000.0
FW_THRESHOLD = 25
PROBE_S = 0.2
FRAME_S = 0.5


def ieee(n: int) -> str:
    return f"0x{n:016x}"


TEMPLATES: dict[str, Plan] = {
    "flat3": Plan(
        rooms=(
            Room(id="living", name="Living room", colour="#4e9af1", outline=((0, 0), (5, 0), (5, 4), (0, 4))),
            Room(id="hall", name="Hall", colour="#f28b30", outline=((5, 0), (7, 0), (7, 6), (5, 6)), entrance=True),
            Room(id="office", name="Office", colour="#42b883", outline=((2, 4), (5, 4), (5, 7), (2, 7))),
        ),
        walls=(
            Wall(a=(5, 0), b=(5, 4), kind="partition"),
            Wall(a=(2, 4), b=(5, 4), kind="brick"),
            Wall(a=(5, 4), b=(5, 6), kind="partition"),
        ),
        doors=(Door(wall=0, at=0.6, width=0.9), Door(wall=2, at=0.5, width=0.8)),
        adjacent=(("living", "hall"), ("hall", "office")),
        bulbs=(
            PlanBulb(ieee=ieee(1), x=1.5, y=1.5),
            PlanBulb(ieee=ieee(2), x=3.8, y=2.5),
            PlanBulb(ieee=ieee(3), x=6.0, y=3.0),
            PlanBulb(ieee=ieee(4), x=3.5, y=5.5),
        ),
    ),
}


@dataclass(frozen=True)
class Segment:
    room: str | None
    t0: float
    t1: float


def room_of(plan: Plan, bulb: PlanBulb) -> str | None:
    if bulb.room is not None:
        return bulb.room
    for room in plan.rooms:
        xs = [p[0] for p in room.outline]
        ys = [p[1] for p in room.outline]
        if min(xs) <= bulb.x <= max(xs) and min(ys) <= bulb.y <= max(ys):
            return room.id
    return None


def theta(plan: Plan, a: PlanBulb, b: PlanBulb, room: str) -> float:
    adjacent = {frozenset(p) for p in plan.adjacent}
    ra, rb = room_of(plan, a), room_of(plan, b)
    if ra == rb == room:
        return 0.15
    if room in (ra, rb):
        other = rb if ra == room else ra
        return 0.45 if frozenset((room, other)) in adjacent else 0.2
    near = any(frozenset((room, r)) in adjacent for r in (ra, rb) if r is not None)
    return 0.1 if near else 0.02


def path(plan: Plan, rng: random.Random, duration: float) -> list[Segment]:
    neighbours: dict[str, list[str]] = {r.id: [] for r in plan.rooms}
    for x, y in plan.adjacent:
        neighbours[x].append(y)
        neighbours[y].append(x)
    t = START
    segments = [Segment(None, t, t + 3.0)]
    t += 3.0
    room = next(r.id for r in plan.rooms if r.entrance)
    while t < START + duration:
        dwell = rng.uniform(4.0, 8.0)
        segments.append(Segment(room, t, min(t + dwell, START + duration)))
        t += dwell
        room = rng.choice(neighbours[room])
    return segments


def simulate(template: str, seed: int, duration: float, rate: float, frames: bool) -> Iterator[Record]:
    plan = TEMPLATES[template]
    rng = random.Random(seed)
    segments = path(plan, rng, duration)
    yield Header(plan=plan, settings=Settings(), created=START, generator=f"tools/synth.py {template} seed={seed}")
    bulbs = plan.bulbs
    pairs = [(rx, tx) for rx in bulbs for tx in bulbs if rx.ieee != tx.ieee]
    levels = {(rx.ieee, tx.ieee): 0 for rx, tx in pairs}
    signal = {(rx.ieee, tx.ieee): -55 - round(4 * math.dist((rx.x, rx.y), (tx.x, tx.y))) for rx, tx in pairs}
    next_report = {b.ieee: START for b in bulbs}
    gate_open = {b.ieee: False for b in bulbs}
    trail: list[tuple[str, float]] = []
    out: list[Record] = []
    steps = round(duration / PROBE_S)
    for step in range(steps + 1):
        t = round(START + step * PROBE_S, 3)
        here = next((s.room for s in segments if s.t0 <= t < s.t1), None)
        if here is not None and (not trail or trail[-1][0] != here):
            trail.append((here, t))
        for rx, tx in pairs:
            boost = theta(plan, rx, tx, here) * rng.uniform(40, 90) if here else 0.0
            levels[(rx.ieee, tx.ieee)] = min(255, round(rng.gammavariate(2.0, 3.0) + boost))
        for rx in bulbs:
            mine = [(tx, levels[(rx.ieee, tx.ieee)]) for tx in bulbs if tx.ieee != rx.ieee]
            seeing = any(level > FW_THRESHOLD for _, level in mine)
            closing = gate_open[rx.ieee] and not seeing
            if (seeing and t >= next_report[rx.ieee]) or closing:
                out.append(_observation(t, rx, mine, signal))
                next_report[rx.ieee] = t + 1 / rate
            gate_open[rx.ieee] = seeing
        if frames and step % round(FRAME_S / PROBE_S) == 0:
            out.append(_frame(plan, t, here, levels, gate_open, trail))
    for seg in segments:
        if seg.room is not None and seg.t1 > seg.t0:
            out.append(Label(t0=seg.t0, t1=seg.t1, kind="room", room=seg.room, activity="walk", source="recording"))
        elif seg.room is None:
            out.append(Label(t0=seg.t0, t1=seg.t1, kind="empty", source="recording"))
    yield from sorted(out, key=_time)


def _time(record: Record) -> float:
    return record.t1 if isinstance(record, Label) else getattr(record, "t", 0.0)


def _observation(
    t: float, rx: PlanBulb, mine: list[tuple[PlanBulb, int]], signal: dict[tuple[str, str], int]
) -> Observation:
    links = tuple(
        LinkReading(
            tx=tx.ieee,
            level=level,
            motion=level > FW_THRESHOLD,
            signal_dbm=signal[(rx.ieee, tx.ieee)],
            noise_db=1.2,
            sensitivity=40,
            calibrated_sensitivity=40,
            raw_activity=level,
        )
        for tx, level in mine
    )
    return Observation(
        t=t,
        rx=rx.ieee,
        links=links,
        occupancy=any(link.motion for link in links),
        light=LightState(on=True, brightness=200, color_temp=None),
        source="activity",
    )


def _frame(
    plan: Plan,
    t: float,
    here: str | None,
    levels: dict[tuple[str, str], int],
    gate_open: dict[str, bool],
    trail: list[tuple[str, float]],
) -> Frame:
    bulbs = plan.bulbs
    directions = tuple(
        DirectionFrame(
            rx=rx,
            tx=tx,
            level=level,
            z=round((level - 6) / 4, 2),
            state="exceed" if level > FW_THRESHOLD else ("quiet" if gate_open[rx] else "quiet_censored"),
        )
        for (rx, tx), level in sorted(levels.items())
    )
    pair_frames = []
    for i, a in enumerate(bulbs):
        for b in bulbs[i + 1 :]:
            hits = (levels[(a.ieee, b.ieee)] > FW_THRESHOLD) + (levels[(b.ieee, a.ieee)] > FW_THRESHOLD)
            obs: PairObservation = 2 if hits == 2 else 1 if hits == 1 else 0
            pair_frames.append(PairFrame(a=a.ieee, b=b.ieee, obs=obs, weight=0.5))
    gates: dict[str, Gate] = {b.ieee: "open" if gate_open[b.ieee] else "closed" for b in bulbs}
    rooms = {
        r.id: RoomFrame(
            p=0.95 if r.id == here else 0.02,
            motion=r.id == here,
            occupied=r.id == here,
            since=trail[-1][1] if r.id == here else None,
            coverage="good",
        )
        for r in plan.rooms
    }
    centre = {
        r.id: (
            round(sum(p[0] for p in r.outline) / len(r.outline), 2),
            round(sum(p[1] for p in r.outline) / len(r.outline), 2),
        )
        for r in plan.rooms
        if r.id == here
    }
    return Frame(
        t=t,
        status="learning",
        directions=directions,
        pairs=tuple(pair_frames),
        rooms=rooms,
        gates=gates,
        trail=tuple(trail[-10:]),
        illustrative_xy=centre,
    )


def _rect(x0: float, y0: float, x1: float, y1: float) -> tuple[Point, ...]:
    return ((x0, y0), (x1, y0), (x1, y1), (x0, y1))


def _bulbs(*xy: tuple[float, float]) -> tuple[PlanBulb, ...]:
    return tuple(PlanBulb(ieee=ieee(i + 1), x=x, y=y) for i, (x, y) in enumerate(xy))


PHYSICS: dict[str, Plan] = {
    "studio": Plan(
        rooms=(
            Room(id="main", name="Room", outline=_rect(0, 0, 5, 4), entrance=True),
            Room(id="bath", name="Bathroom", colour="#42b883", outline=_rect(5, 0, 7, 2.5)),
        ),
        walls=(Wall(a=(5, 0), b=(5, 2.5), kind="brick"),),
        adjacent=(("main", "bath"),),
        bulbs=_bulbs((1.5, 1.5), (3.8, 2.8), (6.0, 1.2)),
    ),
    "flat2": Plan(
        rooms=(
            Room(id="living", name="Living room", outline=_rect(0, 0, 5, 4)),
            Room(id="hall", name="Hall", colour="#f28b30", outline=_rect(5, 0, 7, 6), entrance=True),
            Room(id="bed", name="Bedroom", colour="#42b883", outline=_rect(7, 0, 11, 4)),
        ),
        adjacent=(("living", "hall"), ("hall", "bed")),
        bulbs=_bulbs((1.5, 1.5), (3.8, 2.5), (6.0, 1.5), (6.0, 4.5), (9.0, 2.0)),
    ),
    "lshape": Plan(
        rooms=(
            Room(id="living", name="Living room", outline=_rect(0, 0, 6, 5)),
            Room(id="hall", name="Hall", colour="#f28b30", outline=_rect(6, 0, 8, 8), entrance=True),
            Room(id="kitchen", name="Kitchen", colour="#e8c547", outline=_rect(8, 0, 12, 4)),
            Room(id="office", name="Office", colour="#42b883", outline=_rect(3, 8, 8, 11)),
        ),
        walls=(Wall(a=(6, 0), b=(6, 5), kind="concrete"),),
        adjacent=(("living", "hall"), ("hall", "kitchen"), ("hall", "office")),
        bulbs=_bulbs((1.5, 1.5), (4.5, 3.5), (7.0, 1.5), (7.0, 6.0), (9.5, 1.5), (11.0, 3.0), (4.5, 9.5), (6.5, 10.0)),
    ),
    "wings": Plan(
        rooms=(
            Room(id="hall", name="Hall", colour="#f28b30", outline=_rect(5, 0, 7, 12), entrance=True),
            Room(id="living", name="Living room", outline=_rect(0, 0, 5, 5)),
            Room(id="kitchen", name="Kitchen", colour="#e8c547", outline=_rect(0, 5, 5, 8)),
            Room(id="bath", name="Bathroom", colour="#3fc1c9", outline=_rect(0, 8, 5, 12)),
            Room(id="bed", name="Bedroom", colour="#42b883", outline=_rect(7, 0, 12, 6)),
            Room(id="kids", name="Kids room", colour="#b56cf0", outline=_rect(7, 6, 12, 12)),
        ),
        adjacent=(("hall", "living"), ("hall", "kitchen"), ("hall", "bath"), ("hall", "bed"), ("hall", "kids")),
        bulbs=_bulbs(
            (6.0, 2.0),
            (6.0, 6.0),
            (6.0, 10.0),
            (1.5, 1.5),
            (3.8, 3.5),
            (2.0, 6.5),
            (4.0, 7.0),
            (2.5, 10.0),
            (9.0, 2.0),
            (11.0, 4.5),
            (8.5, 9.0),
            (11.0, 11.0),
        ),
    ),
}


@dataclass
class World:
    plan: Plan
    signal: dict[tuple[str, str], int]
    scale: dict[tuple[str, str], float]
    fw: dict[tuple[str, str], float]
    frozen: dict[tuple[str, str], int]
    theta: dict[tuple[tuple[str, str], str], float]
    eta: dict[tuple[str, str], float]


def _world(plan: Plan, rng: random.Random) -> World:
    bulbs = plan.bulbs
    rooms = [r.id for r in plan.rooms]
    signal, scale, fw, frozen, th, eta = {}, {}, {}, {}, {}, {}
    for a in bulbs:
        for b in bulbs:
            if a.ieee == b.ieee:
                continue
            ra, rb = room_of(plan, a), room_of(plan, b)
            walls = 0 if ra == rb else 1
            d = max(0.5, math.dist((a.x, a.y), (b.x, b.y)))
            key = (a.ieee, b.ieee)
            signal[key] = round(-45 - 25 * math.log10(d) - 6 * walls + rng.uniform(-3, 3))
            scale[key] = (1.2 + max(0, -signal[key] - 60) / 12) * rng.uniform(0.7, 1.5)
            fw[key] = 8 * scale[key] + rng.uniform(4, 10)
            if signal[key] <= -88:
                frozen[key] = rng.randint(20, 45)
    for i, a in enumerate(bulbs):
        for b in bulbs[i + 1 :]:
            pair = (a.ieee, b.ieee)
            eta[pair] = rng.uniform(0.45, 0.9)
            for r in rooms:
                th[(pair, r)] = min(0.9, theta(plan, a, b, r) * math.exp(rng.gauss(0, 0.35)))
    return World(plan, signal, scale, fw, frozen, th, eta)


def _people(plan: Plan, rng: random.Random, t0: float, duration: float, persons: int) -> list[Segment]:
    neighbours: dict[str, list[str]] = {r.id: [] for r in plan.rooms}
    for x, y in plan.adjacent:
        neighbours[x].append(y)
        neighbours[y].append(x)
    entrance = next((r.id for r in plan.rooms if r.entrance), plan.rooms[0].id)
    out = []
    for k in range(persons):
        t = t0 + k * rng.uniform(20, 60)
        room = entrance
        while t < t0 + duration:
            dwell = rng.uniform(15, 90)
            walking = rng.random() < 0.75
            out.append(Segment(room if walking else None, t, min(t + dwell, t0 + duration)))
            t += dwell
            room = rng.choice(neighbours[room] or [room])
    return out


def simulate_physics(
    template: str,
    seed: int,
    duration: float,
    empty: float = 0.0,
    persons: int = 1,
    rate: float = 2.0,
    waves: bool = True,
    lights: bool = True,
) -> Iterator[Record]:
    plan = PHYSICS[template]
    rng = random.Random(seed)
    world = _world(plan, rng)
    yield Header(
        plan=plan, settings=Settings(), created=START, generator=f"tools/synth.py --physics {template} seed={seed}"
    )
    bulbs = [b.ieee for b in plan.bulbs]
    pairs = [(a, b) for i, a in enumerate(bulbs) for b in bulbs[i + 1 :]]
    home_from = START + empty
    segments = _people(plan, rng, home_from, duration - empty, persons) if duration > empty else []
    out: list[Record] = []
    if empty > 0:
        out.append(Context(t=START, house_empty="yes"))
        out.append(Label(t0=START, t1=home_from, kind="empty", source="empty_house"))
        out.append(Context(t=home_from, house_empty="no"))
    for seg in segments:
        if seg.room is not None and seg.t1 - seg.t0 >= 1:
            out.append(Label(t0=seg.t0, t1=seg.t1, kind="room", room=seg.room, activity="walk", source="recording"))
    wave = 0.0
    wave_until = -1.0
    spikes: dict[tuple[str, str], float] = {}
    light_t: dict[str, float] = {}
    gate = dict.fromkeys(bulbs, False)
    next_report = dict.fromkeys(bulbs, START)
    next_lines = {b: START + rng.uniform(0, 300) for b in bulbs}
    steps = round(duration / FRAME_S)
    for step in range(steps + 1):
        t = round(START + step * FRAME_S, 3)
        here = {s.room for s in segments if s.room is not None and s.t0 <= t < s.t1}
        wave = 0.9 * wave + rng.gauss(0, 0.6)
        if waves and rng.random() < FRAME_S / 1800:
            wave_until = t + rng.uniform(4, 8)
        if lights and rng.random() < FRAME_S / 900:
            b = rng.choice(bulbs)
            light_t[b] = t
            out.append(LightEvent(t=t, ieee=b, origin="user", on=rng.random() < 0.5))
        levels: dict[tuple[str, str], float] = {}
        for key, sc in world.scale.items():
            if key in world.frozen:
                levels[key] = world.frozen[key]
                continue
            base = rng.gammavariate(2.0, sc) + max(0.0, wave) * sc * 0.5
            if t < wave_until and rng.random() < 0.8:
                base += rng.uniform(18, 35)
            if key not in spikes and rng.random() < FRAME_S / 1200:
                spikes[key] = t + rng.uniform(1.5, 4)
            if spikes.get(key, -1) > t:
                base += rng.uniform(15, 30)
            elif key in spikes and spikes[key] <= t:
                del spikes[key]
            if t - max(light_t.get(key[0], -9.0), light_t.get(key[1], -9.0)) < 1.5:
                base += rng.uniform(20, 40)
            levels[key] = base
        for a, b in pairs:
            hit = 1 - math.prod(1 - world.theta[((a, b), r)] for r in here)
            if here and rng.random() < hit:
                gain = rng.uniform(15, 40)
                if rng.random() < world.eta[(a, b)]:
                    levels[(a, b)] += gain
                    levels[(b, a)] += gain * rng.uniform(0.7, 1.3)
                else:
                    levels[(a, b) if rng.random() < 0.5 else (b, a)] += gain
        for rx in bulbs:
            mine = [(tx, min(255, round(levels[(rx, tx)]))) for tx in bulbs if tx != rx]
            seeing = any(level > world.fw[(rx, tx)] for tx, level in mine)
            closing = gate[rx] and not seeing
            if (seeing and t >= next_report[rx]) or closing:
                out.append(_physics_obs(t, rx, mine, world, "activity"))
                next_report[rx] = t + 1 / rate
            elif t >= next_lines[rx]:
                out.append(_physics_obs(t, rx, [(tx, rng.randint(0, 3)) for tx, _ in mine], world, "lines"))
                next_lines[rx] = t + 300
            gate[rx] = seeing
    yield from sorted(out, key=_time)


def _physics_obs(t: float, rx: str, mine: list[tuple[str, int]], world: World, source: Source) -> Observation:
    links = tuple(
        LinkReading(
            tx=tx,
            level=level if source == "activity" else None,
            window_sum=level if source == "lines" else None,
            motion=source == "activity" and level > world.fw[(rx, tx)],
            signal_dbm=world.signal[(rx, tx)],
            noise_db=1.0,
            sensitivity=40,
            calibrated_sensitivity=40,
            raw_activity=level,
        )
        for tx, level in mine
    )
    return Observation(t=t, rx=rx, links=links, occupancy=any(link.motion for link in links), light=None, source=source)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Synthetic Outglow recordings (format 2)")
    parser.add_argument("--template", choices=sorted(TEMPLATES | PHYSICS), default="flat3")
    parser.add_argument("--physics", action="store_true", help="line physics, gate, waves, lights (§8.1)")
    parser.add_argument("--empty", type=float, default=0.0, help="seconds of empty house at the start (physics)")
    parser.add_argument("--persons", type=int, default=1)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--duration", type=float, default=20.0, help="seconds")
    parser.add_argument("--rate", type=float, default=2.0, help="activity reports per second")
    parser.add_argument("--frames", action="store_true", help="add oracle frames (for the frontend mock)")
    parser.add_argument("--mock", action="store_true", help="write {plan, frames} JSON for frontend/mock")
    args = parser.parse_args(argv)
    if args.physics:
        template = args.template if args.template in PHYSICS else "flat2"
        for line in recording.write(
            simulate_physics(template, args.seed, args.duration, args.empty, args.persons, args.rate)
        ):
            sys.stdout.write(line + "\n")
        return 0
    records = list(simulate(args.template, args.seed, args.duration, args.rate, args.frames or args.mock))
    if args.mock:
        mock = {
            "plan": to_json(TEMPLATES[args.template]),
            "frames": [to_json(r) for r in records if isinstance(r, Frame)],
        }
        sys.stdout.write(json.dumps(mock, separators=(",", ":")) + "\n")
        return 0
    for line in recording.write(records):
        sys.stdout.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
