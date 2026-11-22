from collections.abc import Callable
from dataclasses import replace
from itertools import combinations

from engine.rules import RoomRule, RuleConfig, Rules
from engine.topology import build
from engine.types import ExcludedDirection, Plan, PlanBulb, Room
from tests.engine.helpers import B1, B2, B3, B4, FLAT3, H0, H1, H2, H3, H4, WIDE, square

TOPO = build(FLAT3)


def _on(*dirs: tuple[str, str]) -> Callable[[tuple[str, str]], bool]:
    hot = set(dirs)
    return lambda d: d in hot


def test_pairs_rule_needs_both_directions_by_default() -> None:
    rules = Rules(TOPO)
    assert not rules.zone("hall", _on((B3, B1)))
    assert rules.zone("hall", _on((B3, B1), (B1, B3)))
    assert rules.zones(_on((B3, B1), (B1, B3))) == {"living": True, "hall": True, "office": False}
    assert not rules.zone("living", _on((B4, B1), (B1, B4)))


def test_weak_bulbs_count_only_with_another_pair_and_skip() -> None:
    cfg = RuleConfig(
        rooms={"hall": RoomRule(areas=frozenset({"office"}), weak=frozenset({B3}), both_directions=False)},
        skip=frozenset({(B4, B2)}),
    )
    rules = Rules(TOPO, cfg)
    assert not rules.zone("hall", _on((B3, B4)))
    assert rules.zone("hall", _on((B3, B4), (B1, B3))) is False
    assert not rules.zone("office", _on((B4, B2)))


def test_receiver_rule_with_extra_bulbs() -> None:
    cfg = RuleConfig(default=RoomRule(kind="receiver", extra=frozenset({B3})))
    rules = Rules(TOPO, cfg)
    assert rules.zone("office", _on((B4, B1)))
    assert rules.zone("office", _on((B3, B4)))
    assert not rules.zone("office", _on((B3, B1)))
    extra = Rules(
        TOPO, RuleConfig(default=RoomRule(extra=frozenset({B1}), weak=frozenset({B1}), both_directions=False))
    )
    assert not extra.zone("office", _on((B1, B4), (B4, B2)))
    assert extra.zone("office", _on((B1, B4), (B3, B4)))


def _both(*pairs: tuple[str, str]) -> tuple[tuple[str, str], ...]:
    return tuple(d for a, b in pairs for d in ((a, b), (b, a)))


def test_a_room_with_its_own_pair_takes_the_pairs_it_shares() -> None:
    rules = Rules(TOPO)
    shared = _both((B3, B1))
    inside = _both((B1, B2))
    hall = _both((B3, B4))
    assert rules.zones(_on(*shared)) == {"living": True, "hall": True, "office": False}
    assert rules.zones(_on(*shared, *inside)) == {"living": True, "hall": False, "office": False}
    assert rules.zones(_on(*shared, *inside, *hall)) == {"living": True, "hall": True, "office": True}
    assert rules.zones(_on(*shared, *hall)) == {"living": True, "hall": True, "office": True}


def test_walking_from_a_room_with_its_own_pair_into_a_single_bulb_room() -> None:
    rules = Rules(TOPO)
    assert rules.zones(_on(*_both((B1, B2), (B1, B3)))) == {"living": True, "hall": False, "office": False}
    assert rules.zones(_on(*_both((B1, B3), (B2, B3))))["hall"]
    assert rules.zones(_on(*_both((B3, B4)))) == {"living": False, "hall": True, "office": True}


def _plan(*bulbs: str, skip: tuple[tuple[str, str], ...] = ()) -> Plan:
    kept = tuple(b for b in WIDE.bulbs if b.ieee in bulbs)
    return replace(WIDE, bulbs=kept, excluded_directions=tuple(ExcludedDirection(rx=rx, tx=tx) for rx, tx in skip))


def test_a_single_bulb_room_keeps_a_full_fan_of_its_lines_into_a_neighbour() -> None:
    rules = Rules(build(_plan(H1, H2, H3, H0)))
    inside = _both((H1, H2))
    fan = _both((H0, H1), (H0, H2), (H0, H3))
    assert rules.zones(_on(*inside, *fan)) == {"hall": True, "office": True}
    assert rules.zones(_on(*inside, *fan[:4])) == {"hall": True, "office": False}
    assert rules.zones(_on(*inside, *fan[:5])) == {"hall": True, "office": False}
    receiver = Rules(build(_plan(H1, H2, H3, H0)), RuleConfig(default=RoomRule(kind="receiver")))
    taken = ((H1, H2), (H1, H0), (H2, H0), (H3, H0))
    assert receiver.zones(_on(*taken, (H0, H1), (H0, H2), (H0, H3)))["office"]
    assert not receiver.zones(_on(*taken, (H0, H1), (H0, H2)))["office"]


def test_a_fan_needs_three_lines() -> None:
    rules = Rules(TOPO)
    inside = _both((B1, B2))
    assert rules.zones(_on(*inside, *_both((B1, B3), (B2, B3)))) == {"living": True, "hall": False, "office": False}
    two = Rules(build(_plan(H1, H2, H0)))
    assert two.zones(_on(*_both((H1, H2), (H0, H1), (H0, H2)))) == {"hall": True, "office": False}


