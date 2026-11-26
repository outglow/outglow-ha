from collections import deque
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass, replace
from itertools import islice
from operator import itemgetter
from typing import Any

from .defaults import DETECT_WINDOW_S, ENTRIES_MAX, LABEL_BUFFER_S, LABEL_TRIM_S, STILL_WEIGHT
from .model import Model
from .topology import Topology
from .types import HouseEmpty, Label

NONE = 255
CENSORED = 254
QUIET, EXCEED, NO_DATA, CENS = 0, 1, 2, 3
_PAD_NONE = bytes([NONE])
_PAD_NO_DATA = bytes([NO_DATA])


@dataclass(frozen=True, slots=True)
class TickRecord:
    t: float
    levels: bytes
    states: bytes
    codes: bytes
    p: tuple[float, ...]
    empty: HouseEmpty
    taught: float = 0.0
    paired: float = 0.0


class Learner:
    def __init__(self, topo: Topology, tick_s: float) -> None:
        self._topo = topo
        self.buffer: deque[TickRecord] = deque(maxlen=_buffer_len(tick_s))
        self._tick_s = tick_s
        self.recorded = 0
        self._reach = {
            r: frozenset(i for i, pair in enumerate(topo.pairs) if topo.explainers(pair) & (topo.neighbours[r] | {r}))
            for r in topo.rooms
        }

    def retime(self, tick_s: float) -> None:
        self.buffer = deque(self.buffer, maxlen=_buffer_len(tick_s))
        self._tick_s = tick_s

    def adopt(self, topo: Topology, records: Iterable[TickRecord]) -> None:
        self.buffer.extend(self._remap(topo, records))

    def inherit(self, old: Learner, seen: int | None = None) -> None:
        fresh = len(old.buffer) if seen is None else min(len(old.buffer), old.recorded - seen)
        self.adopt(old._topo, islice(old.buffer, len(old.buffer) - fresh, None))

    def _remap(self, topo: Topology, records: Iterable[TickRecord]) -> Iterable[TickRecord]:
        if (topo.directions, topo.pairs, topo.rooms) == (self._topo.directions, self._topo.pairs, self._topo.rooms):
            return records
        dirs = _picker(topo.directions, self._topo.directions)
        pairs = _picker(topo.pairs, self._topo.pairs)
        rooms = _picker(topo.rooms, self._topo.rooms)
        return (
            TickRecord(
                t=rec.t,
                levels=bytes(dirs(rec.levels + _PAD_NONE)),
                states=bytes(dirs(rec.states + _PAD_NO_DATA)),
                codes=bytes(pairs(rec.codes + _PAD_NONE)),
                p=rooms((*rec.p, 0.0)),
                empty=rec.empty,
                taught=rec.taught,
                paired=rec.paired,
            )
            for rec in records
        )

    def copy(self) -> Learner:
        twin = Learner.__new__(Learner)
        twin._topo, twin._tick_s, twin._reach = self._topo, self._tick_s, self._reach
        twin.buffer = deque(self.buffer, maxlen=self.buffer.maxlen)
        twin.recorded = self.recorded
        return twin

    def record(self, rec: TickRecord) -> None:
        self.buffer.append(rec)
        self.recorded += 1

    def window(self, t0: float, t1: float) -> Iterator[TickRecord]:
        return (r for r in self.buffer if t0 <= r.t <= t1)

    def empty_tick(self, model: Model, seq: int, weight: float) -> None:
        index = len(self.buffer) - (self.recorded - seq)
        if index >= 1 and self._teach(model, index, self.buffer[index - 1], weight, weight == 1.0):
            model.labels["empty_house"] = model.labels.get("empty_house", 0) + 1

    def _teach(self, model: Model, index: int, prev: TickRecord | None, weight: float, pairs: bool) -> bool:
        rec = self.buffer[index]
        extra = max(0.0, weight - rec.taught)
        paired = max(0.0, weight - rec.paired) if pairs else 0.0
        if not extra and not paired:
            return False
        model.decay(rec.t)
        if extra:
            self.background(model, rec, prev, extra)
        if paired:
            self._pair_counts(model, rec, paired, None)
        self.buffer[index] = replace(rec, taught=rec.taught + extra, paired=rec.paired + paired)
        return True

    def background(self, model: Model, rec: TickRecord, prev: TickRecord | None, weight: float) -> None:
        model.decay(rec.t)
        for i, d in enumerate(self._topo.directions):
            level = rec.levels[i]
            if level == CENSORED:
                model.hist_of(d).censored += weight
            elif level != NONE:
                model.hist_of(d).add(level, weight)
            if rec.states[i] == EXCEED and (prev is None or prev.states[i] != EXCEED):
                model.bg_onsets[d] = model.bg_onsets.get(d, 0.0) + weight
        model.bg_ticks += weight
        model.empty_s += weight * self._tick_s

    def _pair_counts(
        self, model: Model, rec: TickRecord, weight: float, room: str | None, skip: frozenset[int] = frozenset()
    ) -> bool:
        if weight <= 0:
            return False
        taught = False
        for i, pair in enumerate(self._topo.pairs):
            code = rec.codes[i]
            if code == NONE or i in skip:
                continue
            taught = True
            o = 0 if code == 3 else 1 if code == 4 else code
            counts = (
                model.pair_bg.setdefault(pair, [0.0, 0.0, 0.0])
                if room is None
                else model.emit.setdefault((pair, room), [0.0, 0.0, 0.0])
            )
            counts[o] += weight
        return taught

    def label(self, model: Model, label: Label) -> int:
        t0, t1 = label.t0 + LABEL_TRIM_S, label.t1 - LABEL_TRIM_S
        records = list(self.window(t0, t1))
        rooms = self._topo.rooms
        unknown = label.room is not None and label.room not in rooms
        if not records or label.kind == "transition" or unknown or (label.kind == "room" and label.room is None):
            return 0
        count = len(records)
        if label.kind == "empty" and label.room is None:
            indices = [i for i, rec in enumerate(self.buffer) if t0 <= rec.t <= t1]
            count = sum(
                self._teach(model, i, self.buffer[i - 1] if i > indices[0] else None, label.weight, True)
                for i in indices
            )
        elif label.kind == "empty" or label.activity == "still":
            assert label.room is not None
            still = label.kind == "room"
            weight = label.weight * (STILL_WEIGHT if still else 1.0)
            skip = self._reach[label.room] if still else frozenset()
            count = 0
            for rec in records:
                model.decay(rec.t)
                count += self._pair_counts(model, rec, weight * _elsewhere(rooms, rec, label.room), None, skip)
        elif label.source == "manual_light":
            assert label.room is not None
            count = 0
            for rec in records:
                model.decay(rec.t)
                count += self._pair_counts(model, rec, label.weight * _elsewhere(rooms, rec, label.room), label.room)
        else:
            assert label.room is not None
            index = rooms.index(label.room)
            for rec in records:
                model.decay(rec.t)
                self._pair_counts(model, rec, label.weight, label.room)
            first = [rec.p[index] for rec in self.window(label.t0, label.t0 + DETECT_WINDOW_S)]
            entries = model.entries.setdefault(label.room, [])
            entries.append(max(first, default=0.0))
            del entries[:-ENTRIES_MAX]
        if count:
            model.labels[label.source] = model.labels.get(label.source, 0) + count
        return count


def _elsewhere(rooms: Sequence[str], rec: TickRecord, room: str) -> float:
    return 1 - max((p for r, p in zip(rooms, rec.p, strict=True) if r != room), default=0.0)


def _picker[K](old: Sequence[K], new: Sequence[K]) -> Callable[[Sequence[Any]], tuple[Any, ...]]:
    if not new:
        return lambda _values: ()
    index = {key: i for i, key in enumerate(old)}
    missing = len(old)
    get = itemgetter(*(index.get(key, missing) for key in new), missing)
    return lambda values: get(values)[:-1]


def _buffer_len(tick_s: float) -> int:
    return max(1, round(LABEL_BUFFER_S / tick_s))
