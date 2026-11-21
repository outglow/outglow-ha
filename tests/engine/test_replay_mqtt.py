import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar

import pytest

from engine import from_json
from engine.types import Context, Header, LightEvent, LightState, LinkReading, Observation, Plan
from tools import import_prototype, replay_mqtt, synth

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "recordings"
FLAT3 = synth.TEMPLATES["flat3"]
NAMES = {
    "0x0000000000000001": "Living 1",
    "0x0000000000000002": "Living 2",
    "0x0000000000000003": "Hall 1",
    "0x0000000000000004": "Office 1",
}


def _replay(cache_state: bool = True) -> replay_mqtt.Replay:
    return replay_mqtt.Replay("z2m", NAMES, cache_state=cache_state)


def test_names_follow_rooms_and_extras() -> None:
    assert replay_mqtt.default_names(FLAT3) == NAMES
    extra = replay_mqtt.default_names(FLAT3, ["0x0000000000000009", "0x0000000000000001"])
    assert extra["0x0000000000000009"] == "Bulb 1"
    assert replay_mqtt.default_names(None, ["0x0000000000000002"]) == {"0x0000000000000002": "Bulb 1"}
    assert replay_mqtt.short_room_name("") == "Bulb"
    lines = [
        '{"type":"header"}',
        "not json",
        '{"type":"bulb","ieee":"0x00000000000000AB","name":"Desk"}',
        '{"type":"bulb","ieee":"0x0000000000000003","name":"0x0000000000000003"}',
    ]
    assert replay_mqtt.recorded_names(lines) == {"0x00000000000000ab": "Desk"}


def test_startup_publishes_the_bridge_like_z2m() -> None:
    messages = _replay().startup()
    by_topic = {m.topic: m for m in messages}
    assert by_topic["z2m/bridge/state"].payload == {"state": "online"}
    assert all(by_topic[t].retain for t in ("z2m/bridge/state", "z2m/bridge/info", "z2m/bridge/devices"))
    info = by_topic["z2m/bridge/info"].payload
    assert info["config"]["advanced"]["output"] == "json"
    assert info["config"]["devices"]["0x0000000000000001"] == {"friendly_name": "Living 1", "motion_activity_rate": 2.0}
    devices = by_topic["z2m/bridge/devices"].payload
    assert devices[0]["type"] == "Coordinator"
    bulb = devices[1]
    assert (bulb["ieee_address"], bulb["friendly_name"], bulb["type"]) == ("0x0000000000000001", "Living 1", "Router")
    assert bulb["model_id"] == bulb["definition"]["model"] == "outglow-dimm"
    assert any(e.get("property") == "motion_links" for e in bulb["definition"]["exposes"])
    assert by_topic["z2m/Office 1/availability"].payload == {"state": "online"}
    assert by_topic["z2m/Hall 1"].payload["motion_sensing"] == "ON"
    assert json.loads(by_topic["z2m/bridge/state"].text()) == {"state": "online"}
    assert replay_mqtt.bridge_info(NAMES, None)["config"]["devices"]["0x0000000000000002"] == {
        "friendly_name": "Living 2"
    }
    assert _replay().shutdown()[0].payload == {"state": "offline"}


def test_observation_matches_the_converter_shape() -> None:
    replay = _replay()
    obs = Observation(
        t=1.0,
        rx="0x0000000000000001",
        links=(
            LinkReading(
                tx="0x0000000000000003",
                level=30,
                motion=True,
                signal_dbm=-70,
                noise_db=0.5,
                sensitivity=40,
                calibrated_sensitivity=38,
                raw_activity=31,
            ),
            LinkReading(tx="0x0000000000000002", window_sum=4),
            LinkReading(tx="0x0000000000000004", level=7),
        ),
        occupancy=True,
        light=LightState(on=False, brightness=50, color_temp=300),
        source="activity",
    )
    [message] = replay.messages(obs)
    assert message.topic == "z2m/Living 1"
    payload = message.payload
    assert (payload["state"], payload["brightness"], payload["color_temp"], payload["occupancy"]) == (
        "OFF",
        50,
        300,
        True,
    )
    links = payload["motion_links"]
    assert [link["ieee_address"] for link in links] == [
        "0x0000000000000002",
        "0x0000000000000003",
        "0x0000000000000004",
    ]
    assert [link["activity"] for link in links] == [4, 31, 7]
    hall = links[1]
    assert hall == {
        "address": "0x1002",
        "ieee_address": "0x0000000000000003",
        "model": "outglow-dimm",
        "signal": -70,
        "noise": 0.5,
        "activity": 31,
        "motion": True,
        "slot": 0,
        "sensitivity": 40,
        "calibrated_sensitivity": 38,
    }
    assert replay.messages(Observation(t=2.0, rx="0x00000000000000ee")) == []
    [plain] = replay.messages(Observation(t=2.0, rx="0x0000000000000002", light=LightState(on=True)))
    assert plain.payload["state"] == "ON"
    assert "color_temp" not in plain.payload


