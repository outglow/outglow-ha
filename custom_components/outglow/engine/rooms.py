import math
from dataclasses import dataclass, replace

from .defaults import (
    A_OFF,
    EXTRA_ROOM_PRIOR,
    N_ON,
    NEIGH_WINDOW_S,
    P_ENTER_BASE,
    P_ENTER_ENTRANCE,
    P_ENTER_NEIGHBOUR,
    P_STAY,
)
from .emission import State
from .topology import Topology
from .types import HouseEmpty, Reaction


@dataclass(slots=True)
class RoomState:
    p: float = 0.0
    motion: bool = False
    run: int = 0
    last_motion: float = -math.inf
    since: float | None = None


def posterior(
    prior: list[float], loglik: list[float], states: tuple[State, ...], rooms: tuple[str, ...]
) -> dict[str, float]:
    logs = [math.log(max(p, 1e-300)) + ll for p, ll in zip(prior, loglik, strict=True)]
    top = max(logs)
    weights = [math.exp(x - top) for x in logs]
    total = sum(weights)
    return {r: sum(w for w, s in zip(weights, states, strict=True) if r in s) / total for r in rooms}


def state_prior(q: dict[str, float], states: tuple[State, ...]) -> list[float]:
    out = []
    for s in states:
        value = 1.0
        for room, qr in q.items():
            value *= qr if room in s else 1 - qr
        out.append(value * EXTRA_ROOM_PRIOR ** max(0, len(s) - 1))
    total = sum(out)
    return [v / total for v in out]


class Rooms:
    def __init__(self, topo: Topology, reaction: dict[str, Reaction], a_on: dict[str, float]) -> None:
        self._topo = topo
        self.reaction = reaction
        self.a_on = a_on
        self.state = {r: RoomState() for r in topo.rooms}
        self._empty_override = False

    def inherit(self, old: Rooms) -> None:
        self.state.update({r: replace(s) for r, s in old.state.items() if r in self.state})
        self._empty_override = old._empty_override

    def enter(self, room: str, t: float) -> float:
        if any(t - self.state[n].last_motion <= NEIGH_WINDOW_S for n in self._topo.neighbours[room]):
            return P_ENTER_NEIGHBOUR
        return P_ENTER_ENTRANCE if room in self._topo.entrances else P_ENTER_BASE

    def predict(self, t: float) -> dict[str, float]:
        return {r: P_STAY[self.reaction[r]] * s.p + self.enter(r, t) * (1 - s.p) for r, s in self.state.items()}

    def decide(
        self, t: float, p: dict[str, float], house_empty: HouseEmpty, hold: dict[str, int], immediate: bool
    ) -> None:
        if house_empty != "yes":
            self._empty_override = False
        override = self._empty_override
        for room, s in self.state.items():
            s.p = p[room]
            blocked = house_empty == "yes" and not override and room not in self._topo.entrances
            s.run = s.run + 1 if s.p >= self.a_on[room] and not blocked else 0
            if blocked or s.p < A_OFF:
                s.motion = False
            elif s.run >= (1 if immediate else N_ON[self.reaction[room]]):
                if not s.motion and room in self._topo.entrances and house_empty == "yes":
                    self._empty_override = True
                s.motion = True
            if s.motion:
                if t - s.last_motion >= hold[room]:
                    s.since = t
                s.last_motion = t
            elif t - s.last_motion >= hold[room]:
                s.since = None

    def occupied(self, room: str, t: float, hold: int) -> bool:
        s = self.state[room]
        return s.motion or t - s.last_motion < hold
