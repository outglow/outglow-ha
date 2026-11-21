from collections.abc import Callable
from dataclasses import dataclass

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
    med, mad = hist.median_mad()
    return max(hist.quantile(CFAR_Q), med + CFAR_K * MAD_SCALE * mad, float(CFAR_FLOOR))


@dataclass(frozen=True, slots=True)
class Level:
    threshold: float
    ready: bool
    med: float
    spread: float


class Cfar:
    def __init__(self, directions: tuple[Direction, ...], fixed: float | None = None) -> None:
        self._directions = directions
        self._fixed = fixed
        self.levels: dict[Direction, Level] = {}

    def refresh(self, model: Model, signal: Callable[[Direction], int | None]) -> None:
        ready = {d for d in self._directions if d in model.hist and model.hist[d].observed >= REF_MIN_SAMPLES}
        pools: dict[int, Hist] = {}
        for d in sorted(ready):
            c = signal_class(signal(d))
            pools[c] = pools[c].merged(model.hist[d]) if c in pools else model.hist[d]
        out = {}
        for d in self._directions:
            hist = model.hist.get(d, Hist())
            med, mad = hist.median_mad()
            spread = max(MAD_SCALE * mad, 1.0)
            if self._fixed is not None:
                out[d] = Level(self._fixed, True, med, spread)
            elif d in ready:
                out[d] = Level(threshold_of(hist), True, med, spread)
            else:
                c = signal_class(signal(d))
                pool = pools.get(c)
                usable = pool is not None and pool.observed >= REF_MIN_SAMPLES
                start = float(START_THRESHOLDS[c])
                out[d] = Level(threshold_of(pool) if pool is not None and usable else start, False, med, spread)
        self.levels = out

    def state(self, d: Direction, sample: DirSample, was_exceed: bool) -> tuple[DirectionState, float | None]:
        if sample.level is None:
            return ("quiet_censored" if sample.censored else "none"), None
        level = self.levels[d]
        z = round((sample.level - level.med) / level.spread, 2)
        limit = level.threshold * HYST_OFF if was_exceed else level.threshold
        exceed = sample.level >= limit if was_exceed else sample.level > limit
        return ("exceed" if exceed else "quiet"), z
