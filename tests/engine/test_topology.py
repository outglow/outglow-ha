import math
import time

from engine.topology import (
    adjacency,
    boundary_distance,
    build,
    bulb_room,
    encloses,
    outlines_overlap,
    pair_of,
    point_in_polygon,
    polygon_area,
    room_at,
    rooms_touch,
    segment_distance,
    segments_cross,
)
from engine.types import ExcludedDirection, Plan, PlanBulb, Room
from tests.engine.helpers import B1, B2, B3, B4, FLAT3, TWO, square


def test_polygon_and_segment_helpers() -> None:
    box = square(0, 0, 2, 2)
    assert point_in_polygon((1, 1), box)
    assert not point_in_polygon((3, 1), box)
    assert segment_distance((1, 1), (0, 0), (0, 0)) == 2**0.5
    assert segment_distance((1, 5), (0, 0), (2, 0)) == 5
    assert segments_cross((0, 0), (2, 2), (0, 2), (2, 0))
    assert not segments_cross((0, 0), (1, 0), (0, 1), (1, 1))
    assert boundary_distance((1, 1), box) == 1


ELL = ((0.0, 0.0), (4.0, 0.0), (4.0, 1.0), (1.0, 1.0), (1.0, 4.0), (0.0, 4.0))
NOOK = square(1, 1, 4, 4)


def test_an_l_shaped_room_and_the_room_in_its_corner_do_not_overlap() -> None:
    assert point_in_polygon((10 / 6, 10 / 6), NOOK)
    assert not outlines_overlap(ELL, NOOK)
    assert not outlines_overlap(NOOK, ELL)
    assert not outlines_overlap(ELL, square(4, 0, 6, 1))
    assert not outlines_overlap(square(0, 0, 2, 2), square(2, 0, 4, 2))
    assert not outlines_overlap(square(0, 0, 2, 2), square(5, 5, 6, 6))


