from engine.source import SourceClassifier, classify, with_source
from tests.engine.helpers import B1, B2, obs


def _o(t: float, level: int, rx: str = B1) -> object:
    return obs(t, rx, {B2: level}, source="unknown")


def test_with_source_moves_raw_values() -> None:
    o = obs(1.0, B1, {B2: 7}, source="unknown")
    assert with_source(o, "activity").links[0].level == 7
    assert with_source(o, "lines").links[0].window_sum == 7
    assert with_source(o, "unknown").links[0].level is None


def test_periodic_changes_are_activity_and_repeats_unknown() -> None:
    c = SourceClassifier()
    assert c.push(obs(0.0, B1, {B2: 1}, source="unknown")) == []
    first = c.push(obs(0.5, B1, {B2: 9}, source="unknown"))
    assert [(o.t, o.source) for o in first] == [(0.0, "activity"), (0.5, "activity")]
    repeat = c.push(obs(0.6, B1, {B2: 9}, source="unknown"))
    assert [o.source for o in repeat] == ["unknown"]
    second = c.push(obs(1.0, B1, {B2: 4}, source="unknown"))
    assert [(o.t, o.source) for o in second] == [(1.0, "activity")]
    assert c.flush() == []


def test_bursts_and_lonely_messages_are_unknown() -> None:
    c = SourceClassifier()
    c.push(obs(0.0, B1, {B2: 1}, source="unknown"))
    burst = c.push(obs(0.05, B1, {B2: 2}, source="unknown"))
    assert [(o.t, o.source) for o in burst] == [(0.0, "unknown")]
    late = c.push(obs(5.0, B2, {B1: 3}, source="unknown"))
    assert [(o.t, o.source) for o in late] == [(0.05, "unknown")]
    assert c.expire(5.5) == []
    assert [(o.t, o.source) for o in c.expire(7.0)] == [(5.0, "unknown")]


def test_classify_sorts_by_time() -> None:
    items = [obs(t, B1, {B2: i}, source="unknown") for i, t in enumerate((0.0, 0.5, 1.0, 9.0))]
    out = list(classify(items))
    assert [o.t for o in out] == [0.0, 0.5, 1.0, 9.0]
    assert [o.source for o in out] == ["activity", "activity", "activity", "unknown"]
