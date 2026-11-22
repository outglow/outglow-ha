import base64
import cmath
import json
import math
import os
import time
import tracemalloc
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from custom_components.outglow import plan_import, valetudo, valetudo_fetch
from custom_components.outglow.engine import Engine, from_json, to_json
from custom_components.outglow.engine.defaults import HIST_BINS
from custom_components.outglow.engine.types import ExcludedDirection, Plan, PlanBulb, Room, Settings, Wall
from custom_components.outglow.errors import OutglowError
from tests.integration.common import plan_json, time_scale
from tools import valetudo_synth
from tools.valetudo_synth import Cells, compressed, rect, union

SCALE = time_scale(os.environ)

ROOT = Path(__file__).resolve().parents[2]
FLAT = ROOT / "tests" / "fixtures" / "valetudo" / "flat.json"
FETCH = ROOT / "tests" / "fixtures" / "ws" / "plan_valetudo_fetch.json"


def segment(key: str, cells: Cells, name: str | None = None) -> dict[str, Any]:
    meta: dict[str, Any] = {"segmentId": key}
    if name is not None:
        meta["name"] = name
    return {"type": "segment", "metaData": meta, "compressedPixels": compressed(cells)}


def vmap(*layers: dict[str, Any], pixel: float = 5, walls: Cells | None = None) -> dict[str, Any]:
    extra = [{"type": "wall", "compressedPixels": compressed(walls)}] if walls else []
    return {"__class": "ValetudoMap", "pixelSize": pixel, "size": {"x": 4000, "y": 4000}, "layers": [*extra, *layers]}


def area(outline: tuple[tuple[float, float], ...]) -> float:
    n = len(outline)
    return abs(sum(outline[i][0] * outline[(i + 1) % n][1] - outline[(i + 1) % n][0] * outline[i][1] for i in range(n)))


def box(outline: tuple[tuple[float, float], ...]) -> tuple[float, float, float, float]:
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    return min(xs), min(ys), max(xs), max(ys)


def parse(data: dict[str, Any]) -> valetudo.Parsed:
    return valetudo.parse(valetudo.decode(data))


def test_a_rectangle_becomes_a_room_in_metres_with_its_name() -> None:
    parsed = parse(vmap(segment("4", rect(100, 200, 139, 259), "Kitchen")))
    (room,) = parsed.rooms
    assert (room.id, room.name) == ("kitchen", "Kitchen")
    assert len(room.outline) == 4
    x0, y0, x1, y1 = box(room.outline)
    assert x1 - x0 == pytest.approx(2.0 + 2 * valetudo.GROW_M, abs=0.01)
    assert y1 - y0 == pytest.approx(3.0 + 2 * valetudo.GROW_M, abs=0.01)
    assert (x0, y0) == pytest.approx((5.0 - valetudo.GROW_M, 10.0 - valetudo.GROW_M), abs=0.01)
    assert parsed.walls == []
    assert parsed.doors == []
    assert parsed.adjacent == []
    assert parsed.backdrop.m_per_px == 0.05


def test_scale_follows_the_pixel_size() -> None:
    fine = parse(vmap(segment("1", rect(200, 400, 279, 519)), pixel=2.5)).rooms[0]
    coarse = parse(vmap(segment("1", rect(100, 200, 139, 259)), pixel=5)).rooms[0]
    assert box(fine.outline) == pytest.approx(box(coarse.outline), abs=0.02)
    assert fine.name == "Room 1"


def test_an_l_shape_keeps_six_right_angles() -> None:
    (room,) = parse(vmap(segment("1", union(rect(100, 100, 139, 199), rect(140, 160, 199, 199)), "Hall"))).rooms
    assert len(room.outline) == 6
    for i, (x, y) in enumerate(room.outline):
        nx, ny = room.outline[(i + 1) % 6]
        assert x == pytest.approx(nx) or y == pytest.approx(ny)


def test_jagged_edges_are_simplified() -> None:
    teeth = {(x, 99) for x in range(100, 160, 4)} | {(x, 160) for x in range(102, 160, 6)}
    (room,) = parse(vmap(segment("1", rect(100, 100, 159, 159) | teeth))).rooms
    assert len(room.outline) == 4


def test_holes_are_filled_and_names_are_transliterated() -> None:
    ring = rect(100, 100, 159, 159) - rect(120, 120, 139, 139)
    (room,) = parse(vmap(segment("11", ring, "Łazienka Ünd Küche"))).rooms
    assert room.id == "lazienka_und_kuche"
    assert area(room.outline) / 2 == pytest.approx((3 + 2 * valetudo.GROW_M) ** 2, rel=0.02)


def test_segments_touching_over_a_doorway_share_a_wall_with_a_door() -> None:
    left = union(rect(100, 100, 159, 159), rect(160, 120, 161, 137))
    right = union(rect(164, 100, 219, 159), rect(162, 120, 163, 137))
    wall = rect(160, 100, 163, 159) - left - right
    parsed = parse(vmap(segment("1", left, "Living"), segment("2", right, "Bedroom"), walls=wall))
    assert parsed.adjacent == [("living", "bedroom")]
    (door,) = parsed.doors
    assert door.kind == "door"
    assert door.width == pytest.approx(0.9)
    shared = parsed.walls[door.wall]
    assert shared.a[0] == shared.b[0] == pytest.approx(8.1, abs=0.1)
    centre = shared.a[1] + door.at * (shared.b[1] - shared.a[1])
    assert centre == pytest.approx(6.45, abs=0.06)
    rooms = {r.id: r for r in parsed.rooms}
    assert box(rooms["living"].outline)[2] == box(rooms["bedroom"].outline)[0]


def test_a_wide_contact_is_an_opening_and_a_thin_wall_is_not_a_door() -> None:
    a, b = rect(100, 100, 159, 159), rect(160, 100, 219, 159)
    c = rect(100, 164, 219, 199)
    parsed = parse(
        vmap(segment("1", a, "A"), segment("2", b, "B"), segment("3", c, "C"), walls=rect(100, 160, 219, 163))
    )
    assert [(d.kind, d.width) for d in parsed.doors] == [("opening", 3.0)]
    assert parsed.adjacent == [("a", "b")]
    assert len(parsed.walls) >= 3


