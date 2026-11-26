import pytest

from engine.learn import CENSORED, EXCEED, NONE, QUIET, Learner, TickRecord
from engine.model import Model
from engine.topology import build
from engine.types import Label, Plan, PlanBulb, Room
from tests.engine.helpers import B1, B2, B3, FLAT3, square

TOPO = build(FLAT3)


def _record(t: float, level: int, state: int, code: int, p: tuple[float, ...] = (0.0, 0.0, 0.0)) -> TickRecord:
    n, m = len(TOPO.directions), len(TOPO.pairs)
    levels = bytes([level, CENSORED] + [NONE] * (n - 2))
    return TickRecord(
        t, levels, bytes([state] + [QUIET] * (n - 1)), bytes([code, 3, 4] + [NONE] * (m - 3)), p, "unknown"
    )


def _learner(records: list[TickRecord]) -> Learner:
    learner = Learner(TOPO, 0.5)
    for rec in records:
        learner.record(rec)
    return learner


def test_whole_house_empty_feeds_cfar_and_pair_background() -> None:
    records = [_record(10 + 0.5 * i, 8, EXCEED if i % 4 == 1 else QUIET, 1) for i in range(40)]
    model = Model()
    used = _learner(records).label(model, Label(t0=10.0, t1=30.0, kind="empty", source="empty_house"))
    assert used == 29
    assert model.hist[TOPO.directions[0]].observed == 29
    assert model.hist[TOPO.directions[1]].censored == 29
    assert model.bg_onsets[TOPO.directions[0]] == 7
    assert model.pair_bg[TOPO.pairs[0]] == [0.0, 29.0, 0.0]
    assert model.pair_bg[TOPO.pairs[1]] == [29.0, 0.0, 0.0]
    assert model.pair_bg[TOPO.pairs[2]] == [0.0, 29.0, 0.0]
    assert model.labels == {"empty_house": 29}
    assert model.empty_s == 14.5


def test_a_whole_house_label_skips_ticks_already_taught_online() -> None:
    records = [_record(10 + 0.5 * i, 8, EXCEED if i % 4 == 1 else QUIET, 1) for i in range(40)]
    learner = _learner(records)
    model = Model()
    for _ in range(10):
        learner.record(_record(learner.buffer[-1].t + 0.5, 8, QUIET, 1))
        learner.empty_tick(model, learner.recorded - 10, 1.0)
    assert model.labels == {"empty_house": 10}
    assert model.empty_s == 5.0
    assert sum(r.taught for r in learner.buffer) == 10
    used = learner.label(model, Label(t0=10.0, t1=40.0, kind="empty", source="empty_house"))
    assert used == 44 - 10
    assert model.labels == {"empty_house": 44}
    assert model.empty_s == 22.0
    assert model.hist[TOPO.directions[0]].observed == 44


def test_room_walk_teaches_emission_and_entries() -> None:
    records = [_record(10 + 0.5 * i, 8, QUIET, 2, (0.1, 0.2 + 0.01 * i, 0.0)) for i in range(40)]
    model = Model()
    learner = _learner(records)
    learner.label(model, Label(t0=10.0, t1=30.0, kind="room", room="hall", activity="walk"))
    assert model.emit[(TOPO.pairs[0], "hall")] == [0.0, 0.0, 29.0]
    assert model.entries["hall"] == [0.4]


def test_a_manual_light_teaches_less_while_another_room_moves() -> None:
    light = Label(t0=10.0, t1=30.0, kind="room", room="hall", activity="any", source="manual_light", weight=0.4)
    learner = _learner([_record(10 + 0.5 * i, 8, QUIET, 2, (0.75, 0.9, 0.0)) for i in range(40)])
    model = Model()
    assert learner.label(model, light) == 29
    assert model.emit[(TOPO.pairs[0], "hall")] == [0.0, 0.0, pytest.approx(29 * 0.1)]
    assert model.entries == {}
    assert model.labels == {"manual_light": 29}
    elsewhere = _learner([_record(10 + 0.5 * i, 8, QUIET, 2, (0.0, 0.0, 1.0)) for i in range(40)])
    untouched = Model()
    assert elsewhere.label(untouched, light) == 0
    assert untouched.emit == {}
    assert untouched.labels == {}


