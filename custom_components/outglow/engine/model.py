import math
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from itertools import accumulate

from .defaults import (
    DECAY_STEP_S,
    HIST_BINS,
    HIST_WIDTH,
    LEARN_HALF_LIFE_D,
    MODEL_FORMAT,
    REF_HALF_LIFE_D,
)
from .topology import Direction, Pair
from .types import Json

Counts = list[float]


@dataclass(slots=True)
class Hist:
    bins: list[float] = field(default_factory=lambda: [0.0] * HIST_BINS)
    censored: float = 0.0

    @property
    def observed(self) -> float:
        return sum(self.bins)

    def add(self, level: int, weight: float) -> None:
        self.bins[min(HIST_BINS - 1, max(0, level) // HIST_WIDTH)] += weight

    def scale(self, factor: float) -> None:
        self.bins = [b * factor for b in self.bins]
        self.censored *= factor

    def merged(self, other: Hist) -> Hist:
        return Hist([a + b for a, b in zip(self.bins, other.bins, strict=True)], self.censored + other.censored)

    def quantile(self, q: float) -> float:
        target = q * (self.observed + self.censored) * (1 - 1e-12)
        cumulative = accumulate(self.bins, initial=self.censored)
        index = next((i for i, acc in enumerate(cumulative) if acc >= target), HIST_BINS)
        return 0.0 if index == 0 else float((index - 1) * HIST_WIDTH + HIST_WIDTH - 1)

    def median_mad(self) -> tuple[float, float]:
        total = self.observed
        if total <= 0:
            return 0.0, 0.0
        half = total / 2
        middle = _reaching(range(HIST_BINS), self.bins, half)
        med = _centre(middle)
        return med, abs(_centre(_reaching(_outward(middle, self.bins), self.bins, half)) - med)

    def to_json(self) -> Json:
        return {"bins": [round(b, 6) for b in self.bins], "censored": round(self.censored, 6)}


def _centre(index: int) -> float:
    return index * HIST_WIDTH + HIST_WIDTH / 2


def _outward(middle: int, bins: list[float]) -> Iterator[int]:
    yield middle
    for step in range(1, HIST_BINS):
        yield from sorted((i for i in (middle - step, middle + step) if 0 <= i < HIST_BINS), key=bins.__getitem__)


def _reaching(order: Iterable[int], bins: list[float], half: float) -> int:
    acc = 0.0
    index = 0
    for index in order:
        acc += bins[index]
        if acc >= half:
            return index
    return index


@dataclass(slots=True)
class RoomCal:
    a_on: float
    false_per_day: float | None = None
    detection: float | None = None


@dataclass(slots=True)
class Model:
    version: int = 0
    updated: float | None = None
    hist: dict[Direction, Hist] = field(default_factory=dict)
    bg_ticks: float = 0.0
    bg_onsets: dict[Direction, float] = field(default_factory=dict)
    pair_bg: dict[Pair, Counts] = field(default_factory=dict)
    emit: dict[tuple[Pair, str], Counts] = field(default_factory=dict)
    rooms: dict[str, RoomCal] = field(default_factory=dict)
    labels: dict[str, int] = field(default_factory=dict)
    empty_s: float = 0.0
    decay_t: float | None = None
    entries: dict[str, list[float]] = field(default_factory=dict)

    def clone(self) -> Model:
        return Model(
            version=self.version,
            updated=self.updated,
            hist={d: Hist(h.bins[:], h.censored) for d, h in self.hist.items()},
            bg_ticks=self.bg_ticks,
            bg_onsets=dict(self.bg_onsets),
            pair_bg={p: v[:] for p, v in self.pair_bg.items()},
            emit={k: v[:] for k, v in self.emit.items()},
            rooms={r: RoomCal(c.a_on, c.false_per_day, c.detection) for r, c in self.rooms.items()},
            labels=dict(self.labels),
            empty_s=self.empty_s,
            decay_t=self.decay_t,
            entries={r: v[:] for r, v in self.entries.items()},
        )

    def hist_of(self, d: Direction) -> Hist:
        return self.hist.setdefault(d, Hist())

    def decay(self, t: float) -> None:
        if self.decay_t is None:
            self.decay_t = t
            return
        dt = t - self.decay_t
        if dt < DECAY_STEP_S:
            return
        ref = 0.5 ** (dt / (REF_HALF_LIFE_D * 86400))
        learn = 0.5 ** (dt / (LEARN_HALF_LIFE_D * 86400))
        for h in self.hist.values():
            h.scale(ref)
        self.bg_ticks *= ref
        self.empty_s *= ref
        self.bg_onsets = {d: v * ref for d, v in self.bg_onsets.items()}
        self.pair_bg = {p: [c * ref for c in v] for p, v in self.pair_bg.items()}
        self.emit = {k: [c * learn for c in v] for k, v in self.emit.items()}
        self.decay_t = t


def _dkey(d: Direction) -> str:
    return f"{d[0]}>{d[1]}"


def _pkey(p: Pair) -> str:
    return f"{p[0]}|{p[1]}"


def _split(key: str, sep: str) -> tuple[str, str]:
    a, b = key.split(sep, 1)
    return a, b


def _round(values: Counts) -> list[Json]:
    return [round(v, 6) for v in values]


def to_json(model: Model) -> dict[str, Json]:
    return {
        "format": MODEL_FORMAT,
        "model_version": model.version,
        "updated": model.updated,
        "hist": {_dkey(d): h.to_json() for d, h in sorted(model.hist.items())},
        "bg_ticks": round(model.bg_ticks, 6),
        "bg_onsets": {_dkey(d): round(v, 6) for d, v in sorted(model.bg_onsets.items())},
        "pair_bg": {_pkey(p): _round(v) for p, v in sorted(model.pair_bg.items())},
        "emit": {f"{_pkey(p)}|{r}": _round(v) for (p, r), v in sorted(model.emit.items())},
        "rooms": {
            r: {"a_on": c.a_on, "false_per_day": c.false_per_day, "detection": c.detection}
            for r, c in sorted(model.rooms.items())
        },
        "labels": dict(sorted(model.labels.items())),
        "empty_s": round(model.empty_s, 3),
        "decay_t": model.decay_t,
        "entries": {r: [round(v, 4) for v in vs] for r, vs in sorted(model.entries.items())},
    }


def _obj(data: Mapping[str, Json], key: str) -> Mapping[str, Json]:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def _num(value: Json, default: float = 0.0) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else default


def _opt(value: Json) -> float | None:
    return None if value is None else _num(value)


def _counts(value: Json, n: int = 3) -> Counts:
    items = value if isinstance(value, list) else []
    out = [_num(v) for v in items[:n]]
    return out + [0.0] * (n - len(out))


def _hist(value: Json) -> Hist:
    data = value if isinstance(value, dict) else {}
    bins = data.get("bins")
    return Hist(bins=_counts(bins, HIST_BINS), censored=_num(data.get("censored")))


def from_json(data: Mapping[str, Json] | None) -> Model:
    raw: Mapping[str, Json] = data or {}
    version = raw.get("model_version")
    rooms = {}
    for r, c in _obj(raw, "rooms").items():
        cal = c if isinstance(c, dict) else {}
        rooms[r] = RoomCal(a_on=_num(cal.get("a_on"), math.nan), false_per_day=_opt(cal.get("false_per_day")))
        rooms[r].detection = _opt(cal.get("detection"))
    emit = {}
    for key, v in _obj(raw, "emit").items():
        a, rest = _split(key, "|")
        b, room = _split(rest, "|")
        emit[((a, b), room)] = _counts(v)
    labels = {k: int(_num(v)) for k, v in _obj(raw, "labels").items()}
    return Model(
        version=version if isinstance(version, int) and not isinstance(version, bool) else 0,
        updated=_opt(raw.get("updated")),
        hist={_split(k, ">"): _hist(v) for k, v in _obj(raw, "hist").items()},
        bg_ticks=_num(raw.get("bg_ticks")),
        bg_onsets={_split(k, ">"): _num(v) for k, v in _obj(raw, "bg_onsets").items()},
        pair_bg={_split(k, "|"): _counts(v) for k, v in _obj(raw, "pair_bg").items()},
        emit=emit,
        rooms={r: c for r, c in rooms.items() if not math.isnan(c.a_on)},
        labels=labels,
        empty_s=_num(raw.get("empty_s")),
        decay_t=_opt(raw.get("decay_t")),
        entries={r: [_num(x) for x in v] for r, v in _obj(raw, "entries").items() if isinstance(v, list)},
    )
