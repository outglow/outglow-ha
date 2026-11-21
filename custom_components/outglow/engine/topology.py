import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from itertools import combinations

from .types import BulbHeight, Plan, PlanBulb, Point, Room

SEGMENT_SAMPLES = 24
ADJACENT_TOLERANCE_M = 0.25
HARD_WALLS = frozenset({"brick", "concrete"})

Pair = tuple[str, str]
Direction = tuple[str, str]


def point_in_polygon(p: Point, polygon: Sequence[Point]) -> bool:
    x, y = p
    inside = False
    n = len(polygon)
    for i in range(n):
        x1, y1 = polygon[i]
        x2, y2 = polygon[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def segment_distance(p: Point, a: Point, b: Point) -> float:
    ax, ay = a
    dx, dy = b[0] - ax, b[1] - ay
    length = dx * dx + dy * dy
    s = 0.0 if length == 0 else max(0.0, min(1.0, ((p[0] - ax) * dx + (p[1] - ay) * dy) / length))
    return math.dist(p, (ax + s * dx, ay + s * dy))


def segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool:
    def side(p: Point, q: Point, r: Point) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0


def edges(polygon: Sequence[Point]) -> list[tuple[Point, Point]]:
    return [(polygon[i], polygon[(i + 1) % len(polygon)]) for i in range(len(polygon))]


def boundary_distance(p: Point, polygon: Sequence[Point]) -> float:
    return min(segment_distance(p, a, b) for a, b in edges(polygon))


def centroid(polygon: Sequence[Point]) -> Point:
    return (sum(p[0] for p in polygon) / len(polygon), sum(p[1] for p in polygon) / len(polygon))


def rooms_touch(a: Room, b: Room) -> bool:
    close = [p for p in a.outline if boundary_distance(p, b.outline) <= ADJACENT_TOLERANCE_M]
    close += [p for p in b.outline if boundary_distance(p, a.outline) <= ADJACENT_TOLERANCE_M]
    return len(close) >= 2


def polygon_area(polygon: Sequence[Point]) -> float:
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in edges(polygon))) / 2


def room_containing(rooms: Iterable[Room], p: Point) -> str | None:
    inside = [room for room in rooms if len(room.outline) >= 3 and point_in_polygon(p, room.outline)]
    return min(inside, key=lambda room: polygon_area(room.outline)).id if inside else None


def room_at(plan: Plan, p: Point) -> str | None:
    return room_containing(plan.rooms, p)


def bulb_room(plan: Plan, bulb: PlanBulb) -> str | None:
    known = {room.id for room in plan.rooms}
    if bulb.room in known:
        return bulb.room
    return room_at(plan, (bulb.x, bulb.y))


def adjacency(plan: Plan) -> frozenset[frozenset[str]]:
    known = {room.id for room in plan.rooms}
    explicit = {frozenset(p) for p in plan.adjacent if set(p) <= known and p[0] != p[1]}
    if explicit:
        return frozenset(explicit)
    return frozenset(frozenset((a.id, b.id)) for a, b in combinations(plan.rooms, 2) if rooms_touch(a, b))


@dataclass(frozen=True, slots=True)
class Topology:
    rooms: tuple[str, ...]
    bulbs: tuple[str, ...]
    bulb_room: dict[str, str | None]
    bulb_xy: dict[str, Point]
    bulb_height: dict[str, BulbHeight]
    adjacent: frozenset[frozenset[str]]
    neighbours: dict[str, frozenset[str]]
    entrances: frozenset[str]
    pairs: tuple[Pair, ...]
    directions: tuple[Direction, ...]
    excluded: frozenset[Direction]
    crossed: dict[Pair, frozenset[str]]
    hard_wall: dict[Pair, bool]
    centres: dict[str, Point]

    def is_adjacent(self, a: str | None, b: str | None) -> bool:
        return a is not None and b is not None and frozenset((a, b)) in self.adjacent

    def ends(self, pair: Pair) -> tuple[str | None, str | None]:
        return self.bulb_room[pair[0]], self.bulb_room[pair[1]]

    def explainers(self, pair: Pair) -> frozenset[str]:
        return frozenset(r for r in self.ends(pair) if r is not None) | self.crossed[pair]

    def connected(self, rooms: Iterable[str]) -> bool:
        group = sorted(rooms)
        return len(group) <= 1 or all(self.is_adjacent(a, b) for a, b in combinations(group, 2))


def pair_of(a: str, b: str) -> Pair:
    return (a, b) if a < b else (b, a)


def build(plan: Plan) -> Topology:
    bulbs = tuple(sorted({b.ieee for b in plan.bulbs}))
    by_id = {b.ieee: b for b in plan.bulbs}
    rooms = tuple(room.id for room in plan.rooms)
    adjacent = adjacency(plan)
    neighbours = {r: frozenset(x for p in adjacent if r in p for x in p if x != r) for r in rooms}
    xy = {i: (by_id[i].x, by_id[i].y) for i in bulbs}
    pairs = tuple(pair_of(a, b) for a, b in combinations(bulbs, 2))
    room_of = {i: bulb_room(plan, by_id[i]) for i in bulbs}
    crossed = {p: _crossed(plan, xy[p[0]], xy[p[1]], {room_of[p[0]], room_of[p[1]]}) for p in pairs}
    hard = {
        p: any(w.kind in HARD_WALLS and segments_cross(xy[p[0]], xy[p[1]], w.a, w.b) for w in plan.walls) for p in pairs
    }
    return Topology(
        rooms=rooms,
        bulbs=bulbs,
        bulb_room=room_of,
        bulb_xy=xy,
        bulb_height={i: by_id[i].height for i in bulbs},
        adjacent=adjacent,
        neighbours=neighbours,
        entrances=frozenset(room.id for room in plan.rooms if room.entrance),
        pairs=pairs,
        directions=tuple((rx, tx) for rx in bulbs for tx in bulbs if rx != tx),
        excluded=frozenset((e.rx, e.tx) for e in plan.excluded_directions),
        crossed=crossed,
        hard_wall=hard,
        centres={room.id: centroid(room.outline) for room in plan.rooms},
    )


def _crossed(plan: Plan, a: Point, b: Point, ends: set[str | None]) -> frozenset[str]:
    found: set[str] = set()
    for i in range(1, SEGMENT_SAMPLES):
        s = i / SEGMENT_SAMPLES
        room = room_at(plan, (a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1])))
        if room is not None and room not in ends:
            found.add(room)
    return frozenset(found)
