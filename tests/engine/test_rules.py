from collections.abc import Callable
from dataclasses import replace
from itertools import combinations

from engine.rules import RoomRule, RuleConfig, Rules
from engine.topology import build
from tests.engine.helpers import B1, B2, B3, B4, FLAT3

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


def test_zones_do_not_depend_on_the_order_of_rooms_or_ticks() -> None:
    flipped = Rules(build(replace(FLAT3, rooms=tuple(reversed(FLAT3.rooms)))))
    rules = Rules(TOPO)
    lines = list(combinations((B1, B2, B3, B4), 2))
    patterns = [_both(*c) for n in range(len(lines) + 1) for c in combinations(lines, n)]
    for hot in [*patterns, *reversed(patterns)]:
        zones = rules.zones(_on(*hot))
        assert zones == flipped.zones(_on(*hot)) == Rules(TOPO).zones(_on(*hot))
        assert all(rules.zone(r, _on(*hot)) for r, lit in zones.items() if lit)
