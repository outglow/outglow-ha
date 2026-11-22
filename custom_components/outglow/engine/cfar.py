from collections.abc import Callable
from dataclasses import dataclass
from operator import itemgetter

from .defaults import (
    CFAR_FLOOR,
    CFAR_K,
    CFAR_Q,
    HYST_OFF,
    MAD_SCALE,
    REF_MIN_SAMPLES,
    SIGNAL_CLASSES,
    START_THRESHOLDS,
)
from .ingest import DirSample
from .model import Hist, Model
from .topology import Direction
from .types import DirectionState


def signal_class(signal: int | None) -> int:
    if signal is None:
        return 1
    return next((i for i, edge in enumerate(SIGNAL_CLASSES) if signal >= edge), len(SIGNAL_CLASSES))


def threshold_of(hist: Hist) -> float:
    return _threshold(hist, *hist.median_mad())


def _threshold(hist: Hist, med: float, mad: float) -> float:
    return max(hist.quantile(CFAR_Q), med + CFAR_K * MAD_SCALE * mad, float(CFAR_FLOOR))


@dataclass(frozen=True, slots=True)
class Level:
    threshold: float
    ready: bool
    med: float
    spread: float


@dataclass(frozen=True, slots=True)
class Basis:
    ready: dict[Direction, Level]
    waiting: dict[Direction, tuple[float, float]]
    pooled: tuple[tuple[Direction, Hist], ...]


def basis(directions: tuple[Direction, ...], model: Model, fixed: float | None = None) -> Basis:
    ready: dict[Direction, Level] = {}
    waiting: dict[Direction, tuple[float, float]] = {}
    pooled = []
    for d in directions:
        hist = model.hist.get(d, Hist())
        med, mad = hist.median_mad()
        spread = max(MAD_SCALE * mad, 1.0)
        warm = hist.observed >= REF_MIN_SAMPLES
        if fixed is not None:
            ready[d] = Level(fixed, True, med, spread)
        elif warm:
            ready[d] = Level(_threshold(hist, med, mad), True, med, spread)
        else:
            waiting[d] = (med, spread)
        if warm:
            pooled.append((d, hist))
    return Basis(ready, waiting, tuple(sorted(pooled, key=itemgetter(0))))


class Cfar:
    def __init__(self, directions: tuple[Direction, ...], fixed: float | None = None) -> None:
        self._directions = directions
        self.fixed = fixed
        self.levels: dict[Direction, Level] = {}
        self._basis = basis(directions, Model(), fixed)
        self._classes: tuple[int, ...] | None = None
        self._pools: dict[int, float] = {}

    def load(self, ready: Basis) -> None:
        self._basis = ready
        self._classes = None

    def refresh(self, signal: Callable[[Direction], int | None]) -> None:
        waiting = self._basis.waiting
        pools = self._pooled(signal) if waiting else {}
        out = dict(self._basis.ready)
        for d, (med, spread) in waiting.items():
            c = signal_class(signal(d))
            out[d] = Level(pools.get(c, float(START_THRESHOLDS[c])), False, med, spread)
        self.levels = {d: out[d] for d in self._directions}

    def _pooled(self, signal: Callable[[Direction], int | None]) -> dict[int, float]:
        classes = tuple(signal_class(signal(d)) for d, _ in self._basis.pooled)
        if classes != self._classes:
            pools: dict[int, Hist] = {}
            for c, (_, hist) in zip(classes, self._basis.pooled, strict=True):
                pools[c] = pools[c].merged(hist) if c in pools else hist
            self._pools = {c: threshold_of(pool) for c, pool in pools.items() if pool.observed >= REF_MIN_SAMPLES}
            self._classes = classes
        return self._pools

    def state(self, d: Direction, sample: DirSample, was_exceed: bool) -> tuple[DirectionState, float | None]:
        if sample.level is None:
            return ("quiet_censored" if sample.censored else "none"), None
        level = self.levels[d]
        z = round((sample.level - level.med) / level.spread, 2)
        limit = level.threshold * HYST_OFF if was_exceed else level.threshold
        exceed = sample.level >= limit if was_exceed else sample.level > limit
        return ("exceed" if exceed else "quiet"), z