def test_rooms_overlap_when_they_share_only_part_of_their_floor() -> None:
    assert outlines_overlap(square(0, 0, 2, 2), square(1, 1, 3, 3))
    assert outlines_overlap(ELL, square(0.5, 0.5, 2, 2))
    assert outlines_overlap(square(0, 0, 4, 1), square(1, -1, 2, 2))
    assert outlines_overlap(square(0, 0, 2, 2), ((1.0, 1.0), (3.0, 1.0), (2.0, 3.0)))
    assert outlines_overlap(((0.0, 0.0), (2.0, 0.0), (2.0, 2.0)), ((1.0, 0.0), (3.0, 0.0), (3.0, 2.0), (1.0, 2.0)))
    assert not outlines_overlap(((0.0, 0.0), (2.0, 2.0), (0.0, 2.0)), ((0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (1.0, 1.0)))
    assert not outlines_overlap(square(0, 0, 2, 2), ((0.0, 0.0), (1.0, 0.0)))


def test_a_room_inside_another_is_nested_not_overlapping() -> None:
    assert not outlines_overlap(square(0, 0, 4, 4), square(1, 1, 2, 2))
    assert not outlines_overlap(square(1, 1, 2, 2), square(0, 0, 4, 4))
    assert not outlines_overlap(square(0, 0, 4, 4), square(0, 0, 2, 2))
    assert not outlines_overlap(square(0, 0, 4, 4), square(0, 1, 4, 2))
    assert not outlines_overlap(square(0, 0, 2, 2), square(0, 0, 2, 2))
    assert not outlines_overlap(square(0, 0, 2, 2), ((0.0, 0.0), (2.0, 0.0), (2.0, 2.0)))
    assert not outlines_overlap(((0.0, 0.0), (2.0, 0.0), (2.0, 2.0)), square(0, 0, 2, 2))
    assert not outlines_overlap(ELL, square(0, 0, 1, 1))
    assert encloses(square(0, 0, 4, 4), square(0, 0, 2, 2))
    assert not encloses(square(0, 0, 2, 2), square(0, 0, 4, 4))
    assert not encloses(ELL, square(0, 0, 2, 2))
    assert not encloses(square(0, 0, 4, 1), square(1, -1, 2, 2))


SLOPE = ((0.0, 0.0), (3.7, 0.0), (0.0, 2.3))


def _on_slope(t: float, off: float) -> tuple[float, float]:
    n = math.hypot(3.7, 2.3)
    return (3.7 * (1 - t) + off * 2.3 / n, 2.3 * t + off * 3.7 / n)


def test_a_corner_snapped_to_a_slanted_wall_within_a_millimetre_is_not_an_overlap() -> None:
    for t in (0.1, 0.3, 0.5, 0.7, 0.9):
        for off in (-0.0004, 0.00005, 0.0004, 0.0009):
            p = _on_slope(t, off)
            inner = ((0.0, 0.0), (p[0], 0.0), p, (0.0, p[1]))
            assert not outlines_overlap(SLOPE, inner), (t, off)
            q = _on_slope(t + 0.05, -off)
            beside = (p, (p[0] + 2, p[1] + 2), (q[0] + 2, q[1] + 2), q)
            assert not outlines_overlap(SLOPE, beside), (t, off)
        p = _on_slope(t, 0.01)
        assert outlines_overlap(SLOPE, ((0.0, 0.0), (p[0], 0.0), p, (0.0, p[1])))


def _traced(cx: float, cy: float, r: float, n: int) -> tuple[tuple[float, float], ...]:
    per = n // 4
    out = []
    for side in range(4):
        for i in range(per):
            s = 2 * r * i / per
            x, y = ((-r + s, -r), (r, -r + s), (r - s, r), (-r, r - s))[side]
            out.append((cx + x, cy + y + 0.01 * math.sin(i * 1.7) * (side % 2 == 0)))
    return tuple(out)


def test_many_detailed_rooms_are_checked_for_overlap_quickly() -> None:
    rooms = [_traced((i % 5) * 4.0, (i // 5) * 4.0, 1.99, 200) for i in range(20)]
    start = time.process_time()
    hits = sum(outlines_overlap(a, b) for i, a in enumerate(rooms) for b in rooms[i + 1 :])
    assert hits == 0
    assert time.process_time() - start < 0.1


def test_adjacency_is_explicit_or_derived() -> None:
    assert adjacency(FLAT3) == {frozenset(("living", "hall")), frozenset(("hall", "office"))}
    derived = adjacency(TWO)
    assert derived == {frozenset(("a", "b"))}
    far = Room(id="c", name="C", outline=square(20, 20, 22, 22))
    assert not rooms_touch(TWO.rooms[0], far)
    assert adjacency(Plan(rooms=(*TWO.rooms, far), adjacent=(("a", "zzz"), ("a", "a")))) == derived


def test_plan_without_doors_or_adjacency_gets_it_from_touching_walls() -> None:
    plan = Plan(
        rooms=(
            Room(id="office", name="Office", outline=square(0, 0, 3, 4)),
            Room(id="hall", name="Hall", outline=square(0, 4, 6, 5)),
            Room(id="bath", name="Bath", outline=square(4, 0, 6, 4)),
            Room(id="living", name="Living", outline=((6, 6), (6, 0), (10, 0), (10, 3), (8, 3), (8, 6))),
            Room(id="bed", name="Bed", outline=square(10, 0, 13, 3)),
        ),
        bulbs=(PlanBulb(ieee=B1, x=1, y=2), PlanBulb(ieee=B2, x=9, y=1)),
    )
    pairs = {tuple(sorted(p)) for p in adjacency(plan)}
    assert pairs == {("hall", "office"), ("bath", "hall"), ("hall", "living"), ("bath", "living"), ("bed", "living")}
    topo = build(plan)
    assert topo.neighbours["bath"] == {"hall", "living"}
    assert topo.crossed[(B1, B2)] >= {"bath"}


def test_a_room_inside_another_is_its_neighbour() -> None:
    living = Room(id="living", name="Living", outline=square(0, 0, 6, 4))
    closet = Room(id="closet", name="Closet", outline=square(0, 0, 1.5, 1.5))
    island = Room(id="island", name="Island", outline=square(2.5, 1.5, 3.5, 2.5))
    core = Room(id="core", name="Core", outline=square(2.8, 1.8, 3.2, 2.2))
    line = Room(id="line", name="Line", outline=((2.9, 1.9), (3.1, 2.1)))
    bath = Room(id="bath", name="Bath", outline=square(6, 0, 9, 4))
    plan = Plan(
        rooms=(living, closet, island, core, line, bath),
        bulbs=(PlanBulb(ieee=B1, x=3.4, y=2.4), PlanBulb(ieee=B2, x=5, y=3), PlanBulb(ieee=B3, x=3, y=2)),
    )
    pairs = {tuple(sorted(p)) for p in adjacency(plan)}
    assert pairs == {
        ("closet", "living"),
        ("island", "living"),
        ("core", "island"),
        ("core", "line"),
        ("bath", "living"),
    }
    topo = build(plan)
    assert topo.neighbours["island"] == {"living", "core"}
    assert topo.neighbours["living"] == {"closet", "island", "bath"}
    assert topo.bulb_room == {B1: "island", B2: "living", B3: "core"}
    door = Plan(rooms=plan.rooms, adjacent=(("living", "island"),), bulbs=plan.bulbs)
    assert build(door).neighbours["island"] == {"living"}


def test_bulb_rooms_follow_override_then_position() -> None:
    plan = Plan(
        rooms=TWO.rooms,
        bulbs=(
            PlanBulb(ieee=B1, x=1, y=1, room="b"),
            PlanBulb(ieee=B2, x=1, y=1, room="nope"),
            PlanBulb(ieee=B3, x=9, y=9),
        ),
    )
    assert [bulb_room(plan, b) for b in plan.bulbs] == ["b", "a", None]


def test_a_point_in_nested_rooms_belongs_to_the_smallest() -> None:
    big = Room(id="big", name="Big", outline=square(0, 0, 10, 10))
    small = Room(id="small", name="Small", outline=square(2, 2, 4, 4))
    line = Room(id="line", name="Line", outline=((0, 0), (10, 10)))
    assert polygon_area(big.outline) == 100
    for rooms in ((big, small), (small, big), (line, big, small)):
        plan = Plan(rooms=rooms)
        assert room_at(plan, (3, 3)) == "small"
        assert room_at(plan, (8, 8)) == "big"
        assert room_at(plan, (11, 3)) is None


def test_build_flat3() -> None:
    plan = Plan(
        **{**{f: getattr(FLAT3, f) for f in FLAT3.__slots__}, "excluded_directions": (ExcludedDirection(B1, B2),)}
    )
    topo = build(plan)
    assert topo.rooms == ("living", "hall", "office")
    assert topo.bulb_room == {B1: "living", B2: "living", B3: "hall", B4: "office"}
    assert len(topo.pairs) == 6
    assert len(topo.directions) == 12
    assert topo.excluded == {(B1, B2)}
    assert topo.neighbours["hall"] == {"living", "office"}
    assert topo.entrances == {"hall"}
    assert topo.hard_wall[(B2, B4)]
    assert not topo.hard_wall[(B1, B2)]
    assert topo.is_adjacent("living", "hall")
    assert not topo.is_adjacent("living", None)
    assert topo.explainers((B3, B4)) >= {"hall", "office"}
    assert topo.connected(["living", "hall"])
    assert topo.connected(["hall"])
    assert not topo.connected(["living", "office"])
    assert pair_of(B2, B1) == (B1, B2)


def test_crossed_rooms() -> None:
    plan = Plan(
        rooms=(
            Room(id="a", name="A", outline=square(0, 0, 2, 2)),
            Room(id="m", name="M", outline=square(2, 0, 4, 2)),
            Room(id="b", name="B", outline=square(4, 0, 6, 2)),
        ),
        bulbs=(PlanBulb(ieee=B1, x=1, y=1), PlanBulb(ieee=B2, x=5, y=1)),
    )
    assert build(plan).crossed[(B1, B2)] == {"m"}
