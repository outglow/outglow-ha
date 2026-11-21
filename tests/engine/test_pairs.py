from engine.pairs import PairLayer, PairObs
from engine.topology import build
from engine.types import DirectionState, Plan, PlanBulb, Room
from tests.engine.helpers import B1, B2, B3, B4, FLAT3, TWO, square

TOPO = build(FLAT3)


def _states(default: DirectionState = "quiet", **over: DirectionState) -> dict[tuple[str, str], DirectionState]:
    names = {"b1": B1, "b2": B2, "b3": B3, "b4": B4}
    out = dict.fromkeys(TOPO.directions, default)
    for key, value in over.items():
        rx, tx = key.split("_")
        out[(names[rx], names[tx])] = value
    return out


def test_pair_observations() -> None:
    layer = PairLayer(TOPO)
    tick = layer.step(0.0, _states(b1_b2="exceed", b3_b4="none", b4_b3="none"), frozenset())
    assert tick.obs[(B1, B2)] == PairObs(1)
    assert tick.obs[(B3, B4)] == PairObs(None)
    assert tick.obs[(B1, B3)] == PairObs(0)
    tick = layer.step(0.5, _states(b2_b1="exceed", b3_b4="exceed", b4_b3="none"), frozenset())
    assert tick.obs[(B1, B2)] == PairObs(2)
    assert tick.obs[(B3, B4)] == PairObs(1, single=True)
    assert tick.obs[(B1, B4)] == PairObs(0)
    tick = layer.step(5.0, _states("quiet_censored", b1_b2="quiet", b2_b3="none"), frozenset())
    assert tick.obs[(B1, B2)] == PairObs(0)
    assert tick.obs[(B1, B3)] == PairObs(0, censored=True)
    assert tick.obs[(B2, B3)] == PairObs(None)
    assert tick.veto is None


def test_noisy_directions_need_the_other_side() -> None:
    layer = PairLayer(TOPO)
    noisy = frozenset({(B1, B2)})
    assert layer.step(0.0, _states(b1_b2="exceed"), noisy).obs[(B1, B2)] == PairObs(0)
    assert layer.step(0.5, _states(b1_b2="exceed", b2_b1="exceed"), noisy).obs[(B1, B2)] == PairObs(2)


def test_binary_mode_without_agreement() -> None:
    layer = PairLayer(TOPO, agree=False)
    assert layer.step(0.0, _states(b1_b2="exceed", b2_b1="exceed"), frozenset()).obs[(B1, B2)] == PairObs(1)


def test_receiver_veto() -> None:
    plan = Plan(
        rooms=(Room(id="r", name="R", outline=square(0, 0, 9, 9)),),
        bulbs=tuple(PlanBulb(ieee=f"0x{n:016x}", x=n, y=1) for n in range(1, 7)),
    )
    topo = build(plan)
    layer = PairLayer(topo)
    rx = topo.bulbs[0]
    states: dict[tuple[str, str], DirectionState] = {d: "exceed" if d[0] == rx else "quiet" for d in topo.directions}
    tick = layer.step(0.0, states, frozenset())
    assert tick.vetoed_rx == {rx}
    assert all(tick.states[d] == "none" for d in topo.directions if d[0] == rx)
    assert layer.step(3.5, states, frozenset()).vetoed_rx == frozenset()
    both = dict(states)
    both[(topo.bulbs[1], rx)] = "exceed"
    assert PairLayer(topo).step(0.0, both, frozenset()).vetoed_rx == frozenset()


ROW = Plan(
    rooms=tuple(Room(id=r, name=r, outline=square(3 * i, 0, 3 * i + 3, 3)) for i, r in enumerate("abcd")),
    adjacent=(("a", "b"), ("b", "c"), ("c", "d")),
    bulbs=tuple(PlanBulb(ieee=f"0x{3 * i + k + 1:016x}", x=3 * i + 1 + k, y=1.5) for i in range(4) for k in (0, 1)),
)


def test_common_veto_needs_three_unexplainable_rooms() -> None:
    topo = build(ROW)
    hot_rooms = {"a", "c", "d"}

    def wave(rooms: set[str]) -> dict[tuple[str, str], DirectionState]:
        return {
            d: "exceed" if {topo.bulb_room[d[0]], topo.bulb_room[d[1]]} <= rooms else "quiet" for d in topo.directions
        }

    layer = PairLayer(topo)
    tick = layer.step(0.0, wave(hot_rooms), frozenset())
    assert tick.veto is not None
    assert tick.veto.kind == "common"
    assert all(o.obs is None for o in tick.obs.values())
    assert layer.step(2.0, wave(set()), frozenset()).veto is not None
    assert layer.step(3.5, wave(set()), frozenset()).veto is None
    assert PairLayer(TOPO).step(0.0, dict.fromkeys(TOPO.directions, "exceed"), frozenset()).veto is None
    assert PairLayer(topo, veto=False).step(0.0, wave(hot_rooms), frozenset()).veto is None
    assert PairLayer(topo).step(0.0, dict.fromkeys(topo.directions, "none"), frozenset()).veto is None
    two = build(TWO)
    assert PairLayer(two).step(0.0, dict.fromkeys(two.directions, "exceed"), frozenset()).veto is None
