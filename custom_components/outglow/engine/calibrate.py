from collections import deque
from collections.abc import Iterable, Sequence

from .defaults import A_OFF, A_ON_MAX, A_ON_MIN, A_ON_STEP, CALIBRATION_MIN_H


class Peaks:
    def __init__(self, n_on: int) -> None:
        self._window: deque[float] = deque(maxlen=n_on)
        self._best: float | None = None
        self._found: list[float] = []

    def push(self, p: float) -> None:
        if p < A_OFF:
            if self._best is not None:
                self._found.append(self._best)
            self._window.clear()
            self._best = None
            return
        self._window.append(p)
        if len(self._window) == self._window.maxlen:
            low = min(self._window)
            self._best = low if self._best is None else max(self._best, low)
        elif self._best is None:
            self._best = -1.0

    def result(self) -> list[float]:
        out = [*self._found, *([] if self._best is None else [self._best])]
        return [b for b in out if b >= 0]


def peaks(series: Iterable[float], n_on: int) -> list[float]:
    tracker = Peaks(n_on)
    for p in series:
        tracker.push(p)
    return tracker.result()


def grid() -> list[float]:
    steps = round((A_ON_MAX - A_ON_MIN) / A_ON_STEP)
    return [round(A_ON_MIN + i * A_ON_STEP, 4) for i in range(steps + 1)]


def onsets(room_peaks: Sequence[float], a_on: float) -> int:
    return sum(p >= a_on for p in room_peaks)


def choose(room_peaks: Sequence[float], hours: float, budget: float, current: float) -> tuple[float, float | None]:
    if hours < CALIBRATION_MIN_H:
        return current, None
    days = hours / 24
    for a in grid():
        rate = onsets(room_peaks, a) / days
        if rate <= budget:
            return a, rate
    top = grid()[-1]
    return top, onsets(room_peaks, top) / days


def detection(entries: Sequence[float], a_on: float) -> float | None:
    return sum(e >= a_on for e in entries) / len(entries) if entries else None
