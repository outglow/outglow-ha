import math
import time

import pytest

from engine.emission import params
from engine.ingest import Ingest
from engine.model import Model
from engine.quality import Stats, candidates, coverage_class, inside_length, predicted_rssi, report, second_bulb
from engine.topology import boundary_distance, build
from engine.types import GlobalSettings, HistoryEvent, Label, Plan, PlanBulb, QualityInputs, Room, Settings
from tests.engine.helpers import B1, B2, B3, B4, FLAT3, H0, H1, TWO, obs, square

TOPO = build(FLAT3)


def _stats(ticks: int = 7200, open_b1: int = 7200) -> Stats:
    stats = Stats.fresh(TOPO)
    stats.t0, stats.t1, stats.ticks = 0.0, ticks * 0.5, ticks
    stats.messages = 3600
    stats.rx_open = {b: open_b1 if b == B1 else 100 for b in TOPO.bulbs}
    stats.frozen[(B2, B4)] = ticks
    stats.onsets[(B1, B2)] = 5
    return stats


def test_report_rooms_directions_and_recommendations() -> None:
    model = Model(bg_ticks=7200.0, empty_s=600.0)
    model.bg_onsets[(B1, B3)] = 100.0
    model.bg_onsets[(B3, B1)] = 1.0
    ingest = Ingest(TOPO)
    ingest.observe(obs(1.0, B2, {B4: 30}, signal=-91))
    events = (
        HistoryEvent(t=105.0, kind="motion_on", room="hall"),
        HistoryEvent(t=500.0, kind="motion_on", room="hall"),
        HistoryEvent(t=900.0, kind="false_alarm", room="living"),
    )
    labels = (
        Label(t0=100.0, t1=160.0, kind="room", room="hall", activity="walk"),
        Label(t0=300.0, t1=360.0, kind="room", room="hall", activity="walk"),
        Label(t0=300.0, t1=360.0, kind="room", room="living", activity="still"),
    )
    history = QualityInputs(t0=0.0, t1=3600.0, labels=labels, events=events, empty_intervals=((400.0, 600.0),))
    pp = params(TOPO, model, lambda pair: False)
    out = report(FLAT3, TOPO, pp, model, _stats(), ingest, 3600.0, history, Settings())
    rooms = {r.room: r for r in out.rooms}
    assert rooms["hall"].false_alarms_per_day == 1.0
    assert rooms["hall"].entry_detection == 0.5
    assert rooms["hall"].latency_median_s == 5.0
    assert rooms["living"].false_alarms_per_day == 1.0
    assert rooms["living"].entry_detection is None
    directions = {(d.rx, d.tx): d for d in out.directions}
    assert directions[(B1, B3)].exceed_per_h == 100.0
    assert directions[(B1, B3)].asymmetry == 100.0
    assert "asymmetric_noisy" in directions[(B1, B3)].flags
    assert directions[(B2, B4)].flags == ("weak", "frozen")
    assert directions[(B2, B1)].asymmetry is None
    kinds = {r.kind for r in out.recommendations}
    assert kinds == {"skip_direction", "frozen_direction", "raise_sensitivity", "more_empty_house", "one_bulb"}
    assert out.network_frames_per_s == 1.0
    assert out.empty_house_hours == round(200 / 3600, 3)


def test_live_rates_without_background_and_empty_stats() -> None:
    model = Model(empty_s=10 * 3600.0)
    pp = params(TOPO, model, lambda pair: False)
    out = report(FLAT3, TOPO, pp, model, _stats(), Ingest(TOPO), 0.0, QualityInputs(t0=0.0, t1=10.0), Settings())
    assert {(d.rx, d.tx): d.exceed_per_h for d in out.directions}[(B1, B2)] == 5.0
    assert "more_empty_house" not in {r.kind for r in out.recommendations}
    assert all(r.false_alarms_per_day is None for r in out.rooms)
    fresh = Stats.fresh(TOPO)
    assert fresh.hours == 0.0
    idle = report(FLAT3, TOPO, pp, model, fresh, Ingest(TOPO), 0.0, QualityInputs(t0=0.0, t1=10.0), Settings())
    assert idle.network_frames_per_s == 0.0
    assert "raise_sensitivity" not in {r.kind for r in idle.recommendations}


