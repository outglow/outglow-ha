from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass

from homeassistant.const import STATE_HOME, STATE_NOT_HOME, STATE_OFF, STATE_ON
from homeassistant.core import CALLBACK_TYPE, Context, Event, EventStateChangedData, HomeAssistant, callback
from homeassistant.helpers.event import async_track_state_change_event

from .engine.defaults import EMPTY_MARGIN_S, EMPTY_MIN_S
from .engine.types import HouseEmpty, LightEvent, LightOrigin


@dataclass(frozen=True, slots=True)
class EmptyInterval:
    t0: float
    t1: float
    soft: bool


def light_origin(context: Context | None, ours: frozenset[str]) -> LightOrigin:
    if context is None:
        return "unknown"
    if context.id in ours or (context.parent_id is not None and context.parent_id in ours):
        return "ours"
    if context.user_id is not None:
        return "user"
    if context.parent_id is not None:
        return "unknown"
    return "remote"


class HouseState:
    def __init__(self, min_s: float = EMPTY_MIN_S, margin_s: float = EMPTY_MARGIN_S) -> None:
        self._min_s = min_s
        self._margin_s = margin_s
        self.away_since: float | None = None
        self.persons_home: frozenset[str] = frozenset()
        self._all_known = False

    def update(self, t: float, states: Mapping[str, str | None], soft: bool) -> list[EmptyInterval]:
        self.persons_home = frozenset(p for p, s in states.items() if s == STATE_HOME)
        known = [s for s in states.values() if s is not None]
        self._all_known = bool(states) and len(known) == len(states)
        all_away = self._all_known and all(s == STATE_NOT_HOME for s in states.values())
        closed: list[EmptyInterval] = []
        if all_away:
            if self.away_since is None:
                self.away_since = t
        elif self.away_since is not None:
            interval = self._interval(self.away_since, t, soft)
            if interval is not None:
                closed.append(interval)
            self.away_since = None
        return closed

    def _interval(self, start: float, end: float, soft: bool) -> EmptyInterval | None:
        if end - start < self._min_s:
            return None
        t0, t1 = start + self._margin_s, end - self._margin_s
        return EmptyInterval(t0, t1, soft) if t1 > t0 else None

    def open_interval(self, t: float, soft: bool) -> EmptyInterval | None:
        return self._interval(self.away_since, t, soft) if self.away_since is not None else None

    def empty(self, t: float, soft: bool) -> HouseEmpty:
        if self.away_since is not None and t - self.away_since >= self._min_s:
            return "soft" if soft else "yes"
        if self.persons_home:
            return "no"
        return "unknown"


class ContextTracker:
    def __init__(
        self,
        hass: HomeAssistant,
        on_light: Callable[[LightEvent, str], None],
        on_persons: Callable[[], None],
        clock: Callable[[], float],
    ) -> None:
        self._hass = hass
        self._on_light = on_light
        self._on_persons = on_persons
        self._clock = clock
        self._lights: dict[str, str] = {}
        self._persons: tuple[str, ...] = ()
        self._unsub_lights: CALLBACK_TYPE | None = None
        self._unsub_persons: CALLBACK_TYPE | None = None
        self.ours: set[str] = set()

    @callback
    def track_lights(self, lights: Mapping[str, str]) -> None:
        if dict(lights) == self._lights:
            return
        self._lights = dict(lights)
        if self._unsub_lights is not None:
            self._unsub_lights()
            self._unsub_lights = None
        if self._lights:
            self._unsub_lights = async_track_state_change_event(self._hass, list(self._lights), self._light_changed)

    @callback
    def track_persons(self, persons: Iterable[str]) -> None:
        wanted = tuple(sorted(persons))
        if wanted == self._persons and (self._unsub_persons is not None or not wanted):
            return
        self._persons = wanted
        if self._unsub_persons is not None:
            self._unsub_persons()
            self._unsub_persons = None
        if wanted:
            self._unsub_persons = async_track_state_change_event(self._hass, list(wanted), self._person_changed)

    def person_states(self) -> dict[str, str | None]:
        out: dict[str, str | None] = {}
        for entity_id in self._persons:
            state = self._hass.states.get(entity_id)
            out[entity_id] = state.state if state is not None and state.state in (STATE_HOME, STATE_NOT_HOME) else None
        return out

    @callback
    def stop(self) -> None:
        for unsub in (self._unsub_lights, self._unsub_persons):
            if unsub is not None:
                unsub()
        self._unsub_lights = None
        self._unsub_persons = None

    @callback
    def _light_changed(self, event: Event[EventStateChangedData]) -> None:
        new = event.data["new_state"]
        old = event.data["old_state"]
        ieee = self._lights.get(event.data["entity_id"])
        if new is None or old is None or ieee is None or not self._hass.is_running:
            return
        if new.state not in (STATE_ON, STATE_OFF) or old.state not in (STATE_ON, STATE_OFF) or old.state == new.state:
            return
        origin = light_origin(new.context, frozenset(self.ours))
        self._on_light(LightEvent(t=self._clock(), ieee=ieee, origin=origin, on=new.state == STATE_ON), ieee)

    @callback
    def _person_changed(self, event: Event[EventStateChangedData]) -> None:
        self._on_persons()