def test_partial_knowledge_and_ignored_labels() -> None:
    records = [_record(10 + 0.5 * i, 8, QUIET, 1, (0.5, 0.25, 0.0)) for i in range(40)]
    learner = _learner(records)
    model = Model()
    learner.label(model, Label(t0=10.0, t1=30.0, kind="empty", room="living", source="feedback"))
    assert model.pair_bg[TOPO.pairs[0]][1] == 29 * 0.75
    still = Model()
    learner.label(still, Label(t0=10.0, t1=30.0, kind="room", room="hall", activity="still", weight=1.0))
    assert still.pair_bg == {}
    nothing = Model()
    assert learner.label(nothing, Label(t0=10.0, t1=30.0, kind="transition", room="hall")) == 0
    assert learner.label(nothing, Label(t0=10.0, t1=30.0, kind="room", room="attic")) == 0
    assert learner.label(nothing, Label(t0=10.0, t1=30.0, kind="room")) == 0
    assert learner.label(nothing, Label(t0=100.0, t1=130.0, kind="empty")) == 0
    assert nothing.labels == {}
    assert next(iter(learner.window(10.0, 10.5))).t == 10.0
    assert (B1, B2) in TOPO.directions
    assert B3 in TOPO.bulbs


def test_still_teaches_background_only_out_of_reach() -> None:
    plan = Plan(
        rooms=tuple(Room(id=r, name=r, outline=square(4 * i, 0, 4 * i + 4, 4)) for i, r in enumerate("abc")),
        bulbs=(PlanBulb(ieee=B1, x=1, y=2), PlanBulb(ieee=B2, x=9, y=1), PlanBulb(ieee=B3, x=11, y=3)),
    )
    topo = build(plan)
    near, far = topo.pairs.index((B1, B2)), topo.pairs.index((B2, B3))
    codes = bytes(1 for _ in topo.pairs)
    n = len(topo.directions)
    learner = Learner(topo, 0.5)
    for i in range(40):
        learner.record(TickRecord(10 + 0.5 * i, bytes([NONE] * n), bytes([QUIET] * n), codes, (0, 0, 0), "unknown"))
    model = Model()
    learner.label(model, Label(t0=10.0, t1=30.0, kind="room", room="a", activity="still", weight=1.0))
    assert model.pair_bg == {topo.pairs[far]: [0.0, 29 * 0.5, 0.0]}
    assert topo.pairs[near] not in model.pair_bg
    assert model.labels == {"wizard": 29}


def test_still_counts_only_the_ticks_it_learns_from() -> None:
    plan = Plan(
        rooms=tuple(Room(id=r, name=r, outline=square(4 * i, 0, 4 * i + 4, 4)) for i, r in enumerate("abc")),
        bulbs=(PlanBulb(ieee=B1, x=1, y=2), PlanBulb(ieee=B2, x=9, y=1), PlanBulb(ieee=B3, x=11, y=3)),
    )
    topo = build(plan)
    far = topo.pairs.index((B2, B3))
    n = len(topo.directions)
    learner = Learner(topo, 0.5)
    for i in range(40):
        codes = bytes(1 if j == far and i % 2 else NONE for j in range(len(topo.pairs)))
        learner.record(TickRecord(10 + 0.5 * i, bytes([NONE] * n), bytes([QUIET] * n), codes, (0, 0, 0), "unknown"))
    middle = Model()
    assert learner.label(middle, Label(t0=10.0, t1=30.0, kind="room", room="b", activity="still")) == 0
    assert middle.labels == {}
    assert middle.pair_bg == {}
    edge = Model()
    assert learner.label(edge, Label(t0=10.0, t1=30.0, kind="room", room="a", activity="still")) == 14
    assert edge.labels == {"wizard": 14}
    assert edge.pair_bg == {topo.pairs[far]: [0.0, 14 * 0.5, 0.0]}


