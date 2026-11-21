from engine.topology import (
    adjacency,
    boundary_distance,
    build,
    bulb_room,
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