def test_cache_state_and_light_events() -> None:
    cached = _replay()
    cached.messages(Observation(t=1.0, rx="0x0000000000000001", links=(LinkReading(tx="0x0000000000000002"),)))
    [light] = cached.messages(LightEvent(t=2.0, ieee="0x0000000000000001", on=False))
    assert light.payload["state"] == "OFF"
    assert len(light.payload["motion_links"]) == 1
    bare = _replay(cache_state=False)
    [only] = bare.messages(LightEvent(t=2.0, ieee="0x0000000000000001", on=True))
    assert only.payload == {"state": "ON"}
    assert bare.messages(LightEvent(t=2.0, ieee="0x0000000000000001")) == []
    assert bare.messages(Header()) == []


def test_context_toggles_availability() -> None:
    replay = _replay()
    down = replay.messages(Context(t=1.0, offline=frozenset({"0x0000000000000002", "0x00000000000000ee"})))
    assert [(m.topic, m.payload, m.retain) for m in down] == [("z2m/Living 2/availability", {"state": "offline"}, True)]
    assert replay.messages(Context(t=2.0, offline=frozenset({"0x0000000000000002"}))) == []
    up = replay.messages(Context(t=3.0))
    assert [m.payload for m in up] == [{"state": "online"}]


def test_schedule_and_timed() -> None:
    records = replay_mqtt.timed(synth.simulate("flat3", 1, 10, 2.0, False))
    assert records
    assert all(isinstance(r, Observation) for r in records)
    assert [r.t for r in records] == sorted(r.t for r in records)
    due = list(replay_mqtt.schedule(records, synth.START, 10.0, 2.0))
    assert due[0][0] == pytest.approx((10.0 + records[0].t - synth.START) / 2.0)
    assert replay_mqtt.ieees_of([*records, LightEvent(t=1, ieee="0x00000000000000aa"), Header()]) >= {
        "0x0000000000000001",
        "0x00000000000000aa",
    }
    assert replay_mqtt.ieees_of([Context(t=1, offline=frozenset({"0x00000000000000bb"}))]) == {"0x00000000000000bb"}


def test_plan_outputs_round_trip() -> None:
    plan = Plan(
        rooms=FLAT3.rooms,
        adjacent=FLAT3.adjacent,
        bulbs=(
            *FLAT3.bulbs[:3],
            FLAT3.bulbs[3].__class__(ieee="0x0000000000000004", x=3.25, y=5, room="office", height="lamp"),
        ),
    )
    data = import_prototype.load_yaml(replay_mqtt.plan_yaml(plan, NAMES))
    assert isinstance(data, dict)
    assert list(data["rooms"]) == ["living", "hall", "office"]
    assert data["rooms"]["hall"]["entrance"] is True
    assert data["rooms"]["living"]["outline"][2] == [5, 4]
    assert data["adjacent"] == [["living", "hall"], ["hall", "office"]]
    assert data["bulbs"][0] == {"z2m": "Living 1", "at": [1.5, 1.5]}
    assert data["bulbs"][3] == {"z2m": "Office 1", "at": [3.25, 5], "room": "office", "height": "lamp"}
    assert from_json(Plan, json.loads(replay_mqtt.plan_json(FLAT3))) == FLAT3


