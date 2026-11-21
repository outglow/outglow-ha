from engine.cfar import Cfar, signal_class, threshold_of
from engine.ingest import DirSample
from engine.model import Hist, Model
from tests.engine.helpers import B1, B2, B3

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
    cfar.refresh(model, signals.get)
    assert cfar.levels[(B1, B2)].ready
    assert cfar.levels[(B1, B2)].threshold == 11.0
    assert not cfar.levels[(B2, B1)].ready
    assert cfar.levels[(B2, B1)].threshold == 11.0
    assert cfar.levels[(B1, B3)].threshold == 32.0
    fixed = Cfar(DIRS, fixed=15.0)
    fixed.refresh(model, signals.get)
    assert {lv.threshold for lv in fixed.levels.values()} == {15.0}


def test_state_with_hysteresis() -> None:
    cfar = Cfar(DIRS)
    cfar.refresh(Model(), lambda d: -60)
    assert cfar.state((B1, B2), DirSample(None, True, ()), False) == ("quiet_censored", None)
    assert cfar.state((B1, B2), DirSample(None, False, ()), False) == ("none", None)
    assert cfar.state((B1, B2), DirSample(21, False, ()), False)[0] == "exceed"
    assert cfar.state((B1, B2), DirSample(20, False, ()), False)[0] == "quiet"
    assert cfar.state((B1, B2), DirSample(16, False, ()), True)[0] == "exceed"
    state, z = cfar.state((B1, B2), DirSample(15, False, ()), True)
    assert state == "quiet"
    assert z == 15.0
