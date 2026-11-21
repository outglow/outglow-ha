import math

from engine.model import Hist, Model, RoomCal, from_json, to_json
from tests.engine.helpers import B1, B2


def test_hist_quantiles_and_robust_spread() -> None:
    h = Hist()
    assert h.quantile(0.99) == 0.0
    assert h.median_mad() == (0.0, 0.0)
    for level in (2, 4, 4, 6, 300):
        h.add(level, 1.0)
    h.add(-3, 1.0)
    assert h.observed == 6
    assert h.quantile(0.5) == 5.0
    assert h.quantile(1.0) == 255.0
    med, mad = h.median_mad()
    assert med == 5.0
    assert mad == 2.0
    h.censored = 100.0
    assert h.quantile(0.9) == 0.0
    both = h.merged(h)
    assert both.observed == 12
    both.scale(0.5)
    assert both.censored == 100.0


def test_decay_halves_after_a_half_life() -> None:
    m = Model()
    m.decay(0.0)
    m.hist_of((B1, B2)).add(4, 8.0)
    m.bg_ticks = 8.0
    m.bg_onsets[(B1, B2)] = 8.0
    m.pair_bg[(B1, B2)] = [8.0, 0.0, 0.0]
    m.emit[((B1, B2), "hall")] = [8.0, 8.0, 0.0]
    m.decay(10.0)
    assert m.bg_ticks == 8.0
    m.decay(7 * 86400.0)
    assert math.isclose(m.bg_ticks, 4.0)
    assert math.isclose(m.hist[(B1, B2)].observed, 4.0)
    assert math.isclose(m.emit[((B1, B2), "hall")][0], 8 * 0.5 ** (7 / 30))


def test_json_round_trip_and_lenient_input() -> None:
    m = Model(version=3, updated=5.0, labels={"wizard": 4}, empty_s=12.5, decay_t=1.0)
    m.hist_of((B1, B2)).add(10, 2.0)
    m.bg_onsets[(B1, B2)] = 1.0
    m.pair_bg[(B1, B2)] = [1.0, 2.0, 3.0]
    m.emit[((B1, B2), "hall")] = [1.0, 0.0, 0.5]
    m.rooms["hall"] = RoomCal(a_on=0.8, false_per_day=0.5, detection=0.9)
    m.entries["hall"] = [0.5]
    data = to_json(m)
    assert to_json(from_json(data)) == data
    assert to_json(m.copy()) == data
    weird = from_json(
        {
            "model_version": True,
            "rooms": {"x": {"a_on": "high"}, "y": 3, "z": {"a_on": 0.7, "false_per_day": None}},
            "hist": {f"{B1}>{B2}": {"bins": [1, "x"]}, f"{B2}>{B1}": 4},
            "pair_bg": {f"{B1}|{B2}": "bad"},
            "labels": {"wizard": 2.0},
            "entries": {"hall": "x"},
            "emit": [],
        }
    )
    assert weird.version == 0
    assert set(weird.rooms) == {"z"}
    assert weird.hist[(B1, B2)].bins[:2] == [1.0, 0.0]
    assert weird.hist[(B2, B1)].observed == 0
    assert weird.pair_bg[(B1, B2)] == [0.0, 0.0, 0.0]
    assert weird.labels == {"wizard": 2}
    assert weird.entries == {}
    assert from_json(None).version == 0