def test_main_writes_plan_files(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    plan, yaml = tmp_path / "plan.json", tmp_path / "plan.yaml"
    assert replay_mqtt.main(["--plan-only", "--print-plan", str(plan), "--print-yaml", str(yaml)]) == 0
    assert from_json(Plan, json.loads(plan.read_text())) == FLAT3
    assert 'z2m: "Hall 1"' in yaml.read_text()
    assert replay_mqtt.main(["--plan-only", "--template", "studio", "--print-yaml", "-"]) == 0
    assert 'z2m: "Room 1"' in capsys.readouterr().out
    names = tmp_path / "names.json"
    names.write_text(json.dumps({"0x0000000000000001": "Sofa"}))
    assert (
        replay_mqtt.main([str(FIXTURES / "flat3_v2.jsonl"), "--plan-only", "--print-yaml", "-", "--names", str(names)])
        == 0
    )
    assert 'z2m: "Sofa"' in capsys.readouterr().out
    assert replay_mqtt.main([str(FIXTURES / "small_v1.jsonl"), "--plan-only", "--print-plan", "-"]) == 1
    assert replay_mqtt.main(["--speed", "0"]) == 2


class FakeInfo:
    def wait_for_publish(self, timeout: float) -> None:
        pass


class FakeClient:
    instances: ClassVar[list[FakeClient]] = []

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.published: list[tuple[str, str, bool]] = []
        self.will: tuple[str, str, bool] | None = None
        self.refuse = False
        FakeClient.instances.append(self)

    def will_set(self, topic: str, payload: str, retain: bool = False) -> None:
        self.will = (topic, payload, retain)

    def connect(self, host: str, port: int) -> None:
        if port == 1:
            raise ConnectionRefusedError("refused")

    def loop_start(self) -> None:
        pass

    def loop_stop(self) -> None:
        pass

    def disconnect(self) -> None:
        pass

    def publish(self, topic: str, payload: str, retain: bool = False) -> FakeInfo:
        self.published.append((topic, payload, retain))
        return FakeInfo()


def test_publish_with_a_fake_broker(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    fake = SimpleNamespace(Client=FakeClient, CallbackAPIVersion=SimpleNamespace(VERSION2=2))
    monkeypatch.setattr(replay_mqtt, "load_mqtt", lambda: fake)
    monkeypatch.setattr(replay_mqtt, "sleep", lambda s: None)
    assert replay_mqtt.main(["--duration", "6", "--speed", "1000", "--base", "zb"]) == 0
    client = FakeClient.instances[-1]
    topics = [t for t, _, _ in client.published]
    assert topics[0] == "zb/bridge/state"
    assert topics[-1] == "zb/bridge/state"
    assert client.will == ("zb/bridge/state", '{"state":"offline"}', True)
    links = [json.loads(p) for t, p, _ in client.published if t == "zb/Hall 1" and "motion_links" in p]
    assert links
    assert "pass 1" in capsys.readouterr().err
    assert replay_mqtt.main([str(FIXTURES / "flat3_v2.jsonl"), "--speed", "1000", "--quiet"]) == 0
    assert any(t == "zb/Living 1" or t == "zigbee2mqtt/Living 1" for t, _, _ in FakeClient.instances[-1].published)
    assert replay_mqtt.main(["--port", "1"]) == 1
    assert "cannot connect" in capsys.readouterr().err


def test_loop_stops_on_interrupt(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = SimpleNamespace(Client=FakeClient, CallbackAPIVersion=SimpleNamespace(VERSION2=2))
    monkeypatch.setattr(replay_mqtt, "load_mqtt", lambda: fake)
    calls: list[float] = []

    def sleep(seconds: float) -> None:
        calls.append(seconds)
        if len(calls) > 3:
            raise KeyboardInterrupt

    monkeypatch.setattr(replay_mqtt, "sleep", sleep)
    args = ["--loop", "--template", "studio", "--duration", "2", "--speed", "0.001", "--quiet", "--no-cache-state"]
    assert replay_mqtt.main(args) == 0
    assert FakeClient.instances[-1].published[-1][1] == '{"state":"offline"}'