def test_far_apart_segments_share_nothing() -> None:
    parsed = parse(vmap(segment("1", rect(100, 100, 139, 139)), segment("2", rect(160, 100, 199, 139))))
    assert parsed.walls == []
    assert parsed.adjacent == []


def test_tiny_segments_and_stray_parts_are_dropped_with_a_warning() -> None:
    main = rect(100, 100, 159, 159)
    stray = rect(300, 300, 319, 319)
    parsed = parse(vmap(segment("1", main | stray, "Main"), segment("2", rect(400, 400, 402, 402))))
    assert [r.id for r in parsed.rooms] == ["main"]
    assert area(parsed.rooms[0].outline) / 2 < 12
    codes = [(w["code"], w["params"]["segment"]) for w in parsed.warnings]
    assert codes == [("dropped_segment", "2"), ("dropped_segment", "1")]


def test_plain_pixels_read_like_compressed_ones() -> None:
    cells = rect(100, 100, 129, 129)
    plain = {"type": "segment", "metaData": {"segmentId": "1"}, "pixels": [v for c in sorted(cells) for v in c]}
    assert parse(vmap(plain)).rooms == parse(vmap(segment("1", cells))).rooms


def test_names_stay_unique() -> None:
    parsed = parse(vmap(segment("1", rect(100, 100, 129, 129), "Room"), segment("2", rect(200, 100, 229, 129), "Room")))
    assert [r.id for r in parsed.rooms] == ["room", "room_2"]


def test_the_backdrop_draws_floor_and_walls() -> None:
    parsed = parse(vmap(segment("1", rect(100, 100, 109, 109)), walls=rect(98, 98, 111, 99)))
    assert parsed.backdrop.svg is not None
    svg = parsed.backdrop.svg.decode()
    assert svg.startswith("<svg")
    assert svg.count("<path") == 2
    assert parsed.backdrop.x == parsed.backdrop.y == pytest.approx((98 - valetudo.GROW_M / 0.05 - 2) * 0.05)


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ([], "JSON object"),
        ({"layers": []}, "pixelSize"),
        ({"pixelSize": True, "layers": []}, "pixelSize"),
        ({"pixelSize": 5}, "no layers"),
        ({"pixelSize": 5, "layers": []}, "empty"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "compressedPixels": [1, 2]}]}, "triples"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [1, 2, 3]}]}, "pairs"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [1.5, 2]}]}, "whole"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [-1, 2]}]}, "range"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [True, 2]}]}, "whole"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [math.nan, 2]}]}, "whole"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [math.inf, 2]}]}, "whole"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [2**70, 2]}]}, "range"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "compressedPixels": [0, 0, 90_000] * 50}]}, "too many"),
        ({"pixelSize": 5, "layers": [{"type": "wall", "pixels": [0, 0, 99_000, 99_000]}]}, "too large"),
        ({"pixelSize": 5, "layers": [{"type": "segment"}] * 251}, "segments"),
    ],
)
def test_broken_maps_are_rejected(data: object, message: str) -> None:
    with pytest.raises(valetudo.MapError, match=message):
        parse(data)  # type: ignore[arg-type]


def test_odd_layers_are_skipped() -> None:
    data = vmap(segment("1", rect(10, 10, 29, 29)))
    data["layers"] += ["junk", {"type": "segment", "metaData": "x"}, {"type": "charger"}]
    assert len(parse(data).rooms) == 1


def test_a_map_without_segments_gives_a_backdrop_and_a_warning() -> None:
    result = plan_import.load("auto", json.dumps(vmap(walls=rect(10, 10, 50, 11))), {})
    assert result.source == "valetudo_map"
    assert result.plan.rooms == ()
    assert result.background is not None
    assert result.plan.background is not None
    assert result.plan.background.file == plan_import.background_file(result.background, "svg")
    assert [w["code"] for w in result.warnings] == ["no_segments"]


def test_rooms_without_any_doorway_are_flagged() -> None:
    data = vmap(segment("1", rect(100, 100, 139, 139)), segment("2", rect(200, 100, 239, 139)))
    assert [w["code"] for w in plan_import.load("auto", json.dumps(data), {}).warnings] == [
        "no_doors",
        "room_without_bulb",
        "room_without_bulb",
    ]


def test_broken_maps_are_an_invalid_format() -> None:
    with pytest.raises(OutglowError) as err:
        plan_import.load("valetudo_json", json.dumps({"pixelSize": 5, "layers": []}), {})
    assert err.value.code == "invalid_format"


def test_a_big_sparse_map_is_fast() -> None:
    layers = [
        segment(str(i), rect(x, y, x + 99, y + 79), f"Room {i}")
        for i, (x, y) in enumerate([(5, 5), (3890, 5), (5, 3910), (3890, 3910), (1900, 1900)])
    ]
    data = vmap(*layers, walls={(x, 3) for x in range(4000)} | {(3, y) for y in range(4000)})
    text = json.dumps(data)
    start = time.perf_counter()
    result = plan_import.load("auto", text, {})
    assert time.perf_counter() - start < 3.0 * SCALE
    assert len(result.plan.rooms) == 5


def test_the_synthetic_flat_is_current_and_parses() -> None:
    assert FLAT.read_text() == json.dumps(valetudo_synth.flat(), separators=(",", ":")) + "\n"
    result = plan_import.load("auto", FLAT.read_text(), {})
    assert [r.name for r in result.plan.rooms] == ["Living room", "Kitchen", "Hall", "Room 7"]
    assert {frozenset(p) for p in result.plan.adjacent} == {
        frozenset(("living_room", "kitchen")),
        frozenset(("living_room", "hall")),
        frozenset(("hall", "room_7")),
    }
    assert len(result.plan.doors) == 3
    assert next(w["code"] for w in result.warnings) == "dropped_segment"
    fixture = json.loads(FETCH.read_text())["response"]
    assert fixture["plan"] == to_json(result.plan)
    assert fixture["warnings"] == result.warnings
    assert result.background is not None
    assert base64.b64decode(fixture["background_image"]["data_base64"]) == result.background


