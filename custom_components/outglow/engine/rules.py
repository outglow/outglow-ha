from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Literal

from .topology import Direction, Pair, Topology, pair_of

RuleKind = Literal["pairs", "receiver"]


@dataclass(frozen=True, slots=True)
class RoomRule:
    kind: RuleKind = "pairs"
    areas: frozenset[str] | None = None
    weak: frozenset[str] = frozenset()
    extra: frozenset[str] = frozenset()
    both_directions: bool = True


@dataclass(frozen=True, slots=True)
class RuleConfig:
    rooms: Mapping[str, RoomRule] = field(default_factory=dict)
    skip: frozenset[Direction] = frozenset()
    default: RoomRule = RoomRule()


class Rules:
    def __init__(self, topo: Topology, config: RuleConfig | None = None) -> None:
        self._topo = topo
        cfg = config or RuleConfig()
        self._skip = cfg.skip | topo.excluded
        self._rules = {r: cfg.rooms.get(r, cfg.default) for r in topo.rooms}
        self._own = {r: frozenset(b for b in topo.bulbs if topo.bulb_room[b] == r) for r in topo.rooms}

    def _active(self, motion: Callable[[Direction], bool]) -> set[Direction]:
        return {d for d in self._topo.directions if d not in self._skip and motion(d)}

    def evidence(self, room: str, on: set[Direction]) -> frozenset[Pair]:
        rule = self._rules[room]
        own = self._own[room]
        if rule.kind == "receiver":
            return frozenset(pair_of(rx, tx) for rx, tx in on if rx in own or (rx in rule.extra and tx in own))
        allowed = self._topo.neighbours[room] if rule.areas is None else rule.areas
        ok = own | rule.extra | {b for b in self._topo.bulbs if self._topo.bulb_room[b] in allowed}
        pairs: set[Pair] = set()
        for rx, tx in on:
            if rx in ok and tx in ok and (rx in own or tx in own):
                if rule.both_directions and (tx, rx) not in on:
                    continue
                pairs.add(pair_of(rx, tx))
        return frozenset(pairs)

    def enough(self, room: str, pairs: frozenset[Pair]) -> bool:
        rule = self._rules[room]
        if rule.kind == "receiver":
            return bool(pairs)
        strong = [p for p in pairs if not set(p) & rule.weak]
        return bool(strong) or len(pairs) >= 2

    def zone(self, room: str, motion: Callable[[Direction], bool]) -> bool:
        return self.enough(room, self.evidence(room, self._active(motion)))

    def inside(self, room: str, pairs: frozenset[Pair]) -> frozenset[Pair]:
        return frozenset(p for p in pairs if set(p) <= self._own[room])

    def zones(self, motion: Callable[[Direction], bool]) -> dict[str, bool]:
        on = self._active(motion)
        evidence = {r: self.evidence(r, on) for r in self._topo.rooms}
        anchored = {r for r in self._topo.rooms if self.enough(r, self.inside(r, evidence[r]))}
        explained = frozenset[Pair]().union(*(evidence[r] for r in anchored))
        return {r: r in anchored or self.enough(r, evidence[r] - explained) for r in self._topo.rooms}