def test_a_skipped_direction_keeps_its_pair_in_the_fan_through_the_other_direction() -> None:
    rules = Rules(build(_plan(H1, H2, H3, H4, H0, skip=((H0, H4),))))
    inside = _both((H1, H2))
    fan = _both((H0, H1), (H0, H2), (H0, H3))
    assert rules.zones(_on(*inside, *fan)) == {"hall": True, "office": False}
    assert rules.zones(_on(*inside, *fan, (H4, H0))) == {"hall": True, "office": True}
    config = Rules(build(_plan(H1, H2, H3, H4, H0)), RuleConfig(skip=frozenset({(H4, H0)})))
    assert config.zones(_on(*inside, *fan, (H0, H4))) == {"hall": True, "office": True}
    assert config.zones(_on(*inside, *fan)) == {"hall": True, "office": False}


def test_one_skipped_direction_of_a_three_line_fan_keeps_the_fan() -> None:
    rules = Rules(build(_plan(H1, H2, H3, H0, skip=((H0, H3),))))
    inside = _both((H1, H2))
    moving = (*_both((H0, H1), (H0, H2)), (H3, H0))
    assert rules.zones(_on(*inside, *moving)) == {"hall": True, "office": True}
    assert rules.zones(_on(*inside, *moving[:4])) == {"hall": True, "office": False}
    receiver = Rules(build(_plan(H1, H2, H3, H0, skip=((H0, H3),))), RuleConfig(default=RoomRule(kind="receiver")))
    taken = ((H1, H2), (H1, H0), (H2, H0), (H3, H0))
    assert not receiver.zones(_on(*taken, (H0, H1), (H0, H2)))["office"]


def _row(*bulbs: tuple[str, float, float]) -> Plan:
    return Plan(
        rooms=(
            Room(id="w", name="W", outline=square(0, 0, 4, 4)),
            Room(id="m", name="M", outline=square(4, 0, 7, 4)),
            Room(id="e", name="E", outline=square(7, 0, 11, 4)),
        ),
        adjacent=(("w", "m"), ("m", "e")),
        bulbs=tuple(PlanBulb(ieee=b, x=x, y=y) for b, x, y in bulbs),
    )


def test_a_single_bulb_room_between_two_anchored_rooms_keeps_the_joint_fan_of_its_lines() -> None:
    plan = _row((B1, 1, 1), (B2, 3, 3), (H0, 5.5, 2), (B3, 8, 1), (B4, 10, 3))
    rules = Rules(build(plan))
    anchors = _both((B1, B2), (B3, B4))
    west, east = _both((H0, B1), (H0, B2)), _both((H0, B3), (H0, B4))
    assert rules.zones(_on(*anchors, *west, *east)) == {"w": True, "m": True, "e": True}
    assert rules.zones(_on(*anchors, *west, *east[:3])) == {"w": True, "m": False, "e": True}
    assert rules.zones(_on(*anchors, *west)) == {"w": True, "m": False, "e": True}
    assert rules.zones(_on(*_both((B1, B2)), *west, *east[:2])) == {"w": True, "m": True, "e": True}
    assert rules.zones(_on(*_both((B1, B2)), *west)) == {"w": True, "m": False, "e": False}
    flipped = Rules(build(replace(plan, rooms=tuple(reversed(plan.rooms)))))
    lines = list(combinations((B1, B2, B3, B4, H0), 2))
    for n in range(len(lines) + 1):
        for chosen in combinations(lines, n):
            hot = _on(*_both(*chosen))
            zones = rules.zones(hot)
            assert zones == flipped.zones(hot)
            assert all(rules.zone(r, hot) for r, lit in zones.items() if lit)


def test_a_fan_counts_only_the_lines_that_deliver_data() -> None:
    rules = Rules(build(_plan(H1, H2, H3, H4, H0)))
    inside = _both((H1, H2))
    fan = _both((H0, H1), (H0, H2), (H0, H3))
    assert rules.zones(_on(*inside, *fan)) == {"hall": True, "office": False}
    rules.live(lambda d: H4 not in d)
    assert rules.zones(_on(*inside, *fan)) == {"hall": True, "office": True}
    rules.live(lambda d: H4 not in d)
    assert rules.zones(_on(*inside, *fan[:4])) == {"hall": True, "office": False}
    rules.live(lambda d: H4 not in d and H3 not in d)
    assert rules.zones(_on(*inside, *fan[:4])) == {"hall": True, "office": False}
    rules.live(lambda d: True)
    assert rules.zones(_on(*inside, *fan, *_both((H0, H4)))) == {"hall": True, "office": True}


def test_zones_do_not_depend_on_the_order_of_rooms_or_ticks() -> None:
    flipped = Rules(build(replace(FLAT3, rooms=tuple(reversed(FLAT3.rooms)))))
    rules = Rules(TOPO)
    lines = list(combinations((B1, B2, B3, B4), 2))
    patterns = [_both(*c) for n in range(len(lines) + 1) for c in combinations(lines, n)]
    for hot in [*patterns, *reversed(patterns)]:
        zones = rules.zones(_on(*hot))
        assert zones == flipped.zones(_on(*hot)) == Rules(TOPO).zones(_on(*hot))
        assert all(rules.zone(r, _on(*hot)) for r, lit in zones.items() if lit)
