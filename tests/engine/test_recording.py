import json
from pathlib import Path

import pytest

from engine import recording
from engine.recording import RecordingError
from engine.types import (
    Context,
    Frame,
    Header,
    Label,
    LightEvent,
    LightState,
    LinkReading,
    Observation,
    Plan,
    Record,
    RoomFrame,
    Settings,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "recordings"
A, B, C = (f"0x{n:016x}" for n in (1, 2, 3))


def test_v1_fixture() -> None:
    records = list(recording.read((FIXTURES / "small_v1.jsonl").read_text().splitlines()))
    assert records[0] == Header(format=1)
    observations = [r for r in records if isinstance(r, Observation)]
    assert [o.rx for o in observations] == [A, B, C, A]
    assert observations[0].links[0] == LinkReading(tx=B, motion=True, signal_dbm=-61, noise_db=1.0, raw_activity=31)
    assert observations[0].source == "unknown"
    assert observations[0].occupancy is True
    assert len(observations[1].links) == 1
    labels = [r for r in records if isinstance(r, Label)]
    assert [(lb.t0 - 1.8e9, lb.t1 - 1.8e9, lb.kind, lb.room, lb.activity) for lb in labels] == [
        (2.0, 6.0, "room", "living", "walk"),
        (6.0, 9.0, "room", "hall", "still"),
        (9.0, 12.0, "empty", None, "any"),
        (13.0, 15.0, "room", "living", "still"),
    ]
    assert {lb.source for lb in labels} == {"recording"}


def test_v1_unknown_kind_with_room_is_any_and_without_room_is_ignored() -> None:
    lines = [
        '{"t": 1, "type": "layout", "layout": "broken"}',
        '{"t": 2, "type": "truth", "kind": "lie", "room": "hall"}',
        '{"t": 3, "type": "truth", "kind": "walk"}',
        '{"t": 3, "type": "truth", "kind": "walk", "room": "hall"}',
        '{"t": 3, "type": "bulb", "name": "x", "links": null}',
    ]
    labels = [r for r in recording.read(lines) if isinstance(r, Label)]
    assert [(lb.t0, lb.t1, lb.activity) for lb in labels] == [(2.0, 3.0, "any")]


def test_v1_layout_skips_bad_bulbs() -> None:
    lines = [
        json.dumps({"t": 1, "type": "layout", "layout": {"bulbs": [{"z2m": "a"}, "x", {"z2m": "b", "ieee": A}]}}),
        json.dumps({"t": 2, "type": "bulb", "name": "b", "links": [{"ieee_address": B, "activity": 3.6}, 5]}),
    ]
    obs = [r for r in recording.read(lines) if isinstance(r, Observation)]
    assert obs == [Observation(t=2.0, rx=A, links=(LinkReading(tx=B, raw_activity=4),))]


def test_v1_needs_time() -> None:
    with pytest.raises(RecordingError, match="line 1: no time"):
        list(recording.read(['{"type": "bulb"}']))


def _v2_records() -> list[Record]:
    link = LinkReading(
        tx=B,
        level=31,
        motion=True,
        signal_dbm=-61,
        noise_db=1.2,
        sensitivity=40,
        calibrated_sensitivity=38,
        raw_activity=31,
    )
    return [
        Header(plan=Plan(), settings=Settings(), created=1.0, generator="test"),
        Observation(
            t=1.0, rx=A, links=(link,), occupancy=True, light=LightState(on=True, brightness=10), source="activity"
        ),
        Observation(t=1.5, rx=A, links=(LinkReading(tx=B, window_sum=7, raw_activity=7),), source="lines"),
        LightEvent(t=2.0, ieee=A, origin="user", on=False),
        Context(t=3.0, persons_home=frozenset({"person.x"}), house_empty="no", offline=frozenset({C})),
        Label(t0=1.0, t1=4.0, kind="room", room="hall", activity="walk", source="wizard", weight=1.0),
        Frame(t=4.5, rooms={"hall": RoomFrame(p=0.5)}),
    ]


def test_v2_round_trip() -> None:
    records = _v2_records()
    lines = list(recording.write(records, {A: "Bulb/A"}))
    assert '"name":"Bulb/A"' in lines[1]
    assert list(recording.read(lines)) == records


def test_v2_writes_level_when_raw_is_missing() -> None:
    obs = [
        Observation(t=1.0, rx=A, links=(LinkReading(tx=B, level=9),), source="activity"),
        Observation(t=1.0, rx=A, links=(LinkReading(tx=B, window_sum=4),), source="lines"),
    ]
    back = list(recording.read(recording.write([Header(), *obs])))[1:]
    assert [o.links[0].raw_activity for o in back if isinstance(o, Observation)] == [9, 4]


def test_v2_fixture_reads() -> None:
    records = list(recording.read((FIXTURES / "flat3_v2.jsonl").read_text().splitlines()))
    header = records[0]
    assert isinstance(header, Header)
    assert header.plan is not None
    assert [r.id for r in header.plan.rooms] == ["living", "hall", "office"]
    assert any(isinstance(r, Observation) for r in records)
    assert any(isinstance(r, Label) for r in records)


def test_empty_input_and_blank_lines_and_unknown_types() -> None:
    assert list(recording.read([])) == []
    lines = ['{"type": "header", "format": 2}', "", '{"t": 1, "type": "future"}']
    assert list(recording.read(lines)) == [Header()]


@pytest.mark.parametrize(
    ("lines", "message"),
    [
        (["nope"], "line 1: not JSON"),
        (["[1]"], "line 1: not an object"),
        (['{"type": "header", "format": 3}'], "unsupported format 3"),
        (['{"type": "header", "format": 2, "plan": {"rev": "x"}}'], "line 1: "),
        (['{"type": "header", "format": 2}', '{"t": 1, "type": "bulb"}'], "line 2: "),
        (['{"type": "header", "format": 2}', '{"t": 1, "type": "bulb", "source": []}'], "line 2: "),
        (['{"type": "header", "format": 2}', '{"t": 1, "type": "bulb", "source": "x", "ieee": "a"}'], "line 2: "),
        (
            ['{"type": "header", "format": 2}', '{"type": "bulb", "source": "lines", "ieee": "a", "links": []}'],
            "no time",
        ),
        (
            ['{"type": "header", "format": 2}', '{"t": 1, "type": "bulb", "source": "lines", "ieee": "a", "links": 1}'],
            "links",
        ),
        (['{"type": "header", "format": 2}', '{"t": 1, "type": "light"}'], "line 2: "),
    ],
)
def test_errors(lines: list[str], message: str) -> None:
    with pytest.raises(RecordingError, match=message):
        list(recording.read(lines))


def test_v1_names_can_come_from_the_plan() -> None:
    lines = [json.dumps({"t": 2, "type": "bulb", "name": "Hall", "links": [{"ieee_address": B, "activity": 3}]})]
    assert list(recording.read(lines)) == [Header(format=1)]
    obs = [r for r in recording.read(lines, {"Hall": A}) if isinstance(r, Observation)]
    assert [o.rx for o in obs] == [A]