def test_background_without_pairs() -> None:
    model = Model()
    _learner([]).background(model, _record(1.0, 8, QUIET, 1), None, 0.3)
    assert model.pair_bg == {}
    assert model.bg_ticks == 0.3


def test_ticks_without_weight_teach_and_count_nothing() -> None:
    plan = Plan(
        rooms=tuple(Room(id=r, name=r, outline=square(4 * i, 0, 4 * i + 4, 4)) for i, r in enumerate("abc")),
        bulbs=(PlanBulb(ieee=B1, x=1, y=2), PlanBulb(ieee=B2, x=9, y=1), PlanBulb(ieee=B3, x=11, y=3)),
    )
    topo = build(plan)
    far = topo.pairs[topo.pairs.index((B2, B3))]
    n = len(topo.directions)
    learner = Learner(topo, 0.5)
    for i in range(40):
        p = (0.0, 1.0 if i % 2 else 0.0, 0.0)
        learner.record(TickRecord(10 + 0.5 * i, bytes([NONE] * n), bytes([QUIET] * n), bytes([1] * 3), p, "unknown"))
    still = Model()
    assert learner.label(still, Label(t0=10.0, t1=30.0, kind="room", room="a", activity="still")) == 15
    assert still.labels == {"wizard": 15}
    assert still.pair_bg == {far: [0.0, 15 * 0.5, 0.0]}
    feedback = Model()
    assert learner.label(feedback, Label(t0=10.0, t1=30.0, kind="empty", room="a", source="feedback")) == 15
    assert feedback.labels == {"feedback": 15}
    assert feedback.pair_bg[far] == [0.0, 15.0, 0.0]


def test_a_hard_label_tops_up_ticks_taught_softly_online() -> None:
    records = [_record(10 + 0.5 * i, 8, QUIET, 1) for i in range(40)]
    learner = _learner(records)
    model = Model()
    for _ in range(10):
        learner.record(_record(learner.buffer[-1].t + 0.5, 8, QUIET, 1))
        learner.empty_tick(model, learner.recorded - 10, 0.3)
    assert model.empty_s == pytest.approx(10 * 0.3 * 0.5)
    assert model.pair_bg == {}
    used = learner.label(model, Label(t0=10.0, t1=40.0, kind="empty", source="wizard"))
    assert used == 44
    assert model.labels == {"empty_house": 10, "wizard": 44}
    assert model.empty_s == pytest.approx(44 * 0.5)
    assert model.bg_ticks == pytest.approx(44)
    assert model.hist[TOPO.directions[0]].observed == pytest.approx(44)
    assert model.pair_bg[TOPO.pairs[0]] == pytest.approx([0.0, 44.0, 0.0])
    assert learner.label(model, Label(t0=10.0, t1=40.0, kind="empty", source="wizard")) == 0
    assert model.empty_s == pytest.approx(44 * 0.5)


def test_an_online_tick_after_a_label_teaches_only_what_the_label_left() -> None:
    records = [_record(10 + 0.5 * i, 8, QUIET, 1) for i in range(40)]
    learner = _learner(records)
    model = Model()
    learner.label(model, Label(t0=10.0, t1=40.0, kind="empty", source="wizard", weight=0.3))
    learner.record(_record(learner.buffer[-1].t + 0.5, 8, QUIET, 1))
    learner.empty_tick(model, learner.recorded - 10, 1.0)
    assert model.labels == {"wizard": 34, "empty_house": 1}
    assert model.bg_ticks == pytest.approx(34 * 0.3 + 0.7)
    learner.record(_record(learner.buffer[-1].t + 0.5, 8, QUIET, 1))
    learner.empty_tick(model, learner.recorded - 10, 0.3)
    assert model.labels["empty_house"] == 1
