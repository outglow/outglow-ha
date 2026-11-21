from collections.abc import Callable, Iterator
from dataclasses import replace
from functools import cache
from pathlib import Path

import pytest

from engine import Engine, recording, to_json
from engine.core import Options
from engine.defaults import A_ON_START
from engine.learn import NONE, Learner, TickRecord
from engine.model import Model
from engine.model import to_json as model_json
from engine.topology import build
from engine.types import (
    CalibrationResult,
    Context,
    Frame,
    GlobalSettings,
    Header,
    Json,
    Label,
    LightEvent,
    Observation,
    Plan,
    PlanBulb,
    QualityInputs,
    Record,
    Room,
    RoomCalibration,
    RoomFrame,
    RoomSettings,
    Settings,
)
from tests.engine.helpers import B1, B2, B3, B4, FLAT3, TWO, all_levels, obs
from tools import synth

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "recordings"
A, B = B1, B2
PLAN = Plan(
    rooms=(Room(id="hall", name="Hall", outline=((0, 0), (1, 0), (1, 1))),),
    bulbs=(PlanBulb(ieee=A, x=0.5, y=0.5), PlanBulb(ieee=B, x=0.6, y=0.6)),
)
QUICK = Settings(global_=GlobalSettings(mode="bayes"))


def _settings(learning: bool = False, quiet_background: bool = False) -> Settings:
    return replace(QUICK, global_=replace(QUICK.global_, learning=learning, quiet_background=quiet_background))


@cache
def _synthetic() -> tuple[Plan, tuple[Record, ...]]:
    records = list(synth.simulate_physics("flat2", 3, 900.0, empty=300.0, persons=1))
    header = records[0]
    assert isinstance(header, Header)
    assert header.plan is not None
    return header.plan, tuple(records[1:])


def _drive(engine: Engine, records: tuple[Record, ...], until: float) -> float:
    items = [r for r in records if not isinstance(r, Label)]
    i = 0
    t = synth.START
    while t <= until:
        while i < len(items) and getattr(items[i], "t", 0.0) <= t:
            engine.feed(items[i])
            i += 1
        engine.advance(t)
        t += 0.5
    return t - 0.5


def _drive_from(engine: Engine, records: tuple[Record, ...], start: float, until: float) -> None:
    items = [r for r in records if not isinstance(r, Label) and start <= getattr(r, "t", 0.0)]
    i = 0
    t = start
    while t <= until:
        while i < len(items) and getattr(items[i], "t", 0.0) <= t:
            engine.feed(items[i])
            i += 1
        engine.advance(t)
        t += 0.5


def test_tick_reports_gates_and_empty_rooms() -> None:
    engine = Engine(PLAN, Settings())
    engine.observe(obs(10.0, A, {B: 3}))
    engine.context(Context(t=10.0, offline=frozenset({B}), light_events=(LightEvent(t=10.0, ieee=A),)))
    frame = engine.tick(11.0)
    assert frame.gates == {A: "open", B: "offline"}
    assert frame.rooms["hall"].p == 0.0
    assert frame.status == "degraded"
    assert engine.tick(14.1).gates[A] == "closed"
    assert engine.mode == "rules"
    assert engine.topology.rooms == ("hall",)


def test_paused_and_model_version() -> None:
    engine = Engine(PLAN, Settings(global_=GlobalSettings(sensing=False)), {"model_version": 4})
    frame = engine.tick(0.0)
    assert frame.status == "paused"
    assert frame.model_version == 4
    assert frame.rooms == {"hall": RoomFrame(coverage=frame.rooms["hall"].coverage)}
    assert Engine(PLAN, Settings(), {"model_version": True}).tick(0.0).model_version == 0
    nested = Engine(PLAN, Settings(), {"active": {"model_version": 2}, "pending": {}, "pending_seq": True})
    assert nested.model_state()["model_version"] == 2
    assert nested.pending_id() == "p-0003-0000"