def test_weak_coverage_suggests_places() -> None:
    attic = Room(id="attic", name="Attic", outline=square(30, 30, 32, 32))
    plan = Plan(rooms=(*FLAT3.rooms, attic), adjacent=FLAT3.adjacent, bulbs=FLAT3.bulbs)
    topo = build(plan)
    model = Model(empty_s=10 * 3600.0)
    pp = params(topo, model, lambda pair: False)
    stats = Stats.fresh(topo)
    out = report(plan, topo, pp, model, stats, Ingest(topo), 0.0, QualityInputs(t0=0.0, t1=10.0), Settings())
    weak = [r for r in out.recommendations if r.kind == "weak_coverage"]
    assert [r.room for r in weak] == ["attic"]
    assert weak[0].severity == "warning"
    assert len(weak[0].candidates) == 3
    assert weak[0].numbers["gain"] == 0.0
    homeless = [r for r in out.recommendations if r.kind == "no_bulbs"]
    assert [(r.room, r.severity, r.numbers) for r in homeless] == [
        ("attic", "warning", {"crossing": 0.0, "rules": 1.0})
    ]


def test_room_without_bulbs_seen_through_crossing_lines() -> None:
    plan = Plan(
        rooms=(
            Room(id="a", name="A", outline=square(0, 0, 4, 4)),
            Room(id="m", name="M", outline=square(4, 0, 6, 4)),
            Room(id="b", name="B", outline=square(6, 0, 10, 4)),
        ),
        bulbs=(PlanBulb(ieee=B1, x=2, y=2), PlanBulb(ieee=B2, x=8, y=2)),
    )
    topo = build(plan)
    model = Model(empty_s=10 * 3600.0)
    pp = params(topo, model, lambda pair: False)
    inputs = QualityInputs(t0=0.0, t1=10.0)

    def homeless(settings: Settings) -> list[tuple[str | None, str, dict[str, float]]]:
        out = report(plan, topo, pp, model, Stats.fresh(topo), Ingest(topo), 0.0, inputs, settings)
        return [(r.room, r.severity, r.numbers) for r in out.recommendations if r.kind == "no_bulbs"]

    assert homeless(Settings()) == [("m", "warning", {"crossing": 1.0, "rules": 1.0})]
    bayes = Settings(global_=GlobalSettings(mode="bayes"))
    assert homeless(bayes) == [("m", "info", {"crossing": 1.0, "rules": 0.0})]


def test_geometry_helpers() -> None:
    assert coverage_class(1.2) == "good"
    assert coverage_class(0.5) == "weak"
    assert coverage_class(0.1) == "none"
    assert predicted_rssi(TWO, (1, 2), (6, 2)) < predicted_rssi(TWO, (1, 2), (3, 2))
    topo = build(TWO)
    pp = params(topo, Model(), lambda pair: False)
    found = candidates(TWO, topo, "b", next(iter(pp.values())))
    assert 0 < len(found) <= 3
    assert found == sorted(found, key=lambda c: (-c[0], c[1]))
    assert B3 in topo.bulbs


def test_rules_mode_suggests_a_second_bulb_for_a_room_next_to_a_room_with_its_own_pair() -> None:
    model = Model(empty_s=10 * 3600.0)
    pp = params(TOPO, model, lambda pair: False)

    def lone(settings: Settings) -> list[tuple[str | None, str, str, int]]:
        out = report(FLAT3, TOPO, pp, model, _stats(), Ingest(TOPO), 0.0, QualityInputs(t0=0.0, t1=10.0), settings)
        return [(r.room, r.severity, r.action, len(r.candidates)) for r in out.recommendations if r.kind == "one_bulb"]

    assert lone(Settings()) == [("hall", "info", "show_candidates", 3)]
    assert lone(Settings(global_=GlobalSettings(mode="bayes"))) == []
    out = report(FLAT3, TOPO, pp, model, _stats(), Ingest(TOPO), 0.0, QualityInputs(t0=0.0, t1=10.0), Settings())
    rec = next(r for r in out.recommendations if r.kind == "one_bulb")
    assert rec.candidates == ((6.5, 0.5), (6.5, 5.5), (5.5, 0.5))
    assert rec.numbers == {"own_m": 2.55, "lines_m": 8.77}


def test_a_second_bulb_goes_where_its_lines_cross_the_room() -> None:
    outline = square(4, 0, 8, 4)
    assert inside_length((4, 0), (8, 4), outline) == pytest.approx(4 * math.sqrt(2))
    assert inside_length((2, 2), (6, 2), outline) == pytest.approx(2.0)
    found = second_bulb(TWO, build(TWO), "b")
    spots = [p for _, _, p in found]
    assert spots == [(7.5, 0.5), (7.5, 3.5), (4.5, 0.5)]
    assert all(boundary_distance(p, outline) >= 0.5 for p in spots)
    assert all(math.dist(p, q) >= 1.0 for i, p in enumerate(spots) for q in spots[i + 1 :])
    assert [own for own, _, _ in found] == sorted((own for own, _, _ in found), reverse=True)


