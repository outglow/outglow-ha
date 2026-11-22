from engine.ingest import Ingest
from engine.topology import build
from engine.types import ExcludedDirection, LightState, Plan
from tests.engine.helpers import B1, B2, B3, FLAT3, all_levels, obs


def _ingest(plan: Plan = FLAT3) -> Ingest:
    return Ingest(build(plan))


def test_gate_follows_activity_reports() -> None:
    ing = _ingest()
    assert ing.gate(B1, 0.0) == "closed"
    ing.observe(obs(1.0, B1, all_levels(B1, 5), source="lines"))
    assert ing.gate(B1, 1.0) == "closed"
    ing.observe(obs(2.0, B1, all_levels(B1, 5)))
    ing.observe(obs(2.5, B1, all_levels(B1, 6)))
    assert ing.gate(B1, 4.0) == "open"
    assert ing.gate(B1, 5.0) == "closed"
    ing.set_offline(frozenset({B1}))
    assert ing.gates(2.5)[B1] == "offline"
    assert ing.messages == 3


def test_samples_levels_hold_censoring_and_flags() -> None:
    plan = Plan(
        **{**{f: getattr(FLAT3, f) for f in FLAT3.__slots__}, "excluded_directions": (ExcludedDirection(B1, B3),)}
    )
    ing = _ingest(plan)
    ing.observe(obs(1.0, B1, {B2: 9, B3: 30}, signal=-90))
    ing.observe(obs(1.1, B1, {B2: 12}, signal=0))
    gates = ing.gates(1.2)
    s = ing.tick(1.2, gates)
    assert s[(B1, B2)].level == 12
    assert s[(B1, B2)].flags == ("weak",)
    assert s[(B1, B3)].flags == ("weak", "excluded")
    assert ing.signal((B1, B2)) == -90
    assert ing.tick(1.7, gates)[(B1, B2)].level == 12
    assert ing.tick(2.6, gates)[(B1, B2)].level is None
    assert ing.tick(2.6, gates)[(B2, B1)].censored
    ing.set_offline(frozenset({B2}))
    assert ing.tick(2.6, ing.gates(2.6))[(B2, B1)] == ing.tick(2.6, ing.gates(2.6))[(B2, B1)]
    assert not ing.tick(2.6, ing.gates(2.6))[(B2, B1)].censored


def test_light_changes_blank_both_ends() -> None:
    ing = _ingest()
    ing.observe(obs(1.0, B1, all_levels(B1, 5), light=LightState(on=True)))
    ing.observe(obs(1.5, B1, all_levels(B1, 6), light=LightState(on=True)))
    assert "blanked" not in ing.tick(1.5, ing.gates(1.5))[(B1, B2)].flags
    ing.observe(obs(2.0, B1, all_levels(B1, 7), light=LightState(on=False)))
    assert "blanked" in ing.tick(2.0, ing.gates(2.0))[(B1, B2)].flags
    ing.light(B3, 10.0)
    ing.observe(obs(10.5, B1, all_levels(B1, 7)))
    assert "blanked" in ing.tick(10.5, ing.gates(10.5))[(B1, B3)].flags
    assert "blanked" not in ing.tick(10.5, ing.gates(10.5))[(B1, B2)].flags


def test_frozen_needs_a_constant_level_while_others_change() -> None:
    ing = _ingest()
    for i in range(9):
        ing.observe(obs(1.0 + 0.5 * i, B1, {B2: 39, B3: i}))
    assert ing.frozen((B1, B2))
    assert "frozen" in ing.tick(5.0, ing.gates(5.0))[(B1, B2)].flags
    ing.observe(obs(6.0, B1, {B2: 40, B3: 1}))
    assert not ing.frozen((B1, B2))
    for i in range(9):
        ing.observe(obs(7.0 + 0.5 * i, B1, {B2: 0, B3: i}))
    assert not ing.frozen((B1, B2))


def test_motion_occupancy_and_unknown_bulbs() -> None:
    ing = _ingest()
    ing.observe(obs(1.0, B1, {B2: 30}, motion=frozenset({B2}), occupancy=True, source="lines"))
    ing.observe(obs(1.0, "0xffffffffffffffff", {B2: 30}))
    ing.observe(obs(1.0, B1, {"0xffffffffffffffff": 30}))
    assert ing.motion((B1, B2))
    assert ing.occupancy(B1)
    assert not ing.weak((B1, B3))
    ing.set_offline(frozenset({B1}))
    assert not ing.motion((B1, B2))
    assert not ing.occupancy(B1)


def test_a_direction_delivers_data_once_heard_while_both_ends_are_online() -> None:
    ing = _ingest()
    ing.observe(obs(1.0, B1, {B2: 3, B3: 0}, signal=None))
    assert not ing.delivering((B1, B2))
    ing.observe(obs(1.5, B1, {B2: 3, B3: 0}, motion=frozenset({B3}), signal=None))
    assert ing.delivering((B1, B3))
    assert not ing.delivering((B1, B2))
    ing.observe(obs(2.0, B1, {B2: 3}, signal=0))
    assert not ing.delivering((B1, B2))
    ing.observe(obs(2.5, B1, {B2: 3}, signal=-70))
    ing.observe(obs(3.0, B1, {B2: 3}, signal=None))
    assert ing.delivering((B1, B2))
    assert not ing.delivering((B2, B1))
    ing.set_offline(frozenset({B2}))
    assert not ing.delivering((B1, B2))
    assert ing.delivering((B1, B3))
    ing.set_offline(frozenset({B1}))
    assert not ing.delivering((B1, B3))