def test_two_maps_placed_alike_get_backgrounds_named_by_their_pictures() -> None:
    first = valetudo_synth.flat()
    second = json.loads(json.dumps(first))
    floor = next(layer for layer in second["layers"] if layer["type"] == "floor")
    pairs = zip(floor["pixels"][0::2], floor["pixels"][1::2], strict=True)
    floor["pixels"] = [v for x, y in pairs if not (236 <= x <= 238 and 130 <= y <= 132) for v in (x, y)]
    a = plan_import.load("auto", json.dumps(first), {})
    b = plan_import.load("auto", json.dumps(second), {})
    assert a.plan.background is not None
    assert b.plan.background is not None
    assert replace(a.plan.background, file="") == replace(b.plan.background, file="")
    assert a.background != b.background
    assert a.plan.background.file != b.plan.background.file
    assert a.plan.background.file == plan_import.background_file(a.background or b"", "svg")


def test_auto_recognises_every_format() -> None:
    plan = plan_json()
    cases = {
        json.dumps(plan): "outglow_plan",
        json.dumps({"rev": 3, "plan": plan}): "outglow_plan",
        json.dumps({"layout": {"bulbs": []}}): "prototype_layout",
        "rooms:\n  a:\n    outline: [[0,0],[1,0],[1,1]]\n": "prototype_yaml",
        FLAT.read_text(): "valetudo_map",
    }
    for text, source in cases.items():
        assert plan_import.load("auto", text, {}).source == source
    assert [r.id for r in plan_import.load("auto", json.dumps({"rev": 3, "plan": plan}), {}).plan.rooms] == [
        "living",
        "hall",
        "office",
    ]
    assert plan_import.load("outglow_json", json.dumps(plan), {}).source == "outglow_plan"
    assert plan_import.load("valetudo_json", FLAT.read_text(), {}).source == "valetudo_map"
    for text in ("just words", "- a\n- list\n", "{nope", "rooms: ["):
        with pytest.raises(OutglowError) as err:
            plan_import.load("auto", text, {})
        assert err.value.code == "invalid_format"


def _overlaps(rooms: dict[str, Any]) -> list[dict[str, Any]]:
    text = json.dumps({"rooms": {name: {"outline": outline} for name, outline in rooms.items()}})
    return [w["params"] for w in plan_import.load("auto", text, {}).warnings if w["code"] == "overlapping_rooms"]


def test_only_rooms_that_share_part_of_their_floor_are_told_to_overlap() -> None:
    ell = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]]
    big = [[0, 0], [5, 0], [5, 5], [0, 5]]
    assert _overlaps({"ell": ell, "nook": [[1, 1], [4, 1], [4, 4], [1, 4]]}) == []
    assert _overlaps({"a": [[0, 0], [2, 0], [2, 2], [0, 2]], "b": [[1, 1], [3, 1], [3, 3], [1, 3]]}) == [
        {"a": "a", "b": "b"}
    ]
    assert _overlaps({"big": big, "small": [[1, 1], [2, 1], [2, 2], [1, 2]]}) == []
    assert _overlaps({"big": big, "alcove": [[0, 0], [2, 0], [2, 5], [0, 5]]}) == []


def test_too_much_text_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plan_import, "MAX_TEXT", 10)
    with pytest.raises(OutglowError, match="too large"):
        plan_import.load("auto", "x" * 11, {})


