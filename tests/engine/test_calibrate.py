from engine import calibrate as cal


def test_peaks_per_run() -> None:
    series = [0.0, 0.95, 0.97, 0.2, 0.5, 0.0, 0.92, 0.6, 0.99, 0.98]
    assert cal.peaks(series, 2) == [0.95, 0.98]
    assert cal.peaks(series, 1) == [0.97, 0.5, 0.99]
    assert cal.peaks([0.9, 0.1], 3) == []


def test_choose_the_smallest_threshold_within_budget() -> None:
    peaks = [0.6, 0.7, 0.96, 0.99]
    assert cal.grid()[0] == 0.5
    assert cal.grid()[-1] == 0.995
    assert cal.onsets(peaks, 0.7) == 3
    assert cal.choose(peaks, 1.0, 1.0, 0.9) == (0.9, None)
    a_on, rate = cal.choose(peaks, 48.0, 1.0, 0.9)
    assert a_on == 0.705
    assert rate == 1.0
    assert cal.choose([0.999] * 5, 24.0, 0.1, 0.9) == (0.995, 5.0)
    assert cal.detection([0.5, 0.95], 0.9) == 0.5
    assert cal.detection([], 0.9) is None
