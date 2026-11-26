import math

from engine.emission import Emission, code_of, information, params, prior_theta, probabilities, states_of
from engine.model import Model
from engine.pairs import PairObs
from engine.topology import build
from engine.types import Plan, PlanBulb, Room
from tests.engine.helpers import B1, B2, B3, B4, FLAT3, TWO, square

TOPO = build(FLAT3)


def test_prior_classes() -> None:
    assert prior_theta(TOPO, (B1, B2), "living", False) == 0.12
    assert prior_theta(TOPO, (B1, B3), "living", False) == 0.30
    assert prior_theta(TOPO, (B1, B3), "office", False) == 0.05
    assert math.isclose(prior_theta(TOPO, (B1, B4), "living", False), 0.12)
    assert prior_theta(TOPO, (B1, B2), "office", False) == 0.01
    assert prior_theta(TOPO, (B1, B2), "living", True) == 0.06
    assert math.isclose(prior_theta(TOPO, (B2, B4), "office", False), 0.12)
    two = build(TWO)
    assert math.isclose(prior_theta(two, (B2, B3), "b", False), 0.36)
    lamp = build(Plan(rooms=TWO.rooms, bulbs=(PlanBulb(ieee=B1, x=5, y=1), PlanBulb(ieee=B2, x=7, y=1, height="lamp"))))
    assert prior_theta(lamp, (B1, B2), "b", False) == 0.2
    plan = Plan(
        rooms=tuple(Room(id=r, name=r, outline=square(2 * i, 0, 2 * i + 2, 2)) for i, r in enumerate("amb")),
        bulbs=(PlanBulb(ieee=B1, x=1, y=1), PlanBulb(ieee=B2, x=5, y=1)),
    )
    assert prior_theta(build(plan), (B1, B2), "m", False) == 0.15
    big = build(Plan(rooms=(*plan.rooms, Room(id="z", name="z", outline=square(9, 9, 10, 10))), bulbs=plan.bulbs))
    assert prior_theta(big, (B1, B2), "z", False) == 0.01


def test_states_and_codes() -> None:
    assert len(states_of(("a", "b", "c", "d"))) == 15
    assert len(states_of(("a", "b"))) == 4
    assert [
        code_of(PairObs(o, c, s))
        for o, c, s in [
            (None, False, False),
            (0, False, False),
            (0, True, False),
            (1, False, False),
            (1, False, True),
            (2, False, False),
        ]
    ] == [
        None,
        0,
        3,
        1,
        4,
        2,
    ]


def test_learned_parameters() -> None:
    model = Model()
    model.pair_bg[(B1, B2)] = [900.0, 100.0, 0.0]
    model.emit[((B1, B3), "hall")] = [50.0, 30.0, 20.0]
    model.emit[((B1, B3), "office")] = [0.0, 0.0, 0.0]
    p = params(TOPO, model, lambda pair: False)
    assert math.isclose(p[(B1, B2)].eps1, 100.4 / 1020)
    assert p[(B1, B2)].eps2 == 0.001
    assert 0.3 < p[(B1, B3)].theta["hall"] < 0.5
    assert p[(B1, B3)].theta["office"] == 0.05
    assert math.isclose(p[(B1, B3)].eta, (20 + 12) / (50 + 20))
    flat = params(TOPO, model, lambda pair: False, geometric=False, learned=False)
    assert flat[(B1, B3)].theta == {"living": 0.2, "hall": 0.2, "office": 0.2}
    assert flat[(B1, B2)].eps1 == 0.02


def test_probabilities_and_information() -> None:
    p = params(TOPO, Model(), lambda pair: False)[(B1, B3)]
    quiet = probabilities(p, frozenset())
    moving = probabilities(p, frozenset({"living"}))
    assert math.isclose(sum(quiet[:3]), 1.0)
    assert moving[2] > quiet[2]
    assert math.isclose(moving[3], 0.7 * moving[0] + 0.3)
    binary = probabilities(p, frozenset({"living"}), binary=True)
    assert binary[1] == binary[2] == binary[4]
    assert information(p, "living") > information(p, "office") > 0


def test_two_rooms_disturb_a_pair_as_the_stronger_one_does() -> None:
    p = params(TOPO, Model(), lambda pair: False)[(B1, B3)]
    weak, strong = sorted(("living", "office"), key=p.theta.__getitem__)
    assert p.theta[strong] > p.theta[weak] > 0
    assert probabilities(p, frozenset({strong, weak})) == probabilities(p, frozenset({strong}))
    assert probabilities(p, frozenset({strong, weak})) != probabilities(p, frozenset({weak}))


def test_emission_loglik_cache_and_contribution() -> None:
    states = states_of(TOPO.rooms)
    em = Emission(TOPO, params(TOPO, Model(), lambda pair: False), states)
    codes = tuple(2 if pair == (B1, B3) else None if pair == (B2, B4) else 0 for pair in TOPO.pairs)
    ll = em.loglik(codes)
    assert em.loglik(codes) is ll
    best = states[max(range(len(states)), key=lambda i: ll[i])]
    assert best & {"living", "hall"}
    top = em.contribution(codes, "hall")
    assert top[0][1] == (B1, B3)
    for i in range(4100):
        em.loglik(tuple((i // 5**k) % 5 for k in range(6)))
    assert len(em._cache) <= 4097