def test_replay_ticks_on_the_grid() -> None:
    records: list[Record] = [
        Header(),
        obs(1.2, A, {B: 3}),
        Context(t=1.3),
        LightEvent(t=1.4, ieee=A),
        Label(t0=0.0, t1=2.0, kind="room", room="hall"),
        Frame(t=2.1),
    ]
    frames = list(Engine.replay(records, PLAN, Settings()))
    assert [f.t for f in frames] == [1.5, 2.0, 2.5]
    assert frames[0].gates[A] == "open"
    assert list(Engine.replay([Header()], PLAN, Settings())) == []


def test_replay_is_deterministic() -> None:
    lines = (FIXTURES / "flat3_v2.jsonl").read_text().splitlines()
    records = list(recording.read(lines))
    header = records[0]
    assert isinstance(header, Header)
    assert header.plan is not None
    runs = [[to_json(f) for f in Engine.replay(records, header.plan, QUICK)] for _ in range(2)]
    assert runs[0] == runs[1]
    assert len(runs[0]) > 20


def test_bayes_on_synthetic_flat_sees_people_and_not_the_empty_house() -> None:
    plan, records = _synthetic()
    frames = list(Engine.replay(records, plan, QUICK))
    empty = [f for f in frames if f.t < synth.START + 300]
    home = [f for f in frames if f.t >= synth.START + 330]
    assert not any(r.motion for f in empty for r in f.rooms.values())
    moving = [f for f in home if any(r.motion for r in f.rooms.values())]
    assert len(moving) > len(home) / 4
    sample = moving[len(moving) // 2]
    assert sample.directions
    assert sample.pairs
    assert any(r.top_pairs for r in sample.rooms.values())
    assert sample.illustrative_xy
    assert sample.trail
    assert {d.state for f in moving for d in f.directions} >= {"exceed", "quiet"}


def test_rules_mode_and_ablations_run() -> None:
    plan, records = _synthetic()
    rules = list(Engine.replay(records, plan, Settings()))
    assert any(r.motion for f in rules for r in f.rooms.values())
    for options in (Options(explain=False), Options(agree=False), Options(cfar=False), Options(firmware=True)):
        frames = list(Engine.replay(records[:400], plan, QUICK, options))
        assert frames


def test_background_learning_waits_for_apply() -> None:
    plan, records = _synthetic()
    engine = Engine(plan, _settings(learning=True))
    _drive(engine, records, synth.START + 290)
    summary = engine.summary()
    pending = summary["pending"]
    assert isinstance(pending, dict)
    assert pending["pending_id"] == engine.pending_id()
    assert summary["model_version"] == 0
    with pytest.raises(KeyError):
        engine.apply("p-nope", 1.0)
    state = engine.model_state()
    again = Engine(plan, QUICK, state)
    assert again.pending_id() == engine.pending_id()
    pid = engine.pending_id()
    assert pid is not None
    assert engine.apply(pid, 99.0) == 1
    hours = engine.summary()["empty_house_hours"]
    assert isinstance(hours, float)
    assert hours > 0
    assert engine.summary()["pending"] is None
    with pytest.raises(KeyError):
        engine.discard("p-0002-0001")
    again.discard(pid)
    assert again.pending_id() is None


def test_soft_empty_quiet_background_and_disabled_learning() -> None:
    plan, _records = _synthetic()
    soft = Engine(plan, _settings(learning=True, quiet_background=True))
    soft.context(Context(t=0.0, house_empty="soft"))
    off = Engine(plan, _settings(learning=False))
    off.context(Context(t=0.0, house_empty="yes"))
    wizard = Engine(plan, _settings(learning=False))
    assert wizard.label(Label(t0=0.0, t1=60.0, kind="empty", source="wizard")) == "p-0001-0001"
    for i in range(600):
        soft.advance(i * 0.5)
        off.advance(i * 0.5)
        wizard.advance(i * 0.5)
    state = soft.model_state()["pending"]
    assert isinstance(state, dict)
    assert isinstance(state["bg_ticks"], float)
    assert state["bg_ticks"] > 0
    assert state["pair_bg"] == {}
    assert off.pending_id() is None
    pending = wizard.summary()["pending"]
    assert isinstance(pending, dict)
    assert pending["labels"] == {"wizard": 109}
    quiet = Engine(plan, _settings(learning=True, quiet_background=True))
    for i in range(200):
        quiet.advance(i * 0.5)
    assert quiet.pending_id() is not None


def test_labels_are_learned_after_their_end() -> None:
    plan, everything = _synthetic()
    records = tuple(r for r in everything if not isinstance(r, Context))
    engine = Engine(plan, _settings(learning=True))
    labels = [r for r in records if isinstance(r, Label) and r.kind == "room"][:3]
    _drive(engine, records, labels[0].t0 - 1)
    pid = engine.label(labels[0])
    assert engine.pending_id() == pid
    _drive_from(engine, records, labels[0].t0 - 0.5, labels[0].t1 - 1)
    assert _pending_labels(engine) == {}
    engine.advance(labels[0].t1 + 1)
    assert _pending_labels(engine) != {}


def _pending_labels(engine: Engine) -> object:
    pending = engine.summary()["pending"]
    assert isinstance(pending, dict)
    return pending["labels"]


def test_reset_restore_and_adopt() -> None:
    plan, everything = _synthetic()
    records = tuple(r for r in everything if not isinstance(r, Context))
    engine = Engine(plan, _settings(learning=True))
    label = next(r for r in records if isinstance(r, Label) and r.kind == "room" and r.room is not None)
    other = next(r.id for r in plan.rooms if r.id != label.room)
    _drive(engine, records, label.t0 - 1)
    pid = engine.label(label)
    _drive_from(engine, records, label.t0 - 0.5, label.t1 + 1)
    assert engine.apply(pid, 10.0) == 1
    learned = engine.model_state()["active"]
    assert isinstance(learned, dict)
    assert any(key.endswith(f"|{label.room}") for key in _keys(learned["emit"]))
    snapshot = dict(learned)
    engine.adopt(
        CalibrationResult(
            t=11.0,
            rooms={
                other: RoomCalibration(a_on=0.8, previous_a_on=0.9),
                "gone": RoomCalibration(a_on=0.7, previous_a_on=0.9),
            },
        ),
        11.0,
    )
    assert engine.pending_id() == "p-0002-0002"
    assert engine.reset(12.0, label.room) == 2
    after = engine.model_state()
    assert after["model_version"] == 2
    active = after["active"]
    assert isinstance(active, dict)
    assert not any(key.endswith(f"|{label.room}") for key in _keys(active["emit"]))
    pending = after["pending"]
    assert isinstance(pending, dict)
    assert pending["rooms"] == {other: {"a_on": 0.8, "false_per_day": None, "detection": None}}
    assert engine.reset(13.0, other) == 3
    pending = engine.model_state()["pending"]
    assert isinstance(pending, dict)
    assert pending["rooms"] == {}
    assert engine.restore(snapshot, 14.0) == 4
    restored = engine.model_state()
    assert restored["pending"] is None
    active = restored["active"]
    assert isinstance(active, dict)
    assert active["emit"] == snapshot["emit"]
    assert active["updated"] == 14.0
    assert engine.reset(15.0) == 5
    fresh = engine.model_state()["active"]
    assert isinstance(fresh, dict)
    assert fresh["emit"] == {}
    assert engine.summary()["model_version"] == 5


def _keys(value: object) -> list[str]:
    assert isinstance(value, dict)
    return list(value)


def test_calibration_proposes_thresholds() -> None:
    plan, records = _synthetic()
    engine = Engine(plan, QUICK)
    empty = [r for r in records if isinstance(r, Observation) and r.t < synth.START + 300]
    short = engine.calibrate(empty, 1.0)
    assert {c.status for c in short.rooms.values()} == {"uncertain"}
    assert short.rooms["hall"].empty_hours < 0.1
    long = engine.calibrate(empty, 2.0, intervals=[(0.0, 3 * 3600.0)])
    assert {c.status for c in long.rooms.values()} <= {"ok", "unchanged"}
    assert all(c.false_per_day is not None for c in long.rooms.values())
    pending = engine.summary()["pending"]
    assert isinstance(pending, dict)
    assert isinstance(pending["rooms"], list)
    assert len(pending["rooms"]) == 3
    assert engine.calibrate([], 3.0).rooms["hall"].empty_hours == 0.0
    gap = [obs(10.0, B1, {B2: 1}), obs(200.0, B1, {B2: 2})]
    assert Engine(FLAT3, QUICK).calibrate(gap, 1.0).rooms["hall"].empty_hours > 0


def test_quality_report_from_the_engine() -> None:
    plan, records = _synthetic()
    engine = Engine(plan, QUICK)
    t = _drive(engine, records, synth.START + 600)
    report = engine.quality(t, QualityInputs(t0=t - 3600, t1=t, empty_intervals=((t - 3600, t - 3000),)))
    assert report.days == 1
    assert len(report.directions) == 20
    assert len(report.pairs) == 10
    assert {r.room for r in report.rooms} == {"living", "hall", "bed"}
    assert "more_empty_house" in {r.kind for r in report.recommendations}
    assert report.network_frames_per_s > 0


def test_frames_flag_vetoes_noise_and_one_sided_lines() -> None:
    model = Model(bg_ticks=7200.0)
    model.bg_onsets[(B1, B2)] = 200.0
    engine = Engine(FLAT3, QUICK, {"active": model_json(model)})
    engine.observe(obs(1.0, B1, {B2: 60, B3: 60, B4: 60}))
    engine.observe(obs(1.0, B3, {B1: 1, B2: 1, B4: 60}))
    frame = engine.tick(1.0)
    flags = {(d.rx, d.tx): d.flags for d in frame.directions}
    assert "asymmetric_noisy" in flags[(B1, B2)]
    assert "one_sided" in flags[(B3, B4)]
    wide = Engine(synth.PHYSICS["flat2"], QUICK)
    wide.tick(1.0)
    wide.observe(obs(1.5, B2, all_levels(B2, 70, synth.PHYSICS["flat2"])))
    frame = wide.tick(1.5)
    assert any("vetoed" in d.flags for d in frame.directions)
    lonely = Engine(Plan(bulbs=FLAT3.bulbs), QUICK)
    lonely.observe(obs(1.0, B1, all_levels(B1, 60)))
    assert lonely.tick(1.0).rooms == {}


def test_common_veto_reaches_the_frame_and_quality() -> None:
    from tests.engine.test_pairs import ROW

    engine = Engine(ROW, QUICK)
    hot = [b for b in ROW.bulbs if b.x < 3 or b.x > 6]
    for rx in hot:
        levels = {b.ieee: 80 if b in hot else 1 for b in ROW.bulbs if b.ieee != rx.ieee}
        engine.observe(obs(1.0, rx.ieee, levels))
    frame = engine.tick(1.0)
    assert frame.veto is not None
    assert all(p.obs is None for p in frame.pairs)
    assert engine.stats.vetoes == {"a": 1, "b": 1, "c": 1, "d": 1}


def _until_motion(engine: Engine, records: tuple[Record, ...]) -> float:
    items = [r for r in records if not isinstance(r, Label)]
    i = 0
    t = synth.START
    while True:
        while getattr(items[i], "t", 0.0) <= t:
            engine.feed(items[i])
            i += 1
        engine.advance(t)
        if any(motion for _, motion, _ in engine.rooms_now().values()):
            return t
        t += 0.5


def _occupied(engine: Engine) -> dict[str, bool]:
    return {room: occupied for room, (_, _, occupied) in engine.rooms_now().items()}


def test_reconfigure_keeps_occupied_rooms_and_their_hold() -> None:
    plan, records = _synthetic()
    engine = Engine(plan, QUICK)
    t = _until_motion(engine, records)
    busy = _occupied(engine)
    assert any(busy.values())
    rooms = {r: replace(RoomSettings(), hold_time_s=600, reaction="calm") for r in busy}
    changed = Settings(rooms=rooms, global_=replace(QUICK.global_, tick_s=0.25, learning=False))
    fresh = Engine(plan, changed, engine.model_state())
    fresh.advance(t + 0.25)
    assert not any(_occupied(fresh).values())
    engine.reconfigure(changed)
    engine.advance(t + 0.25)
    assert _occupied(engine) == busy
    assert engine.summary()["learning"] is False
    assert engine._hold == dict.fromkeys(busy, 600)
    assert engine._rooms.reaction == dict.fromkeys(busy, "calm")
    assert engine._learner.buffer.maxlen == fresh._learner.buffer.maxlen
    engine.reconfigure(QUICK)
    assert engine._hold == dict.fromkeys(busy, RoomSettings().hold_time_s)
    rules = Engine(PLAN, QUICK)
    rules.reconfigure(Settings())
    assert rules.mode == "rules"


def test_inherit_carries_rooms_across_a_plan_change() -> None:
    plan, records = _synthetic()
    engine = Engine(plan, QUICK)
    t = _until_motion(engine, records)
    busy = _occupied(engine)
    room = next(r for r, on in busy.items() if on)
    engine.label(Label(t0=t - 5, t1=t + 1, kind="room", room=room))
    renamed = replace(plan, rooms=tuple(replace(r, name=f"{r.name}!") for r in plan.rooms))
    same = Engine(renamed, QUICK, engine.model_state()).inherit(engine)
    assert same.stats is engine.stats
    assert len(same._learner.buffer) == len(engine._learner.buffer)
    assert same._labels == engine._labels
    same.advance(t + 0.5)
    assert _occupied(same) == busy
    others = tuple(r for r in plan.rooms if r.id != room)
    smaller = replace(plan, rooms=(next(r for r in plan.rooms if r.id == room), *others[:1]), adjacent=())
    cut = Engine(smaller, QUICK, engine.model_state()).inherit(engine)
    assert cut.stats is not engine.stats
    assert set(cut.rooms_now()) == {room, others[0].id}
    assert all(item[0] in cut.rooms_now() for item in cut._trail)
    cut.advance(t + 0.5)
    assert _occupied(cut)[room] is True


def test_calibration_streams_its_samples(monkeypatch: pytest.MonkeyPatch) -> None:
    plan, records = _synthetic()
    empty = [r for r in records if isinstance(r, Observation) and r.t < synth.START + 300]
    listed = Engine(plan, QUICK).calibrate(empty, 2.0, intervals=[(0.0, 3 * 3600.0)])
    produced = [0]
    at_first_tick: list[int] = []
    advance = Engine.advance

    def spy(self: Engine, t: float) -> None:
        if not at_first_tick:
            at_first_tick.append(produced[0])
        advance(self, t)

    def samples() -> Iterator[Observation]:
        for item in empty:
            produced[0] += 1
            yield item

    monkeypatch.setattr(Engine, "advance", spy)
    streamed = Engine(plan, QUICK).calibrate(samples(), 2.0, intervals=[(0.0, 3 * 3600.0)])
    assert streamed == listed
    assert at_first_tick[0] < len(empty) / 4
    assert Engine(plan, QUICK).calibrate(iter(empty), 1.0).rooms["hall"].empty_hours == pytest.approx(
        (empty[-1].t - empty[0].t) / 3600
    )


def test_an_unchanged_calibration_opens_no_proposal() -> None:
    engine = Engine(PLAN, QUICK)
    same = RoomCalibration(
        a_on=A_ON_START,
        previous_a_on=A_ON_START,
        false_per_day=0.0,
        detection=None,
        empty_hours=30.0,
        status="unchanged",
    )
    engine.adopt(CalibrationResult(t=1.0, rooms={"hall": same, "attic": replace(same, a_on=0.6)}), 1.0)
    assert engine.pending_id() is None
    engine.adopt(CalibrationResult(t=2.0, rooms={"hall": replace(same, a_on=0.7)}), 2.0)
    assert engine.pending_id() is not None
    engine.adopt(CalibrationResult(t=3.0, rooms={"hall": replace(same, a_on=0.7)}), 3.0)
    summary = engine.summary()["pending"]
    assert isinstance(summary, dict)
    assert summary["created"] == 2.0


def _labelled_then(change: Callable[[Plan], Plan]) -> Engine:
    plan, everything = _synthetic()
    records = tuple(r for r in everything if not isinstance(r, Context))
    label = next(r for r in records if isinstance(r, Label) and r.kind == "room" and r.room == "hall")
    engine = Engine(plan, _settings())
    t = _drive(engine, records, label.t1 + 0.5)
    engine.label(replace(label, source="wizard"))
    edited = Engine(change(plan), _settings(), engine.model_state()).inherit(engine)
    edited.advance(t + 0.5)
    return edited


def test_a_plan_edit_keeps_the_buffered_labels() -> None:
    kept = _pending_labels(_labelled_then(lambda plan: plan))
    assert kept == {"wizard": 108}
    assert _pending_labels(_labelled_then(lambda plan: replace(plan, bulbs=plan.bulbs[:-1]))) == kept
    extra = f"0x{99:016x}"
    moved = _labelled_then(
        lambda plan: replace(plan, rooms=plan.rooms[::-1], bulbs=(*plan.bulbs, replace(plan.bulbs[0], ieee=extra)))
    )
    assert _pending_labels(moved) == kept


def test_removing_the_labelled_room_leaves_no_empty_proposal() -> None:
    without = _labelled_then(lambda plan: replace(plan, rooms=tuple(r for r in plan.rooms if r.id != "hall")))
    assert without.pending_id() is None
    assert without._labels == []
    other = _labelled_then(lambda plan: replace(plan, rooms=tuple(r for r in plan.rooms if r.id != "bed")))
    assert other.pending_id() is not None


def test_the_learner_buffer_follows_bulbs_pairs_and_rooms_by_id() -> None:
    old = Learner(build(TWO), 0.5)
    old.record(
        TickRecord(
            t=1.0,
            levels=bytes(range(10, 16)),
            states=bytes([0, 1, 0, 1, 3, 0]),
            codes=bytes([5, 6, 7]),
            p=(0.1, 0.2),
            empty="no",
        )
    )
    plan = replace(TWO, rooms=TWO.rooms[::-1], bulbs=(TWO.bulbs[0], TWO.bulbs[2], PlanBulb(ieee=B4, x=7, y=1)))
    new = Learner(build(plan), 0.5)
    new.inherit(old)
    (rec,) = new.buffer
    assert rec.levels == bytes([11, NONE, 14, NONE, NONE, NONE])
    assert rec.states == bytes([1, 2, 3, 2, 2, 2])
    assert rec.codes == bytes([6, NONE, NONE])
    assert rec.p == (0.2, 0.1)
    assert (rec.t, rec.empty) == (1.0, "no")
    same = Learner(build(TWO), 0.5)
    same.inherit(old)
    assert list(same.buffer) == list(old.buffer)


def test_every_calibration_refreshes_the_predictions() -> None:
    engine = Engine(PLAN, QUICK)
    same = RoomCalibration(a_on=A_ON_START, previous_a_on=A_ON_START, false_per_day=2.0, detection=0.5)
    engine.adopt(CalibrationResult(t=1.0, rooms={"hall": same}), 1.0)
    engine.adopt(CalibrationResult(t=2.0, rooms={"hall": replace(same, false_per_day=0.2, detection=0.9)}), 2.0)
    assert engine.pending_id() is None
    active = engine.model_state()["active"]
    assert isinstance(active, dict)
    assert active["rooms"] == {"hall": {"a_on": A_ON_START, "false_per_day": 0.2, "detection": 0.9}}
    engine.adopt(CalibrationResult(t=3.0, rooms={"hall": replace(same, a_on=0.7, false_per_day=0.1)}), 3.0)
    engine.adopt(CalibrationResult(t=4.0, rooms={"hall": replace(same, a_on=0.7, false_per_day=0.05)}), 4.0)
    pending = engine.summary()["pending"]
    assert isinstance(pending, dict)
    assert pending["rooms"] == [
        {
            "room": "hall",
            "a_on_before": A_ON_START,
            "a_on_after": 0.7,
            "detection_before": 0.9,
            "detection_after": 0.5,
            "false_per_day_before": 0.2,
            "false_per_day_after": 0.05,
        }
    ]


@pytest.mark.parametrize("bulbs", [0, 1, 2])
def test_the_learner_buffer_follows_a_plan_shrunk_to_nothing(bulbs: int) -> None:
    old = Learner(build(TWO), 0.5)
    old.record(TickRecord(t=1.0, levels=bytes(6), states=bytes(6), codes=bytes(3), p=(0.1, 0.2), empty="no"))
    new = Learner(build(replace(TWO, rooms=(), bulbs=TWO.bulbs[:bulbs])), 0.5)
    new.inherit(old)
    (rec,) = new.buffer
    directions = bulbs * (bulbs - 1)
    assert (rec.levels, rec.states, rec.codes, rec.p) == (
        bytes(directions),
        bytes(directions),
        bytes(directions // 2),
        (),
    )


@pytest.mark.parametrize("after", [0, 2])
def test_a_successor_built_off_a_carry_keeps_the_ticks_after_it(after: int) -> None:
    plan, everything = _synthetic()
    records = tuple(r for r in everything if not isinstance(r, Context))
    engine = Engine(plan, _settings())
    t = _drive(engine, records, synth.START + 30)
    smaller = replace(plan, bulbs=plan.bulbs[:-1])
    fresh = Engine.successor(engine.carry(), smaller, _settings())
    for i in range(after):
        engine.advance(t + 0.5 * (i + 1))
    direct = Engine(smaller, _settings(), engine.model_state()).inherit(engine)
    fresh.inherit(engine)
    assert len(fresh._learner.buffer) == len(engine._learner.buffer)
    assert list(fresh._learner.buffer) == list(direct._learner.buffer)
    assert fresh.model_state() == direct.model_state()


def _learned(rooms: tuple[str, ...]) -> tuple[Plan, Engine, float]:
    plan, everything = _synthetic()
    records = tuple(r for r in everything if not isinstance(r, Context))
    labels = [
        next(r for r in records if isinstance(r, Label) and r.kind == "room" and r.room == room) for room in rooms
    ]
    engine = Engine(plan, _settings())
    t = _drive(engine, records, max(label.t1 for label in labels) + 0.5)
    for label in labels:
        engine.label(replace(label, source="wizard"))
    engine.advance(t + 0.5)
    assert engine._labels == []
    return plan, engine, t + 0.5


def _without_room(plan: Plan, room: str) -> Plan:
    return replace(
        plan,
        rooms=tuple(r for r in plan.rooms if r.id != room),
        adjacent=tuple(a for a in plan.adjacent if room not in a),
    )


def _room_keys(model: dict[str, Json]) -> set[str]:
    emit = model["emit"]
    entries = model["entries"]
    assert isinstance(emit, dict)
    assert isinstance(entries, dict)
    return {key.rsplit("|", 1)[1] for key in emit} | set(entries)


def test_a_proposal_learned_only_from_a_removed_room_goes_with_it() -> None:
    plan, engine, _t = _learned(("hall",))
    pending = engine.model_state()["pending"]
    assert isinstance(pending, dict)
    assert _room_keys(pending) == {"hall"}
    edited = Engine.successor(engine.carry(), _without_room(plan, "hall"), _settings()).inherit(engine)
    assert edited.pending_id() is None


def test_a_removed_room_leaves_the_proposal_and_the_active_model() -> None:
    plan, learned, _t = _learned(("hall", "bed"))
    pending = learned.model_state()["pending"]
    engine = Engine(plan, _settings(), {"active": pending, "pending": pending, "pending_seq": 3})
    fresh = Engine.successor(engine.carry(), _without_room(plan, "hall"), _settings())
    assert fresh.foreign_rooms() == {"hall"}
    edited = fresh.inherit(engine)
    assert edited.foreign_rooms() == frozenset()
    state = edited.model_state()
    active, kept = state["active"], state["pending"]
    assert isinstance(active, dict)
    assert isinstance(kept, dict)
    assert _room_keys(active) == _room_keys(kept) == {"bed"}
    assert edited.pending_id() == engine.pending_id() == "p-0001-0003"
    readded = Engine.successor(edited.carry(), plan, _settings())
    assert readded.foreign_rooms() == frozenset()


def test_a_proposal_with_background_learning_stays_after_a_room_removal() -> None:
    plan, engine, _t = _learned(("hall",))
    engine._touch(None)
    edited = Engine.successor(engine.carry(), _without_room(plan, "hall"), _settings()).inherit(engine)
    assert edited.pending_id() is not None
    stored = Engine(plan, _settings(), engine.model_state())
    assert Engine.successor(stored.carry(), _without_room(plan, "hall"), _settings()).inherit(stored).pending_id()
