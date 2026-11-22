import random
from collections.abc import Callable

import pytest

from engine import cfar as cfar_module
from engine.cfar import Cfar, Level, basis, signal_class, threshold_of
from engine.defaults import CFAR_FLOOR, CFAR_K, CFAR_Q, MAD_SCALE, REF_MIN_SAMPLES, START_THRESHOLDS
from engine.ingest import DirSample
from engine.model import Hist, Model
from engine.topology import Direction
from tests.engine.helpers import B1, B2, B3, B4
from tests.engine.test_model import _reference_median_mad

DIRS = ((B1, B2), (B2, B1), (B1, B3))


def _hist(levels: list[int]) -> Hist:
    h = Hist()
    for level in levels:
        h.add(level, 1.0)
    return h


def test_signal_classes() -> None:
    assert [signal_class(s) for s in (None, -60, -70, -75, -80, -90)] == [1, 0, 0, 1, 1, 2]


def test_threshold_is_the_largest_of_three_terms() -> None:
    assert threshold_of(Hist()) == 6.0
    assert threshold_of(_hist([10] * 300)) == 11.0
    assert threshold_of(_hist([2, 4, 6, 8] * 100)) > 9


def test_ready_pooled_start_and_fixed() -> None:
    model = Model()
    model.hist[(B1, B2)] = _hist([10] * 300)
    model.hist[(B2, B1)] = _hist([10] * 10)
    signals = {(B1, B2): -60, (B2, B1): -65, (B1, B3): -90}
    cfar = Cfar(DIRS)
    cfar.load(basis(DIRS, model))
    cfar.refresh(signals.get)
    assert cfar.levels[(B1, B2)].ready
    assert cfar.levels[(B1, B2)].threshold == 11.0
    assert not cfar.levels[(B2, B1)].ready
    assert cfar.levels[(B2, B1)].threshold == 11.0
    assert cfar.levels[(B1, B3)].threshold == 32.0
    fixed = Cfar(DIRS, fixed=15.0)
    fixed.load(basis(DIRS, model, fixed.fixed))
    fixed.refresh(signals.get)
    assert {lv.threshold for lv in fixed.levels.values()} == {15.0}


def test_state_with_hysteresis() -> None:
    cfar = Cfar(DIRS)
    cfar.refresh(lambda d: -60)
    assert cfar.state((B1, B2), DirSample(None, True, ()), False) == ("quiet_censored", None)
    assert cfar.state((B1, B2), DirSample(None, False, ()), False) == ("none", None)
    assert cfar.state((B1, B2), DirSample(21, False, ()), False)[0] == "exceed"
    assert cfar.state((B1, B2), DirSample(20, False, ()), False)[0] == "quiet"
    assert cfar.state((B1, B2), DirSample(16, False, ()), True)[0] == "exceed"
    state, z = cfar.state((B1, B2), DirSample(15, False, ()), True)
    assert state == "quiet"
    assert z == 15.0


def _reference(model: Model, signal: Callable[[Direction], int | None], directions: tuple[Direction, ...]) -> object:
    ready = {d for d in directions if d in model.hist and model.hist[d].observed >= REF_MIN_SAMPLES}
    pools: dict[int, Hist] = {}
    for d in sorted(ready):
        c = signal_class(signal(d))
        pools[c] = pools[c].merged(model.hist[d]) if c in pools else model.hist[d]
    out = {}
    for d in directions:
        hist = model.hist.get(d, Hist())
        med, mad = _reference_median_mad(hist)
        spread = max(MAD_SCALE * mad, 1.0)
        if d in ready:
            out[d] = Level(_reference_threshold(hist), True, med, spread)
        else:
            c = signal_class(signal(d))
            pool = pools.get(c)
            usable = pool is not None and pool.observed >= REF_MIN_SAMPLES
            start = float(START_THRESHOLDS[c])
            out[d] = Level(_reference_threshold(pool) if pool is not None and usable else start, False, med, spread)
    return out


def _reference_threshold(hist: Hist) -> float:
    med, mad = _reference_median_mad(hist)
    return max(hist.quantile(CFAR_Q), med + CFAR_K * MAD_SCALE * mad, float(CFAR_FLOOR))


def _random_model(rng: random.Random, directions: tuple[Direction, ...]) -> Model:
    model = Model()
    for d in directions[:-1]:
        h = Hist()
        for _ in range(rng.choice((0, 5, 150, 300))):
            h.add(rng.choice((2, 4, 4, 10, 12, 40)), rng.choice((1.0, 0.3, 0.2)))
        model.hist[d] = h
    return model


def test_refreshes_match_the_full_recomputation() -> None:
    rng = random.Random(3)
    directions = tuple((a, b) for a in (B1, B2, B3, B4) for b in (B1, B2, B3, B4) if a != b)
    for _ in range(40):
        model = _random_model(rng, directions)
        cfar = Cfar(directions)
        cfar.load(basis(directions, model))
        for _ in range(3):
            signals = {d: rng.choice((None, -60, -72, -85)) for d in directions}
            cfar.refresh(signals.get)
            assert cfar.levels == _reference(model, signals.get, directions)


def test_a_refresh_reuses_the_loaded_statistics_and_pools(monkeypatch: pytest.MonkeyPatch) -> None:
    model = Model()
    model.hist[(B1, B2)] = _hist([10] * 300)
    model.hist[(B2, B1)] = _hist([4] * 300)
    cfar = Cfar(DIRS)
    cfar.load(basis(DIRS, model))
    empty = basis(DIRS, Model())
    pooled: list[Hist] = []

    def counted(hist: Hist) -> float:
        pooled.append(hist)
        return 30.0

    monkeypatch.setattr(Hist, "median_mad", _never)
    monkeypatch.setattr(cfar_module, "threshold_of", counted)
    signals = {(B1, B2): -60, (B2, B1): -65, (B1, B3): -60}
    cfar.refresh(signals.get)
    cfar.refresh({**signals, (B1, B2): -62}.get)
    assert len(pooled) == 1
    assert cfar.levels[(B1, B3)].threshold == 30.0
    cfar.refresh({**signals, (B1, B2): -90}.get)
    assert len(pooled) == 3
    cfar.load(empty)
    cfar.refresh({**signals, (B1, B2): -90}.get)
    assert len(pooled) == 3
    assert cfar.levels[(B1, B3)].threshold == 20.0


def _never(_hist: Hist) -> tuple[float, float]:
    raise AssertionError("statistics were computed again")