def _lone(outline: tuple[tuple[float, float], ...], bulb: tuple[float, float], hall: tuple[float, ...]) -> Plan:
    x0, y0, x1, y1 = hall
    return Plan(
        rooms=(Room(id="r", name="R", outline=outline), Room(id="hall", name="Hall", outline=square(x0, y0, x1, y1))),
        adjacent=(("r", "hall"),),
        bulbs=(
            PlanBulb(ieee=B1, x=bulb[0], y=bulb[1]),
            PlanBulb(ieee=B2, x=x0 + 1, y=y0 + 1),
            PlanBulb(ieee=B3, x=x1 - 1, y=y0 + 1),
            PlanBulb(ieee=B4, x=x1 - 2, y=y1 - 1),
        ),
    )


def test_a_second_bulb_goes_far_from_the_first_along_the_room() -> None:
    plan = Plan(
        rooms=(
            Room(id="a", name="A", outline=square(0, 0, 4, 4)),
            Room(id="h", name="H", outline=square(4, 0, 8, 4)),
            Room(id="k", name="K", outline=square(0, 4, 8, 7)),
        ),
        adjacent=(("a", "h"), ("a", "k"), ("h", "k")),
        bulbs=(
            PlanBulb(ieee=B1, x=1, y=1),
            PlanBulb(ieee=B2, x=5, y=1),
            PlanBulb(ieee=B3, x=7, y=3),
            PlanBulb(ieee=B4, x=6, y=2),
            PlanBulb(ieee=H0, x=2, y=5),
            PlanBulb(ieee=H1, x=6, y=6),
        ),
    )
    found = second_bulb(plan, build(plan), "a")
    assert found[0][2] == (3.5, 3.5)
    assert found[0][0] == pytest.approx(2.5 * math.sqrt(2), abs=0.01)
    assert all(own >= 2.5 for own, _lines, _p in found)
    assert all(lines >= own for own, lines, _p in found)


def test_a_second_bulb_in_an_l_shaped_room_keeps_its_own_line_inside_either_arm() -> None:
    arm = ((0, 0), (6, 0), (6, 2), (2, 2), (2, 6), (0, 6))
    across = _lone(arm, (5.5, 1), (6, 0, 10, 6))
    best = second_bulb(across, build(across), "r")[0]
    assert best[2][0] <= 2
    assert best[2][1] <= 2
    assert best[0] >= 4.5
    up = _lone(arm, (1, 5.5), (6, 0, 10, 6))
    best = second_bulb(up, build(up), "r")[0]
    assert best[2][0] <= 2
    assert best[2][1] <= 2
    assert best[0] >= 4.5


def test_a_narrow_room_still_gets_spots_away_from_its_walls() -> None:
    for x0, x1 in ((0, 0.9), (0.2, 1.4)):
        plan = _lone(square(x0, 0, x1, 4), ((x0 + x1) / 2, 1), (x1, 0, x1 + 4, 4))
        found = second_bulb(plan, build(plan), "r")
        assert found
        outline = plan.rooms[0].outline
        assert all(boundary_distance(p, outline) >= 0.3 for _own, _lines, p in found)
        assert found[0][2][1] >= 3


def test_a_second_bulb_for_a_traced_room_is_found_quickly_and_once() -> None:
    def traced(x0: float, y0: float, x1: float, y1: float, n: int) -> tuple[tuple[float, float], ...]:
        per = n // 4
        points = []
        for side in range(4):
            for i in range(per):
                s = i / per
                corners = (
                    (x0 + (x1 - x0) * s, y0),
                    (x1, y0 + (y1 - y0) * s),
                    (x1 - (x1 - x0) * s, y1),
                    (x0, y1 - (y1 - y0) * s),
                )
                points.append(corners[side])
        return tuple((round(x, 3), round(y + 0.001 * (i % 2), 3)) for i, (x, y) in enumerate(points))

    rooms = [Room(id="big", name="Big", outline=traced(0, 0, 12, 10, 400))]
    bulbs = [PlanBulb(ieee=f"0x{1:016x}", x=1, y=1)]
    for j in range(5):
        rooms.append(Room(id=f"r{j}", name=f"R{j}", outline=traced(12, 2 * j, 16, 2 * j + 2, 200)))
        bulbs += [PlanBulb(ieee=f"0x{2 + 6 * j + q:016x}", x=12.3 + 0.6 * q, y=2 * j + 1) for q in range(6)]
    plan = Plan(rooms=tuple(rooms), adjacent=tuple(("big", f"r{j}") for j in range(5)), bulbs=tuple(bulbs))
    topo = build(plan)
    start = time.perf_counter()
    found = second_bulb(plan, topo, "big")
    took = time.perf_counter() - start
    assert found[0][2][0] >= 10
    assert took < 3.0
    start = time.perf_counter()
    assert second_bulb(plan, topo, "big") == found
    assert time.perf_counter() - start < 0.01
