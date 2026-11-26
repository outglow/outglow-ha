import math
from collections.abc import Callable
from dataclasses import dataclass
from itertools import combinations

from .defaults import (
    BETA_PRIOR,
    CONSTANT_THETA,
    EPS1_START,
    EPS2_START,
    ETA_PRIOR,
    GATE_CONFIDENCE,
    HARD_WALL_FACTOR,
    K_MAX,
    PRIOR_STRENGTH,
    THETA_ADJACENT,
    THETA_BACKGROUND,
    THETA_CROSSED,
    THETA_FAR_END,
    THETA_INSIDE,
    THETA_INSIDE_LOW,
    THETA_MAX,
    THETA_NEAR,
    WEAK_FACTOR,
)
from .model import Model
from .pairs import PairObs
from .topology import Pair, Topology

CODES = 5
State = frozenset[str]


def prior_theta(topo: Topology, pair: Pair, room: str, weak: bool) -> float:
    ra, rb = topo.ends(pair)
    low = any(topo.bulb_height[b] != "ceiling" for b in pair)
    if ra == rb == room:
        base = THETA_INSIDE_LOW if low else THETA_INSIDE
    elif room in (ra, rb):
        other = rb if ra == room else ra
        base = THETA_ADJACENT if topo.is_adjacent(room, other) else THETA_FAR_END
    elif room in topo.crossed[pair]:
        base = THETA_CROSSED
    elif topo.is_adjacent(room, ra) or topo.is_adjacent(room, rb):
        base = THETA_NEAR
    else:
        base = THETA_BACKGROUND
    if topo.hard_wall[pair] and ra != rb:
        base *= HARD_WALL_FACTOR
    if weak:
        base *= WEAK_FACTOR
    return min(base, THETA_MAX)


def states_of(rooms: tuple[str, ...], k_max: int = K_MAX) -> tuple[State, ...]:
    return tuple(frozenset(c) for k in range(min(k_max, len(rooms)) + 1) for c in combinations(rooms, k))


def code_of(o: PairObs) -> int | None:
    if o.obs is None:
        return None
    if o.obs == 0:
        return 3 if o.censored else 0
    if o.obs == 1 and o.single:
        return 4
    return o.obs


@dataclass(frozen=True, slots=True)
class PairParams:
    theta: dict[str, float]
    eta: float
    eps1: float
    eps2: float
    beta: float


def _ratio(num: float, den: float, prior: float, strength: float) -> float:
    return (num + prior * strength) / (den + strength)


def params(
    topo: Topology, model: Model, weak: Callable[[Pair], bool], geometric: bool = True, learned: bool = True
) -> dict[Pair, PairParams]:
    out = {}
    for pair in topo.pairs:
        bg = model.pair_bg.get(pair, [0.0, 0.0, 0.0]) if learned else [0.0, 0.0, 0.0]
        n_bg = sum(bg)
        eps1 = max(EPS1_START, _ratio(bg[1], n_bg, EPS1_START, PRIOR_STRENGTH))
        eps2 = max(EPS2_START, _ratio(bg[2], n_bg, EPS2_START, PRIOR_STRENGTH))
        quiet_hit = eps1 + eps2
        hits1 = hits2 = 0.0
        theta = {}
        for room in topo.rooms:
            prior = prior_theta(topo, pair, room, weak(pair)) if geometric else CONSTANT_THETA
            counts = model.emit.get((pair, room)) if learned else None
            if counts is None or sum(counts) <= 0:
                theta[room] = prior
                continue
            n = sum(counts)
            hits1 += counts[1]
            hits2 += counts[2]
            seen = (counts[1] + counts[2]) / n
            data = max(0.0, (seen - quiet_hit) / (1 - quiet_hit))
            theta[room] = min(THETA_MAX, (n * data + PRIOR_STRENGTH * prior) / (n + PRIOR_STRENGTH))
        eta = _ratio(hits2, hits1 + hits2, ETA_PRIOR, PRIOR_STRENGTH)
        out[pair] = PairParams(theta=theta, eta=eta, eps1=eps1, eps2=eps2, beta=BETA_PRIOR)
    return out


def probabilities(p: PairParams, state: State, binary: bool = False) -> tuple[float, ...]:
    reach = max((p.theta[room] for room in state), default=0.0)
    a = 1 - (1 - p.beta) * (1 - reach)
    if binary:
        hit = a + (1 - a) * (p.eps1 + p.eps2)
        p0 = 1 - hit
        return (p0, hit, hit, GATE_CONFIDENCE * p0 + 1 - GATE_CONFIDENCE, hit)
    p2 = a * p.eta + (1 - a) * p.eps2
    p1 = a * (1 - p.eta) + (1 - a) * p.eps1
    p0 = 1 - p1 - p2
    single = a * (1 + p.eta) / 2 + (1 - a) * (p.eps2 + p.eps1 / 2)
    return (p0, p1, p2, GATE_CONFIDENCE * p0 + 1 - GATE_CONFIDENCE, single)


def information(p: PairParams, room: str) -> float:
    on = probabilities(p, frozenset((room,)))[:3]
    off = probabilities(p, frozenset())[:3]
    return sum(x * math.log(x / y) for x, y in zip(on, off, strict=True))


def _columns(p: PairParams, states: tuple[State, ...], binary: bool) -> list[list[float]]:
    rows = [probabilities(p, s, binary) for s in states]
    return [[math.log(row[c]) for row in rows] for c in range(CODES)]


class Emission:
    def __init__(
        self, topo: Topology, pair_params: dict[Pair, PairParams], states: tuple[State, ...], binary: bool = False
    ) -> None:
        self.pairs = topo.pairs
        self.params = pair_params
        self.states = states
        self._cols = {pair: _columns(pair_params[pair], states, binary) for pair in topo.pairs}
        self._cache: dict[tuple[int | None, ...], list[float]] = {}

    def loglik(self, codes: tuple[int | None, ...]) -> list[float]:
        hit = self._cache.get(codes)
        if hit is not None:
            return hit
        acc = [0.0] * len(self.states)
        for pair, code in zip(self.pairs, codes, strict=True):
            if code is not None:
                col = self._cols[pair][code]
                acc = [x + y for x, y in zip(acc, col, strict=True)]
        if len(self._cache) > 4096:
            self._cache.clear()
        self._cache[codes] = acc
        return acc

    def contribution(self, codes: tuple[int | None, ...], room: str) -> list[tuple[float, Pair]]:
        on = self.states.index(frozenset((room,)))
        off = self.states.index(frozenset())
        out = []
        for pair, code in zip(self.pairs, codes, strict=True):
            if code is not None and code not in (0, 3):
                col = self._cols[pair][code]
                out.append((col[on] - col[off], pair))
        return sorted(out, key=lambda x: (-x[0], x[1]))
