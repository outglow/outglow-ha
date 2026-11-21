import math
from dataclasses import dataclass
from itertools import combinations

from .defaults import AGREE_S, RX_MIN_DIRECTIONS, RX_WIDE_FRAC, VETO_FRAC, VETO_HOLD_S, VETO_MIN_ROOMS
from .topology import Direction, Pair, Topology
from .types import DirectionState, Veto

DATA = frozenset({"exceed", "quiet"})


@dataclass(frozen=True, slots=True)
class PairObs:
    obs: int | None
    censored: bool = False
    single: bool = False


@dataclass(frozen=True, slots=True)
class PairTick:
    states: dict[Direction, DirectionState]
    obs: dict[Pair, PairObs]
    veto: Veto | None
    vetoed_rx: frozenset[str]


class PairLayer:
    def __init__(self, topo: Topology, agree: bool = True, veto: bool = True) -> None:
        self._topo = topo
        self._agree = agree
        self._veto_enabled = veto
        self._last_exceed: dict[Direction, float] = {}
        self._prev: dict[Direction, DirectionState] = {}
        self._common_until = -math.inf
        self._rx_until: dict[str, float] = {}

    def inherit(self, old: PairLayer) -> None:
        directions = set(self._topo.directions)
        bulbs = set(self._topo.bulbs)
        self._last_exceed = {d: t for d, t in old._last_exceed.items() if d in directions}
        self._prev = {d: s for d, s in old._prev.items() if d in directions}
        self._common_until = old._common_until
        self._rx_until = {rx: t for rx, t in old._rx_until.items() if rx in bulbs}

    def step(self, t: float, raw: dict[Direction, DirectionState], noisy: frozenset[Direction]) -> PairTick:
        states = dict(raw)
        onsets = {d for d, s in states.items() if s == "exceed" and self._prev.get(d) != "exceed"}
        self._prev = dict(raw)
        if self._veto_enabled:
            self._receiver_veto(t, states, onsets)
        vetoed_rx = frozenset(rx for rx, until in self._rx_until.items() if t < until)
        for d in states:
            if d[0] in vetoed_rx:
                states[d] = "none"
        for d, s in states.items():
            if s == "exceed":
                self._last_exceed[d] = t
        veto = self._common_veto(t, states) if self._veto_enabled else None
        if veto is not None:
            return PairTick(states, {p: PairObs(None) for p in self._topo.pairs}, veto, vetoed_rx)
        obs = {p: self._pair(t, p, states, noisy) for p in self._topo.pairs}
        return PairTick(states, obs, None, vetoed_rx)

    def _receiver_veto(self, t: float, states: dict[Direction, DirectionState], onsets: set[Direction]) -> None:
        for rx in self._topo.bulbs:
            mine = [d for d in states if d[0] == rx and states[d] in DATA]
            hits = [d for d in mine if d in onsets]
            if len(mine) < RX_MIN_DIRECTIONS or len(hits) < RX_WIDE_FRAC * len(mine):
                continue
            if not any(states.get((d[1], d[0])) == "exceed" for d in hits):
                self._rx_until[rx] = t + VETO_HOLD_S

    def _common_veto(self, t: float, states: dict[Direction, DirectionState]) -> Veto | None:
        with_data = [d for d, s in states.items() if s in DATA]
        hot = [d for d in with_data if states[d] == "exceed"]
        rooms = self._topo.rooms
        if len(rooms) > 2 and with_data and len(hot) >= VETO_FRAC * len(with_data):
            sets = [self._topo.explainers((min(d), max(d))) for d in hot]
            touched = frozenset().union(*sets)
            if len(touched) >= VETO_MIN_ROOMS and not self._explained(sets):
                self._common_until = t + VETO_HOLD_S
        return Veto(kind="common") if t < self._common_until else None

    def _explained(self, sets: list[frozenset[str]]) -> bool:
        groups = [frozenset((r,)) for r in self._topo.rooms]
        groups += [frozenset(c) for c in combinations(self._topo.rooms, 2) if self._topo.connected(c)]
        return any(all(s & g for s in sets) for g in groups)

    def _recent(self, t: float, d: Direction) -> bool:
        return t - self._last_exceed.get(d, -math.inf) < AGREE_S

    def _pair(
        self, t: float, pair: Pair, states: dict[Direction, DirectionState], noisy: frozenset[Direction]
    ) -> PairObs:
        a, b = pair
        d1, d2 = (a, b), (b, a)
        s1, s2 = states[d1], states[d2]
        e1 = s1 == "exceed" and not (d1 in noisy and not self._recent(t, d2))
        e2 = s2 == "exceed" and not (d2 in noisy and not self._recent(t, d1))
        if e1 or e2:
            if not self._agree:
                return PairObs(1)
            if self._recent(t, d1) and self._recent(t, d2):
                return PairObs(2)
            return PairObs(1, single=(s2 if e1 else s1) == "none")
        nones = (s1 == "none") + (s2 == "none")
        if nones:
            return PairObs(None)
        return PairObs(0, censored=s1 == s2 == "quiet_censored")