def test_only_a_valetudo_map_may_be_larger_than_a_plan() -> None:
    most = plan_import.MAX_PLAN_TEXT
    yaml_text = "rooms:\n" + "- []\n" * (most // 5)
    plan_text = json.dumps({"rooms": [], "padding": " " * most})
    for fmt, text in (
        ("auto", yaml_text),
        ("mieszkanie_yaml", yaml_text),
        ("auto", plan_text),
        ("outglow_json", plan_text),
        ("auto", json.dumps([[]] * most)),
    ):
        started = time.thread_time()
        with pytest.raises(OutglowError, match="too large"):
            plan_import.load(fmt, text, {})
        assert time.thread_time() - started < 1.0 * SCALE
    lists = "[" + "[]," * (plan_import.MAX_TEXT // 3 - 1) + "[]]"
    tracemalloc.start()
    with pytest.raises(OutglowError, match="too large"):
        plan_import.load("auto", lists, {})
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert peak < 1024 * 1024
    padded = FLAT.read_text().strip()[:-1] + ',"padding":"' + " " * most + '"}'
    assert plan_import.load("auto", padded, {}).source == "valetudo_map"
    assert plan_import.load("valetudo_json", padded, {}).source == "valetudo_map"


def many(rooms: int, corners: int = 3, bulbs: int = 0, overlap: bool = False) -> dict[str, Any]:
    def outline(i: int) -> list[list[float]]:
        x = 0.02 * i if overlap else float(i % 20) * 3
        y = 0.0 if overlap else float(i // 20) * 3
        return [
            [x + 1 + math.cos(2 * math.pi * k / corners), y + 1 + math.sin(2 * math.pi * k / corners)]
            for k in range(corners)
        ]

    return {
        "rooms": [{"id": f"r{i}", "name": f"R{i}", "outline": outline(i)} for i in range(rooms)],
        "bulbs": [{"ieee": f"0x{i + 1:016x}", "x": 1.0, "y": 1.0} for i in range(bulbs)],
    }


def test_too_many_rooms_corners_or_bulbs_are_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    for data, what in (
        (many(plan_import.MAX_ROOMS + 1), "rooms"),
        (many(1, bulbs=plan_import.MAX_BULBS + 1), "bulbs"),
        (many(2, corners=plan_import.MAX_VERTICES // 2 + 1), "room corners"),
    ):
        with pytest.raises(OutglowError, match=f"too many {what}: [0-9]+, at most [0-9]+$"):
            plan_import.build("outglow_plan", data, {})
    assert len(plan_import.build("outglow_plan", many(plan_import.MAX_ROOMS), {}).plan.rooms) == plan_import.MAX_ROOMS
    current = from_json(Plan, {**plan_json(), "bulbs": many(1, bulbs=plan_import.KEPT_BULBS + 1)["bulbs"]})
    with pytest.raises(OutglowError, match="The current plan has too many bulbs"):
        plan_import.load("auto", FLAT.read_text(), {}, current)
    monkeypatch.setattr(plan_import, "MAX_WALLS", 1)
    walls = {**many(1), "walls": [{"a": [0, 0], "b": [1, 0]}] * 2}
    with pytest.raises(OutglowError, match="too many walls"):
        plan_import.build("outglow_plan", walls, {})


def grid(rooms: int, corners: int, bulbs: int, adjacent: bool = True, outside: bool = False) -> Plan:
    side = math.ceil(math.sqrt(rooms))

    def outline(i: int) -> tuple[tuple[float, float], ...]:
        x0, y0 = (i % side) * 4.0, (i // side) * 4.0
        per = corners // 4
        edge = [(x0 + 3.9 * k / per, y0) for k in range(per)] + [(x0 + 3.9, y0 + 3.9 * k / per) for k in range(per)]
        back = [(x0 + 3.9 - 3.9 * k / per, y0 + 3.9) for k in range(per)] + [
            (x0, y0 + 3.9 - 3.9 * k / per) for k in range(per)
        ]
        return tuple(edge + back)

    def spot(i: int) -> tuple[float, float]:
        if outside:
            return -50.0 - i % 10, -50.0 - i * 0.37
        room = i % rooms
        return (room % side) * 4.0 + 1 + (i // rooms) * 0.01, (room // side) * 4.0 + 2

    return Plan(
        rooms=tuple(Room(id=f"r{i}", name=f"R{i}", outline=outline(i)) for i in range(rooms)),
        bulbs=tuple(PlanBulb(ieee=f"0x{i + 1:016x}", x=spot(i)[0], y=spot(i)[1]) for i in range(bulbs)),
        adjacent=tuple((f"r{i}", f"r{i + 1}") for i in range(rooms - 1)) if adjacent else (),
    )


def most_bulbs(rooms: int, corners: int, adjacent: bool = True, outside: bool = False) -> int:
    bulbs = 0
    while plan_import.excess(grid(rooms, corners, bulbs + 1, adjacent, outside)) is None:
        bulbs += 1
    return bulbs


def test_the_largest_plans_let_in_build_an_engine_in_bounded_time() -> None:
    for rooms, corners, adjacent, outside in (
        (40, 48, True, False),
        (20, 4, True, False),
        (5, 4, True, False),
        (4, 500, True, True),
        (10, 120, False, False),
        (1, 2000, False, True),
    ):
        bulbs = most_bulbs(rooms, corners, adjacent, outside)
        assert 2 <= bulbs <= plan_import.MAX_BULBS
        plan = grid(rooms, corners, bulbs, adjacent, outside)
        assert plan_import.engine_cost(plan).total_us <= plan_import.ENGINE_BUDGET_US
        started = time.thread_time()
        Engine(plan, Settings())
        assert time.thread_time() - started < 1.5 * SCALE * plan_import.ENGINE_BUDGET_US / 1e6, (rooms, corners, bulbs)


def learned(plan: Plan) -> dict[str, Any]:
    topology = Engine(plan, Settings()).topology
    directions = [f"{rx}>{tx}" for rx, tx in topology.directions]
    active: dict[str, Any] = {
        "hist": {d: {"bins": [1.0] * HIST_BINS, "censored": 0.5} for d in directions},
        "bg_onsets": dict.fromkeys(directions, 0.5),
        "bg_ticks": 10000.0,
        "pair_bg": {f"{a}|{b}": [10.0, 1.0, 0.5] for a, b in topology.pairs},
        "emit": {f"{a}|{b}|{r}": [3.0, 2.0, 1.0] for a, b in topology.pairs for r in topology.rooms},
    }
    return {"active": active}


def rebuild_s(plan: Plan) -> float:
    old = Engine(plan, Settings(), learned(plan))
    started = time.thread_time()
    Engine(plan, Settings(), old.model_state()).inherit(old).tick(1000.0)
    return time.thread_time() - started


def partitions(plan: Plan, count: int) -> Plan:
    return replace(
        plan, walls=tuple(Wall(a=(-30.0 - k * 0.01, -30.0), b=(-30.0 - k * 0.01, -29.0)) for k in range(count))
    )


def test_the_estimate_covers_a_learned_model_and_every_wall() -> None:
    plan = grid(5, 4, most_bulbs(5, 4))
    walled = partitions(plan, plan_import.MAX_WALLS)
    pairs = len(plan.bulbs) * (len(plan.bulbs) - 1) / 2
    grown = plan_import.engine_cost(walled).total_us - plan_import.engine_cost(plan).total_us
    assert grown == pytest.approx(pairs * plan_import.MAX_WALLS * plan_import.PAIR_WALL_US)
    bulbs = 2
    while plan_import.excess(partitions(grid(1, 4, bulbs + 1), plan_import.MAX_WALLS)) is None:
        bulbs += 1
    for shown in (plan, grid(12, 4, most_bulbs(12, 4)), partitions(grid(1, 4, bulbs), plan_import.MAX_WALLS)):
        estimate = plan_import.engine_cost(shown).total_us / 1e6
        assert rebuild_s(shown) < 1.5 * SCALE * estimate, (len(shown.rooms), len(shown.bulbs))


def test_a_plan_too_large_to_sense_names_the_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    bulbs = most_bulbs(20, 4)
    with pytest.raises(
        OutglowError,
        match=f"The plan is too large to sense in time: {bulbs + 1} bulbs with 20 rooms and 80 room corners,"
        f" at most {bulbs} bulbs with these rooms$",
    ):
        plan_import.limit(grid(20, 4, bulbs + 1))
    assert plan_import.excess(grid(20, 4, bulbs)) is None
    assert 40 <= bulbs <= 70
    assert most_bulbs(5, 4) == most_bulbs(8, 4) == plan_import.MAX_BULBS
    assert 60 < most_bulbs(12, 4) < plan_import.MAX_BULBS
    assert 15 < most_bulbs(40, 4) < 30
    detailed = grid(10, 200, 0, adjacent=False)
    assert plan_import.engine_cost(detailed).fixed_us < plan_import.ENGINE_BUDGET_US
    assert plan_import.excess(detailed) is None
    monkeypatch.setattr(plan_import, "ENGINE_BUDGET_US", plan_import.engine_cost(detailed).fixed_us / 2)
    assert plan_import.excess(replace(detailed, adjacent=(("r0", "r1"),))) is None
    assert plan_import.excess(detailed) == (
        "The plan is too detailed to sense in time: 2000 room corners in rooms with no doors between them;"
        " add the doors or simplify the rooms"
    )


def test_a_current_plan_from_before_the_limits_still_keeps_its_bulbs() -> None:
    current = grid(plan_import.MAX_ROOMS + 5, 4, 3)
    assert plan_import.excess(current) is not None
    result = plan_import.load("auto", FLAT.read_text(), {}, current)
    assert result.kept is not None
    assert {b.ieee for b in result.plan.bulbs} == {b.ieee for b in current.bulbs}


def test_checking_a_large_plan_stays_quick(monkeypatch: pytest.MonkeyPatch) -> None:
    corners = plan_import.MAX_VERTICES // plan_import.MAX_ROOMS
    plan = from_json(Plan, many(plan_import.MAX_ROOMS, corners, plan_import.MAX_BULBS))
    warnings = plan_import._Warnings()
    started = time.thread_time()
    plan_import.check(plan, {}, warnings)
    assert time.thread_time() - started < 1.0 * SCALE
    assert not [w for w in warnings.items if w["code"] == "overlapping_rooms"]
    stacked = many(30, overlap=True)
    result = plan_import.build("outglow_plan", stacked, {})
    assert len([w for w in result.warnings if w["code"] == "overlapping_rooms"]) == 30 * 29 // 2
    monkeypatch.setattr(plan_import, "CHECK_BUDGET_S", -1.0)
    with pytest.raises(OutglowError, match="too complex"):
        plan_import.build("outglow_plan", stacked, {})


def test_bulb_positions_go_through_the_room_boxes_and_the_clock(monkeypatch: pytest.MonkeyPatch) -> None:
    plan = grid(9, 8, 30)
    plan = replace(plan, bulbs=(*plan.bulbs, PlanBulb(ieee="0x00000000000000ff", x=100.0, y=100.0, room="r1")))
    found = plan_import.positions(plan, plan_import._Rooms(plan.rooms, plan_import._Clock()))
    assert found == {b.ieee: plan_import.room_of((b.x, b.y), plan.rooms) for b in plan.bulbs}
    assert found["0x00000000000000ff"] is None
    with pytest.raises(OutglowError, match="too complex"):
        plan_import.positions(plan, plan_import._Rooms(plan.rooms, plan_import._Clock(-1.0)))


def test_rooms_found_through_their_boxes_match_a_plain_search() -> None:
    rooms = (
        Room(id="big", name="Big", outline=((0, 0), (10, 0), (10, 10), (0, 10))),
        Room(id="l", name="L", outline=((12, 0), (16, 0), (16, 2), (14, 2), (14, 6), (12, 6))),
        Room(id="flat", name="Flat", outline=((20, 0), (21, 0))),
    )
    index = plan_import._Rooms(rooms, plan_import._Clock())
    for x in range(-1, 23):
        for y in range(-1, 12):
            point = (x + 0.5, y + 0.5)
            assert index.at(point) == plan_import.room_of(point, rooms)


def turned(plan: Plan, mirror: bool) -> Plan:
    def move(x: float, y: float) -> tuple[float, float]:
        return (-y + 20.0, (-x if mirror else x) + 3.0)

    return replace(
        plan,
        rooms=tuple(replace(r, outline=tuple(move(*p) for p in r.outline)) for r in plan.rooms),
        bulbs=tuple(replace(b, x=move(b.x, b.y)[0], y=move(b.x, b.y)[1]) for b in plan.bulbs),
    )


def flat_current() -> Plan:
    rooms = (
        Room(id="salon", name="Living room", outline=((5, 5), (9, 5), (9, 8), (5, 8)), colour="#123456", area_id="lr"),
        Room(id="hall", name="Hall", outline=((5, 8.2), (7, 8.2), (7, 10.2), (10, 10.2), (10, 11.2), (5, 11.2))),
        Room(id="kitchen", name="Kitchen", outline=((9.2, 5), (11, 5), (11, 8), (9.2, 8)), entrance=True),
        Room(id="gone", name="Attic", outline=((30, 30), (31, 30), (31, 31))),
    )
    bulbs = (
        PlanBulb(ieee="0x0000000000000001", x=7.0, y=6.5),
        PlanBulb(ieee="0x0000000000000002", x=10.2, y=6.5, height="lamp"),
        PlanBulb(ieee="0x0000000000000003", x=6.0, y=10.0, room="hall"),
        PlanBulb(ieee="0x0000000000000004", x=8.0, y=6.0, room="kitchen"),
        PlanBulb(ieee="0x0000000000000005", x=30.5, y=30.2, room="gone"),
    )
    excluded = (ExcludedDirection(rx="0x0000000000000001", tx="0x0000000000000002", reason="noisy"),)
    return Plan(rooms=rooms, bulbs=bulbs, excluded_directions=excluded)


@pytest.mark.parametrize("mirror", [False, True])
def test_bulbs_of_the_current_plan_follow_the_rooms_onto_the_map(mirror: bool) -> None:
    current = turned(flat_current(), mirror)
    result = plan_import.load("auto", FLAT.read_text(), {}, current)
    rooms = {r.id: r for r in result.plan.rooms}
    assert set(rooms) == {"salon", "kitchen", "hall", "room_7"}
    assert (rooms["salon"].name, rooms["salon"].colour, rooms["salon"].area_id) == ("Living room", "#123456", "lr")
    assert rooms["kitchen"].entrance is True
    assert result.kept is not None
    assert result.kept["bulbs"] == 5
    assert result.kept["rooms"] == 3
    assert result.kept["aligned"] is True
    assert result.kept["mirrored"] is mirror
    assert result.kept["rotation_deg"] == pytest.approx(-90.0, abs=3)
    assert result.kept["rms_m"] < 0.3
    where = {b.ieee: (b.room, plan_import.room_of((b.x, b.y), result.plan.rooms)) for b in result.plan.bulbs}
    assert where["0x0000000000000001"] == (None, "salon")
    assert where["0x0000000000000002"] == (None, "kitchen")
    assert where["0x0000000000000003"] == (None, "hall")
    assert where["0x0000000000000004"] == ("kitchen", "salon")
    assert where["0x0000000000000005"][0] is None
    assert next(b for b in result.plan.bulbs if b.ieee == "0x0000000000000002").height == "lamp"
    assert result.plan.excluded_directions == current.excluded_directions
    assert {"code": "bulb_outside_rooms", "params": {"ieee": "0x0000000000000005"}} in result.warnings
    assert {frozenset(p) for p in result.plan.adjacent} >= {frozenset(("salon", "hall"))}


def test_bulbs_stay_put_when_no_room_matches() -> None:
    current = Plan(
        rooms=(Room(id="x", name="Elsewhere", outline=((0, 0), (1, 0), (1, 1))),),
        bulbs=(PlanBulb(ieee="0x0000000000000001", x=6.0, y=6.0, room="x"),),
    )
    result = plan_import.load("auto", FLAT.read_text(), {}, current)
    assert result.kept == {
        "bulbs": 1,
        "rooms": 0,
        "aligned": False,
        "rotation_deg": 0.0,
        "mirrored": False,
        "rms_m": None,
    }
    assert result.plan.bulbs[0].x == 6.0
    assert result.plan.bulbs[0].room is None
    assert {"code": "bulbs_not_aligned", "params": {"rooms": 0}} in result.warnings


def test_imported_bulbs_win_and_room_ids_do_not_clash() -> None:
    plan = from_json(Plan, plan_json())
    current = Plan(
        rooms=(Room(id="office", name="Hall", outline=((5, 0), (7, 0), (7, 6), (5, 6)), colour="#000000"),),
        bulbs=(
            PlanBulb(ieee="0x0000000000000001", x=99.0, y=99.0),
            PlanBulb(ieee="0x0000000000000009", x=6.0, y=1.0),
        ),
    )
    result = plan_import.load("auto", json.dumps({"layout": plan_json()}), {}, current)
    assert result.source == "prototype_layout"
    assert [r.id for r in result.plan.rooms] == ["living", "office", "office_2"]
    assert (result.plan.rooms[1].name, result.plan.rooms[1].colour) == ("Hall", "#f28b30")
    assert result.plan.rooms[1].entrance is True
    assert result.plan.bulbs[0] == plan.bulbs[0]
    assert result.plan.bulbs[-1].ieee == "0x0000000000000009"
    assert result.plan.bulbs[-1].x == pytest.approx(6.0)
    assert ["living", "office"] in [list(p) for p in result.plan.adjacent]
    assert result.kept is not None
    assert result.kept["rms_m"] is None
    assert result.kept["aligned"] is False


def test_an_outglow_plan_is_taken_as_it_is() -> None:
    exported = {
        **plan_json(),
        "floor_id": "upstairs",
        "north_deg": 12.0,
        "view_rotation_deg": 30.0,
        "retired_rooms": ["attic"],
    }
    current = replace(
        from_json(Plan, plan_json()),
        rooms=tuple(
            replace(r, name=r.name + " old", colour="#000000", area_id="old", entrance=not r.entrance)
            for r in from_json(Plan, plan_json()).rooms
        ),
        bulbs=(PlanBulb(ieee="0x00000000000000aa", x=1.0, y=1.0),),
        floor_id="downstairs",
        north_deg=45.0,
        view_rotation_deg=90.0,
    )
    result = plan_import.load("auto", json.dumps({"rev": 7, "plan": exported}), {}, current)
    assert result.source == "outglow_plan"
    assert result.kept is None
    assert to_json(result.plan) == {**exported, "rev": 0}


def centred(*centres: tuple[float, float], size: float = 2.0, prefix: str = "r") -> tuple[Room, ...]:
    return tuple(
        Room(
            id=f"{prefix}{i}",
            name=f"{prefix.upper()}{i}",
            outline=((x - size, y - size), (x + size, y - size), (x + size, y + size), (x - size, y + size)),
        )
        for i, (x, y) in enumerate(centres)
    )


def _keep(plan: Plan, current: Plan) -> plan_import.Imported:
    warnings = plan_import._Warnings()
    merged, kept = plan_import._keep(plan, current, warnings, carry_rooms=True)
    return plan_import.Imported(plan=merged, warnings=warnings.items, source="valetudo_map", kept=kept)


def test_one_matching_room_does_not_move_the_bulbs() -> None:
    result = _keep(Plan(rooms=centred((20, 20), (40, 20))), Plan(rooms=centred((2, 2)), bulbs=BULB))
    assert result.kept is not None
    assert (result.kept["aligned"], result.kept["rooms"], result.kept["rms_m"]) == (False, 1, None)
    assert result.plan.bulbs[0].x == BULB[0].x
    assert result.plan.bulbs[0].y == BULB[0].y
    assert {"code": "bulbs_not_aligned", "params": {"rooms": 1}} in result.warnings


def test_two_matching_rooms_do_not_move_the_bulbs() -> None:
    old = centred((2, 2), (8, 2), (20, 20), prefix="r")
    new = (*centred((10, 10), (10, 16), prefix="r"), *centred((30, 2), prefix="x"))
    current = Plan(rooms=old, bulbs=BULB, north_deg=10.0, view_rotation_deg=30.0)
    result = _keep(Plan(rooms=new), current)
    assert result.kept is not None
    assert (result.kept["aligned"], result.kept["rooms"], result.kept["rms_m"]) == (False, 2, None)
    assert (result.plan.bulbs[0].x, result.plan.bulbs[0].y) == (BULB[0].x, BULB[0].y)
    assert (result.plan.north_deg, result.plan.view_rotation_deg) == (10.0, 30.0)
    assert {"code": "bulbs_not_aligned", "params": {"rooms": 2}} in result.warnings
    three = _keep(Plan(rooms=centred((10, 10), (10, 16), (-8, 28))), current)
    assert three.kept is not None
    assert three.kept["aligned"] is True
    assert three.kept["rotation_deg"] == pytest.approx(90.0)
    assert (three.plan.bulbs[0].x, three.plan.bulbs[0].y) == pytest.approx((10.0, 10.0))


def compass(v: complex) -> float:
    return math.degrees(math.atan2(v.real, -v.imag)) % 360.0


def heading(deg: float) -> complex:
    return complex(math.sin(math.radians(deg)), -math.cos(math.radians(deg)))


@pytest.mark.parametrize("turn", [0.0, 60.0, -135.0])
@pytest.mark.parametrize("mirror", [False, True])
def test_north_follows_the_turn_and_the_mirror_of_the_rooms(turn: float, mirror: bool) -> None:
    spin = cmath.exp(1j * math.radians(turn))
    old = centred((0, 0), (9, 0), (0, 7), (9, 8))

    def move(p: tuple[float, float]) -> tuple[float, float]:
        z = spin * (complex(*p).conjugate() if mirror else complex(*p)) + complex(40, -3)
        return (z.real, z.imag)

    new = tuple(replace(r, outline=tuple(move(p) for p in r.outline)) for r in old)
    result = _keep(Plan(rooms=new), Plan(rooms=old, bulbs=BULB, north_deg=30.0, view_rotation_deg=15.0))
    assert result.kept is not None
    assert result.kept["mirrored"] is mirror
    north = heading(30.0)
    expected = compass(spin * (north.conjugate() if mirror else north))
    assert abs((result.plan.north_deg - expected + 180.0) % 360.0 - 180.0) < 0.11
    view = 15.0 if mirror else 15.0 - turn
    assert abs((result.plan.view_rotation_deg - view + 180.0) % 360.0 - 180.0) < 0.11


def test_three_rooms_in_a_row_are_never_mirrored() -> None:
    old = centred((0, 0), (4, 0.3), (8, 0))
    new = centred((10, 10), (10.3, 14), (10, 18))
    result = _keep(Plan(rooms=new), Plan(rooms=old, bulbs=BULB))
    assert result.kept is not None
    assert result.kept["mirrored"] is False
    assert result.kept["rotation_deg"] == pytest.approx(90.0, abs=5)


def test_a_mirror_needs_a_clearly_better_fit() -> None:
    old = centred((0, 0), (6, 0), (0, 5), (6, 5.4))
    result = _keep(Plan(rooms=centred((0, 0), (6, 0), (0, -5), (6, -5.4))), Plan(rooms=old, bulbs=BULB))
    assert result.kept is not None
    assert result.kept["mirrored"] is True
    src = [complex(0, 0), complex(6, 0), complex(0, 5), complex(7, 5)]
    half = [complex(0, 0), complex(6, 0), complex(3, -5), complex(1, -5)]
    plain, flipped = plan_import._rigid(src, half), plan_import._rigid([z.conjugate() for z in src], half)
    assert flipped[2] < plain[2] < flipped[2] * plan_import.MIRROR_GAIN
    fit = plan_import._fit(list(zip(src, half, strict=True)))
    assert fit is not None
    assert fit[2] is False


def test_the_view_keeps_the_orientation_of_the_current_plan() -> None:
    old = centred((2, 2), (8, 2), (2, 8))
    new = centred((10, 10), (10, 16), (4, 10))
    current = Plan(rooms=old, bulbs=BULB, north_deg=10.0, view_rotation_deg=30.0, floor_id="f")
    result = _keep(Plan(rooms=new), current)
    assert result.kept is not None
    assert result.kept["rotation_deg"] == pytest.approx(90.0)
    assert result.plan.view_rotation_deg == pytest.approx(300.0)
    assert result.plan.north_deg == pytest.approx(100.0)
    assert result.plan.floor_id == "f"
    unmatched = _keep(Plan(rooms=centred((50, 50), prefix="x")), current)
    assert (unmatched.plan.view_rotation_deg, unmatched.plan.north_deg) == (30.0, 10.0)


BULB = (PlanBulb(ieee="0x0000000000000001", x=2.0, y=2.0),)


def test_centre_of_a_degenerate_outline_is_its_mean() -> None:
    assert plan_import._centre(((0, 0), (2, 0), (4, 0))) == complex(2, 0)
    assert plan_import._fit([(complex(1, 1), complex(3, 1))] * 3) == (
        complex(1),
        complex(2, 0),
        False,
        0.0,
    )
    assert math.isclose(abs(plan_import._centre(((0, 0), (2, 0), (2, 2), (0, 2)))), math.sqrt(2))


def test_crossing_outlines_fall_back_to_the_exact_pixel_edges(monkeypatch: pytest.MonkeyPatch) -> None:
    assert valetudo._crossing([(0, 0), (2, 2), (2, 0), (0, 2)])
    assert not valetudo._crossing([(0, 0), (2, 0), (2, 2), (0, 2)])
    teeth = {(x, 99) for x in range(100, 160, 4)}
    data = vmap(segment("1", rect(100, 100, 159, 159) | teeth))
    monkeypatch.setattr(valetudo, "_crossing", lambda polygon: True)
    monkeypatch.setattr(valetudo, "MAX_ROOM_VERTICES", 1000)
    (room,) = parse(data).rooms
    assert len(room.outline) > 4
    for i, (x, y) in enumerate(room.outline):
        nx, ny = room.outline[(i + 1) % len(room.outline)]
        assert x == nx or y == ny


def comb(columns: int, teeth: int) -> dict[str, Any]:
    runs: list[int] = []
    for c in range(columns):
        for y in range(3, teeth * 13):
            runs += [c * 60, y, 40 if y % 13 == 0 else 3]
    runs += [0, 0, columns * 60, 0, 1, columns * 60, 0, 2, columns * 60]
    return vmap({"type": "segment", "metaData": {"segmentId": "1", "name": "Comb"}, "compressedPixels": runs})


def test_a_comb_is_read_quickly_and_coarsened_to_the_corner_limit() -> None:
    text = json.dumps(comb(10, 300))
    start = time.process_time()
    result = plan_import.load("auto", text, {})
    assert time.process_time() - start < 2.0
    (room,) = result.plan.rooms
    assert len(room.outline) <= valetudo.MAX_ROOM_VERTICES
    (warning,) = [w for w in result.warnings if w["code"] == "room_simplified"]
    assert warning["params"]["room"] == "comb"
    assert warning["params"]["vertices"] == len(room.outline)
    assert warning["params"]["tolerance_m"] > valetudo.SIMPLIFY_PX * 0.05


def test_a_large_room_is_read_in_little_memory() -> None:
    data = vmap(
        {
            "type": "segment",
            "metaData": {"segmentId": "1"},
            "compressedPixels": [v for y in range(1000) for v in (0, y, 1000)],
        }
    )
    vm = valetudo.decode(data)
    tracemalloc.start()
    try:
        parsed = valetudo.parse(vm)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert len(parsed.rooms[0].outline) == 4
    assert peak < 20_000_000


def test_a_map_that_takes_too_long_is_too_complex(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(valetudo, "BUDGET_S", -1.0)
    with pytest.raises(OutglowError) as err:
        plan_import.load("auto", FLAT.read_text(), {})
    assert err.value.code == "invalid_format"
    assert "too complex" in err.value.message


def test_fine_pixels_grow_by_a_bounded_number_of_pixels() -> None:
    (room,) = parse(vmap(segment("1", rect(100, 100, 299, 299)), pixel=0.5)).rooms
    x0, _, x1, _ = box(room.outline)
    assert (x1 - x0) / 0.005 == pytest.approx(200 + 2 * valetudo.MAX_GROW_PX)


def test_the_backdrop_is_drawn_in_rectangles_and_dropped_when_too_large(monkeypatch: pytest.MonkeyPatch) -> None:
    parsed = parse(vmap(segment("1", rect(100, 100, 199, 199)), walls=rect(100, 98, 199, 99)))
    assert parsed.backdrop.svg is not None
    svg = parsed.backdrop.svg.decode()
    assert svg.count("M") == 2
    assert "h100v100h-100z" in svg
    assert "h100v2h-100z" in svg
    monkeypatch.setattr(valetudo, "MAX_SVG_BYTES", 20)
    result = plan_import.load("auto", json.dumps(vmap(segment("1", rect(100, 100, 199, 199)))), {})
    assert result.background is None
    assert result.plan.background is None
    assert {"code": "background_dropped", "params": {"limit_mb": 0}} in result.warnings


def test_crossings_of_long_outlines_are_found_quickly() -> None:
    steps = [(float(i // 2 + (i % 2)), float(i // 2)) for i in range(20_000)]
    stairs = [*steps, (steps[-1][0], -5.0), (0.0, -5.0)]
    start = time.process_time()
    assert not valetudo._crossing(stairs)
    crossed = [*stairs[:-2], (-1.0, -5.0), (steps[-1][0] + 1, -5.0)]
    assert valetudo._crossing(crossed)
    assert time.process_time() - start < 2.0


def test_cleaning_a_long_outline_is_linear() -> None:
    stairs = [(float((i + 1) // 2), float(i // 2)) for i in range(10_001)]
    top = stairs[-1][1]
    back = [(-1.0, top - i) for i in range(int(top) + 2)]
    start = time.process_time()
    cleaned = valetudo._clean([*stairs, *back], closed=True)
    assert time.process_time() - start < 1.0
    assert cleaned == [*stairs, back[0], back[-1]]
    assert valetudo._clean([(0.0, 0.0), (1.0, 0.0), (1.0, 0.0), (2.0, 0.0), (2.0, 1.0)], closed=False) == [
        (0.0, 0.0),
        (2.0, 0.0),
        (2.0, 1.0),
    ]


@pytest.mark.parametrize(
    "text",
    [
        '{"__class":"ValetudoMap","pixelSize":5,"layers":[{"type":"segment","compressedPixels":[NaN,1,1]}]}',
        '{"__class":"ValetudoMap","pixelSize":5,"layers":[{"type":"segment","compressedPixels":[Infinity,1,1]}]}',
        '{"__class":"ValetudoMap","pixelSize":5,"layers":[{"type":"segment","compressedPixels":[1e400,1,1]}]}',
        '{"rooms":[{"id":"a","name":"A","outline":[[-Infinity,0],[1,0],[1,1]]}]}',
        '{"rooms":[{"id":"a","name":"A","outline":[[' + "9" * 400 + ",0],[1,0],[1,1]]}]}",
    ],
)
def test_numbers_that_are_not_finite_are_an_invalid_format(text: str) -> None:
    with pytest.raises(OutglowError) as err:
        plan_import.load("auto", text, {})
    assert err.value.code == "invalid_format"


def test_a_fetched_map_with_infinity_is_an_invalid_format() -> None:
    with pytest.raises(OutglowError) as err:
        valetudo_fetch.load(
            b'{"__class":"ValetudoMap","pixelSize":5,"layers":[{"compressedPixels":[1e999,0,1]}]}', {}, None
        )
    assert err.value.code == "invalid_format"


def test_points_that_are_not_finite_are_skipped() -> None:
    text = (
        "rooms:\n  a:\n    outline: [[0, 0], [.inf, 0], [1, 0], [1, 1]]\n"
        "bulbs:\n  - ieee: '0x0000000000000001'\n    at: [.nan, 0]\n"
    )
    result = plan_import.load("auto", text, {})
    assert result.plan.rooms[0].outline == ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0))
    assert result.plan.bulbs == ()
    assert plan_import._point([10**400, 0]) is None
    assert plan_import._point([True, 0]) is None
