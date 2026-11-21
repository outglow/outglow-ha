from engine.emission import params
from engine.ingest import Ingest
from engine.model import Model
from engine.quality import Stats, candidates, coverage_class, predicted_rssi, report
from engine.topology import build
from engine.types import GlobalSettings, HistoryEvent, Label, Plan, PlanBulb, QualityInputs, Room, Settings
from tests.engine.helpers import B1, B2, B3, B4, FLAT3, TWO, obs, square

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
    assert kinds == {"skip_direction", "frozen_direction", "raise_sensitivity", "more_empty_house"}
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
