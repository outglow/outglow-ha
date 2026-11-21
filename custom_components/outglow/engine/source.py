from collections.abc import Iterable, Iterator
from dataclasses import replace

from .defaults import STREAM_GAP_MAX_S, STREAM_GAP_MIN_S
from .types import Observation, Source


def _values(obs: Observation) -> tuple[tuple[str, int | None], ...]:
    return tuple((link.tx, link.raw_activity) for link in obs.links)


def with_source(obs: Observation, source: Source) -> Observation:
    links = tuple(
        replace(
            link,
            level=link.raw_activity if source == "activity" else None,
            window_sum=link.raw_activity if source == "lines" else link.window_sum,
        )
        for link in obs.links
    )
    return replace(obs, source=source, links=links)


class SourceClassifier:
    def __init__(self, gap_min: float = STREAM_GAP_MIN_S, gap_max: float = STREAM_GAP_MAX_S) -> None:
        self._gap_min = gap_min
        self._gap_max = gap_max
        self._values: dict[str, tuple[tuple[str, int | None], ...]] = {}
        self._last_change: dict[str, float] = {}
        self._held: dict[str, Observation] = {}

    def push(self, obs: Observation) -> list[Observation]:
        out = self.expire(obs.t)
        values = _values(obs)
        changed = self._values.get(obs.rx) != values
        self._values[obs.rx] = values
        if not changed:
            out.append(with_source(obs, "unknown"))
            return out
        last = self._last_change.get(obs.rx)
        self._last_change[obs.rx] = obs.t
        stream = last is not None and self._gap_min <= obs.t - last <= self._gap_max
        held = self._held.pop(obs.rx, None)
        if held is not None:
            out.append(with_source(held, "activity" if stream else "unknown"))
        if stream:
            out.append(with_source(obs, "activity"))
        else:
            self._held[obs.rx] = obs
        return out

    def flush(self) -> list[Observation]:
        out = [with_source(held, "unknown") for held in self._held.values()]
        self._held.clear()
        return sorted(out, key=lambda o: o.t)

    def expire(self, t: float) -> list[Observation]:
        done = [rx for rx, held in self._held.items() if t - held.t > self._gap_max]
        return [with_source(self._held.pop(rx), "unknown") for rx in done]


def classify(observations: Iterable[Observation]) -> Iterator[Observation]:
    classifier = SourceClassifier()
    out = [o for obs in observations for o in classifier.push(obs)]
    yield from sorted([*out, *classifier.flush()], key=lambda o: o.t)
