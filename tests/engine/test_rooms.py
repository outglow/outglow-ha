import math

from engine.defaults import EXTRA_ROOM_PRIOR
from engine.emission import states_of
from engine.rooms import Rooms, posterior, state_prior
from engine.topology import build
from tests.engine.helpers import FLAT3

TOPO = build(FLAT3)
HOLD = {"living": 10, "hall": 10, "office": 10}


def _rooms() -> Rooms:
    return Rooms(
        TOPO, {"living": "normal", "hall": "fast", "office": "calm"}, {"living": 0.9, "hall": 0.9, "office": 0.9}
    )


def test_state_prior_and_posterior() -> None:
    states = states_of(("a", "b"))
    prior = state_prior({"a": 0.5, "b": 0.1}, states)
    assert math.isclose(sum(prior), 1.0)
    p = posterior(prior, [0.0, 3.0, 0.0, 3.0], states, ("a", "b"))
    assert p["a"] > 0.9 > p["b"]


def test_each_extra_room_costs_prior() -> None:
    states = states_of(("a", "b", "c"))
    prior = dict(zip(states, state_prior({"a": 0.5, "b": 0.5, "c": 0.5}, states), strict=True))
    one = prior[frozenset({"a"})]
    assert math.isclose(prior[frozenset()], one)
    assert math.isclose(prior[frozenset({"a", "b"})], EXTRA_ROOM_PRIOR * one)
    assert math.isclose(prior[frozenset({"a", "b", "c"})], EXTRA_ROOM_PRIOR**2 * one)


def test_enter_depends_on_neighbours_and_entrance() -> None:
    rooms = _rooms()
    assert rooms.enter("living", 0.0) == 0.002
    assert rooms.enter("hall", 0.0) == 0.02
    rooms.state["hall"].last_motion = 5.0
    assert rooms.enter("living", 10.0) == 0.05
    rooms.state["living"].p = 1.0
    assert math.isclose(rooms.predict(10.0)["living"], 0.9)


def test_decisions_hysteresis_and_hold() -> None:
    rooms = _rooms()
    high = {"living": 0.95, "hall": 0.95, "office": 0.95}
    rooms.decide(1.0, high, "unknown", HOLD, False)
    assert [rooms.state[r].motion for r in TOPO.rooms] == [False, True, False]
    rooms.decide(1.5, high, "unknown", HOLD, False)
    assert rooms.state["living"].motion
    assert rooms.state["living"].since == 1.5
    for t in (2.0, 2.5):
        rooms.decide(t, high, "unknown", HOLD, False)
    assert rooms.state["office"].motion
    rooms.decide(3.0, {"living": 0.5, "hall": 0.2, "office": 0.5}, "unknown", HOLD, False)
    assert rooms.state["living"].motion
    assert not rooms.state["hall"].motion
    assert rooms.occupied("hall", 5.0, 10)
    rooms.decide(20.0, {"living": 0.0, "hall": 0.0, "office": 0.0}, "unknown", HOLD, False)
    assert not rooms.occupied("hall", 20.0, 10)
    assert rooms.state["hall"].since is None
    rooms.decide(21.0, {"living": 1.0, "hall": 0.0, "office": 0.0}, "unknown", HOLD, True)
    assert rooms.state["living"].motion


def test_empty_house_blocks_all_but_the_entrance() -> None:
    rooms = _rooms()
    high = {"living": 1.0, "hall": 1.0, "office": 1.0}
    rooms.decide(1.0, high, "yes", HOLD, True)
    assert [rooms.state[r].motion for r in TOPO.rooms] == [False, True, False]
    rooms.decide(1.5, high, "yes", HOLD, True)
    assert rooms.state["living"].motion
    rooms.decide(2.0, high, "no", HOLD, True)
    rooms.decide(2.5, high, "yes", HOLD, True)
    assert not rooms.state["living"].motion
