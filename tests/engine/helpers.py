from collections.abc import Mapping

from engine.types import LightState, LinkReading, Observation, Plan, PlanBulb, Room, Source, Wall
from tools import synth

FLAT3 = synth.TEMPLATES["flat3"]
B1, B2, B3, B4 = (f"0x{n:016x}" for n in (1, 2, 3, 4))


def obs(
    t: float,
    rx: str,
    levels: Mapping[str, int | None],
    source: Source = "activity",
    motion: frozenset[str] = frozenset(),
    signal: int | None = -60,
    occupancy: bool | None = None,
    light: LightState | None = None,
) -> Observation:
    links = tuple(
        LinkReading(
            tx=tx,
            level=level if source == "activity" else None,
            window_sum=level if source == "lines" else None,
            motion=tx in motion,
            signal_dbm=signal,
            raw_activity=level,
        )
        for tx, level in levels.items()
    )
    return Observation(t=t, rx=rx, links=links, occupancy=occupancy, light=light, source=source)


def all_levels(rx: str, level: int, plan: Plan = FLAT3) -> dict[str, int | None]:
    return {b.ieee: level for b in plan.bulbs if b.ieee != rx}


def square(x0: float, y0: float, x1: float, y1: float) -> tuple[tuple[float, float], ...]:
    return ((x0, y0), (x1, y0), (x1, y1), (x0, y1))


TWO = Plan(
    rooms=(
        Room(id="a", name="A", outline=square(0, 0, 4, 4)),
        Room(id="b", name="B", outline=square(4, 0, 8, 4)),
    ),
    walls=(Wall(a=(4, 0), b=(4, 4), kind="brick"),),
    bulbs=(PlanBulb(ieee=B1, x=1, y=2), PlanBulb(ieee=B2, x=3, y=2), PlanBulb(ieee=B3, x=6, y=2, height="lamp")),
)
