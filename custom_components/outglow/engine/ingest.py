import math
from dataclasses import dataclass, replace

from .defaults import (
    BLANK_LIGHT_S,
    DEFAULT_ACTIVITY_RATE,
    FROZEN_REPORTS,
    GATE_GAP_S,
    HOLD_LEVEL_S,
    INTERVAL_MAX_S,
    WEAK_SIGNAL_DBM,
)
from .topology import Direction, Topology
from .types import DirectionFlag, Gate, LightState, Observation


@dataclass(slots=True)
class _Dir:
    level: int | None = None
    level_t: float = -math.inf
    tick_max: int | None = None
    signal: int | None = None
    run: int = 0
    others_changed: bool = False
    frozen: bool = False
    motion: bool = False
    heard: bool = False


@dataclass(frozen=True, slots=True)
class DirSample:
    level: int | None
    censored: bool
    flags: tuple[DirectionFlag, ...]


@dataclass(slots=True)
class _Rx:
    last_activity: float | None = None
    interval: float = 1 / DEFAULT_ACTIVITY_RATE
    occupancy: bool = False
    light: LightState | None = None


class Ingest:
    def __init__(self, topo: Topology) -> None:
        self._topo = topo
        self._dirs = {d: _Dir() for d in topo.directions}
        self._rx = {b: _Rx() for b in topo.bulbs}
        self._light_t: dict[str, float] = {}
        self._offline: frozenset[str] = frozenset()
        self.messages = 0

    def inherit(self, old: Ingest) -> None:
        self._dirs.update({d: replace(s) for d, s in old._dirs.items() if d in self._dirs})
        self._rx.update({b: replace(s) for b, s in old._rx.items() if b in self._rx})
        self._light_t = dict(old._light_t)
        self._offline = old._offline
        self.messages = old.messages

    def set_offline(self, offline: frozenset[str]) -> None:
        self._offline = offline

    def light(self, ieee: str, t: float) -> None:
        self._light_t[ieee] = max(t, self._light_t.get(ieee, t))

    def observe(self, obs: Observation) -> None:
        rx = self._rx.get(obs.rx)
        if rx is None:
            return
        self.messages += 1
        if obs.occupancy is not None:
            rx.occupancy = obs.occupancy
        if obs.light is not None:
            if rx.light is not None and rx.light != obs.light:
                self.light(obs.rx, obs.t)
            rx.light = obs.light
        links = [(self._dirs.get((obs.rx, link.tx)), link) for link in obs.links]
        known = [(d, link) for d, link in links if d is not None]
        for d, link in known:
            d.motion = link.motion
            if link.signal_dbm is not None and link.signal_dbm < 0:
                d.signal = link.signal_dbm
            d.heard = d.heard or link.motion or d.signal is not None
        if obs.source != "activity":
            return
        if rx.last_activity is not None and 0 < obs.t - rx.last_activity <= INTERVAL_MAX_S:
            rx.interval = 0.8 * rx.interval + 0.2 * (obs.t - rx.last_activity)
        rx.last_activity = obs.t if rx.last_activity is None else max(rx.last_activity, obs.t)
        levelled = [(d, link.level) for d, link in known if link.level is not None]
        changed = {id(d) for d, level in levelled if level != d.level}
        for d, level in levelled:
            if id(d) in changed:
                d.run, d.others_changed, d.frozen = 0, False, False
            else:
                d.run += 1
                d.others_changed = d.others_changed or len(changed) > 0
                d.frozen = d.run >= FROZEN_REPORTS and d.others_changed and level > 0
            d.level, d.level_t = level, obs.t
            d.tick_max = level if d.tick_max is None else max(d.tick_max, level)

    def gate(self, rx: str, t: float) -> Gate:
        if rx in self._offline:
            return "offline"
        state = self._rx[rx]
        if state.last_activity is not None and t - state.last_activity <= GATE_GAP_S + state.interval:
            return "open"
        return "closed"

    def gates(self, t: float) -> dict[str, Gate]:
        return {b: self.gate(b, t) for b in self._topo.bulbs}

    def signal(self, d: Direction) -> int | None:
        return self._dirs[d].signal

    def weak(self, d: Direction) -> bool:
        signal = self._dirs[d].signal
        return signal is not None and signal <= WEAK_SIGNAL_DBM

    def frozen(self, d: Direction) -> bool:
        return self._dirs[d].frozen

    def motion(self, d: Direction) -> bool:
        return d[0] not in self._offline and self._dirs[d].motion

    def delivering(self, d: Direction) -> bool:
        return d[0] not in self._offline and d[1] not in self._offline and self._dirs[d].heard

    def occupancy(self, rx: str) -> bool:
        return rx not in self._offline and self._rx[rx].occupancy

    def tick(self, t: float, gates: dict[str, Gate]) -> dict[Direction, DirSample]:
        out = {}
        for d in self._topo.directions:
            state = self._dirs[d]
            out[d] = self._sample(d, state, t, gates)
            state.tick_max = None
        return out

    def _sample(self, d: Direction, state: _Dir, t: float, gates: dict[str, Gate]) -> DirSample:
        flags: list[DirectionFlag] = ["weak"] if self.weak(d) else []
        rx, tx = d
        if d in self._topo.excluded:
            return DirSample(None, False, (*flags, "excluded"))
        if gates[rx] == "offline":
            return DirSample(None, False, tuple(flags))
        if t - max(self._light_t.get(rx, -math.inf), self._light_t.get(tx, -math.inf)) < BLANK_LIGHT_S:
            return DirSample(None, False, (*flags, "blanked"))
        if gates[rx] == "closed":
            return DirSample(None, True, tuple(flags))
        if state.frozen:
            return DirSample(None, False, (*flags, "frozen"))
        if state.tick_max is not None:
            return DirSample(state.tick_max, False, tuple(flags))
        if state.level is not None and t - state.level_t <= HOLD_LEVEL_S:
            return DirSample(state.level, False, tuple(flags))
        return DirSample(None, False, tuple(flags))
