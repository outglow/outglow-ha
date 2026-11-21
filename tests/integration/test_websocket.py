import asyncio
import base64
import json
import threading
import zlib
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_mqtt_message
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker
from pytest_homeassistant_custom_component.typing import MqttMockHAClient, WebSocketGenerator

from custom_components.outglow import plan_import, valetudo_fetch
from custom_components.outglow import session as session_module
from custom_components.outglow import websocket as websocket_module
from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine import Engine, to_json
from custom_components.outglow.engine.learn import TickRecord
from custom_components.outglow.engine.types import Frame, Label, Observation, PairFrame, RoomFrame
from custom_components.outglow.errors import OutglowError
from custom_components.outglow.store import PLAN_KEY, SNAPSHOTS_KEY
from tests.contract import commands, validate, ws_fixture
from tests.integration.common import (
    BULBS,
    Clock,
    bridge,
    bulb_state,
    fire,
    pending_labels,
    plan_json,
    setup_outglow,
    with_plan,
)

MIESZKANIE = """
scale_m_per_plan_px: 0.02
rooms:
  living:
    name: Living room
    outline: [[0, 0], [5, 0], [5, 4], [0, 4]]
  hall:
    name: Hall
    outline: [[5, 0], [7, 0], [7, 6], [5, 6]]
    colour: "#f28b30"
adjacent:
- [living, hall]
- [living, attic]
bulbs:
- id: one
  z2m: Test/Living 1
  room: living
  at: [1.5, 1.5]
- id: two
  ieee: '0x0000000000000003'
  at: [6.0, 3.0]
- id: lost
  ieee: '0x0000000000000099'
  room: attic
  at: [20.0, 20.0]
"""


class Client:
    def __init__(self, ws: Any) -> None:
        self.ws = ws

    async def call(self, command: str, **fields: Any) -> dict[str, Any]:
        await self.ws.send_json_auto_id({"type": command, **fields})
        reply: dict[str, Any] = await self.ws.receive_json()
        return reply

    async def ok(self, command: str, **fields: Any) -> Any:
        reply = await self.call(command, **fields)
        assert reply["success"], reply
        validate(commands()[command]["response"], reply["result"])
        return reply["result"]

    async def error(self, command: str, code: str, **fields: Any) -> dict[str, Any]:
        reply = await self.call(command, **fields)
        assert not reply["success"], reply
        assert reply["error"]["code"] == code, reply
        validate("error.json", reply["error"])
        return reply


@pytest.fixture
async def ready(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_ws_client: WebSocketGenerator, clock: Clock
) -> tuple[OutglowCoordinator, Client]:
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    await with_plan(hass, coordinator)
    for ieee in BULBS:
        fire(hass, BULBS[ieee], bulb_state(ieee))
    await hass.async_block_till_done()
    return coordinator, Client(await hass_ws_client(hass))


async def test_read_commands_match_schemas(ready: tuple[OutglowCoordinator, Client]) -> None:
    coordinator, client = ready
    coordinator.tick()
    info = await client.ok("outglow/info")
    assert info["capabilities"]["z2m_version"] == "2.9.1"
    bulbs = (await client.ok("outglow/bulbs"))["bulbs"]
    assert [b["ieee"] for b in bulbs] == sorted(BULBS)
    first = bulbs[0]
    assert first["name"] == "Test/Living 1"
    assert first["sensing"] is True
    assert first["activity_rate"] == 2
    assert first["sensitivity"] == 40
    assert len(first["lines"]) == 3
    got = await client.ok("outglow/plan/get")
    assert got["rev"] == 1
    assert [room["id"] for room in got["plan"]["rooms"]] == ["living", "hall", "office"]
    settings = await client.ok("outglow/settings/get")
    assert set(settings["rooms"]) == {"living", "hall", "office"}
    assert settings["global"]["use_persons"] is False
    await client.ok("outglow/model/get")
    await client.ok("outglow/model/snapshots")
    assert (await client.ok("outglow/session/get"))["session"] is None
    report = await client.ok("outglow/quality", days=7)
    assert report["days"] == 7
    assert (await client.ok("outglow/plan/background/get"))["image"] is None


async def test_plan_save_conflict_and_validation(ready: tuple[OutglowCoordinator, Client]) -> None:
    coordinator, client = ready
    plan = plan_json(1)
    assert (await client.ok("outglow/plan/save", rev=1, plan=plan))["rev"] == 2
    await client.error("outglow/plan/save", "rev_conflict", rev=1, plan=plan)
    broken = {**plan, "bulbs": [{**plan["bulbs"][0], "ieee": "0xNOPE"}]}
    await client.error("outglow/plan/save", "invalid_format", rev=2, plan=broken)
    await client.error("outglow/plan/save", "invalid_format", rev=2, plan={**plan, "rooms": "x"})
    await client.error("outglow/plan/save", "invalid_format", rev=2, plan={**plan, "retired_rooms": ["hall"]})
    assert coordinator.plan.rev == 2


@pytest.mark.parametrize(("bulbs", "rooms"), [(1, 3), (0, 3), (4, 0)])
async def test_a_plan_shrunk_to_one_bulb_or_no_rooms_saves(
    ready: tuple[OutglowCoordinator, Client], clock: Clock, bulbs: int, rooms: int
) -> None:
    coordinator, client = ready
    for _ in range(4):
        clock.advance(0.5)
        coordinator.tick()
    buffered = len(coordinator.engine._learner.buffer)
    plan = plan_json(1)
    kept = [room["id"] for room in plan["rooms"][:rooms]]
    small = {
        **plan,
        "rooms": plan["rooms"][:rooms],
        "adjacent": [pair for pair in plan["adjacent"] if set(pair) <= set(kept)],
        "bulbs": plan["bulbs"][:bulbs],
    }
    assert (await client.ok("outglow/plan/save", rev=1, plan=small))["rev"] == 2
    assert len(coordinator.engine.topology.rooms) == rooms
    assert len(coordinator.engine._learner.buffer) == buffered + 1
    assert (await client.ok("outglow/plan/save", rev=2, plan={**small, "bulbs": plan["bulbs"]}))["rev"] == 3


async def test_a_plan_the_engine_cannot_take_is_not_saved(
    ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    engine, stored = coordinator.engine, hass_storage[PLAN_KEY]["data"]

    def broken(*_args: Any) -> Any:
        raise TypeError("cannot remap")

    monkeypatch.setattr(Engine, "successor", broken)
    plan = {**plan_json(1), "bulbs": plan_json(1)["bulbs"][:1]}
    reply = await client.call("outglow/plan/save", rev=1, plan=plan)
    assert (reply["success"], reply["error"]["code"]) == (False, "unknown_error")
    assert coordinator.plan.rev == 1
    assert hass_storage[PLAN_KEY]["data"] == stored
    assert coordinator.engine is engine
    monkeypatch.undo()
    assert (await client.ok("outglow/plan/save", rev=1, plan=plan))["rev"] == 2
    assert hass_storage[PLAN_KEY]["data"]["rev"] == 2


async def test_a_plan_save_does_not_block_the_loop(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], clock: Clock
) -> None:
    coordinator, client = ready
    plan = plan_json(1)
    many = [
        {
            "ieee": f"0x{n + 1:016x}",
            "x": 0.2 + (n % 6) * 1.1,
            "y": 0.2 + (n // 6) * 1.2,
            "height": "ceiling",
            "room": None,
        }
        for n in range(30)
    ]
    assert (await client.ok("outglow/plan/save", rev=1, plan={**plan, "bulbs": many}))["rev"] == 2
    topo = coordinator.engine.topology
    learner = coordinator.engine._learner
    blank = TickRecord(
        t=0.0,
        levels=bytes(len(topo.directions)),
        states=bytes(len(topo.directions)),
        codes=bytes(len(topo.pairs)),
        p=(0.0,) * len(topo.rooms),
        empty="no",
    )
    for i in range(learner.buffer.maxlen or 0):
        learner.record(replace(blank, t=clock() - i * 0.5))
    gaps: list[float] = []
    loop = asyncio.get_running_loop()
    stop = False

    async def beat() -> None:
        last = loop.time()
        while not stop:
            await asyncio.sleep(0.002)
            now = loop.time()
            gaps.append(now - last)
            last = now

    debug = loop.get_debug()
    loop.set_debug(False)
    beating = hass.async_create_task(beat())
    await asyncio.sleep(0.01)
    try:
        assert (await client.ok("outglow/plan/save", rev=2, plan={**plan, "bulbs": many[:-1]}))["rev"] == 3
    finally:
        stop = True
        await beating
        loop.set_debug(debug)
    assert len(coordinator.engine._learner.buffer) == learner.buffer.maxlen
    assert max(gaps) < 0.05, max(gaps)


async def test_plan_save_warns_about_a_bulb_pinned_to_a_room_it_does_not_stand_in(
    ready: tuple[OutglowCoordinator, Client],
) -> None:
    _coordinator, client = ready
    plan = plan_json(1)
    first = plan["bulbs"][0]
    room = "hall"
    pinned = {**plan, "bulbs": [{**first, "room": "living"}, *plan["bulbs"][1:]]}
    assert (await client.ok("outglow/plan/save", rev=1, plan=pinned))["warnings"] == []
    elsewhere = {**plan, "bulbs": [{**first, "room": room}, *plan["bulbs"][1:]]}
    saved = await client.ok("outglow/plan/save", rev=2, plan=elsewhere)
    assert saved["warnings"] == [
        {"code": "bulb_pinned_elsewhere", "params": {"ieee": first["ieee"], "room": room, "at": "living"}}
    ]


async def test_plan_import_mieszkanie(ready: tuple[OutglowCoordinator, Client]) -> None:
    _coordinator, client = ready
    result = await client.ok("outglow/plan/import", format="mieszkanie_yaml", text=MIESZKANIE)
    plan = result["plan"]
    assert plan["rev"] == 0
    assert [room["id"] for room in plan["rooms"]] == ["living", "hall"]
    assert plan["adjacent"] == [["living", "hall"]]
    assert [(b["ieee"], b["room"]) for b in plan["bulbs"]] == [
        ("0x0000000000000001", "living"),
        ("0x0000000000000003", None),
        ("0x0000000000000099", None),
    ]
    codes = {(w["code"], tuple(sorted(w["params"].items()))) for w in result["warnings"]}
    assert ("dropped_field", (("field", "scale_m_per_plan_px"),)) in codes
    assert ("unknown_room", (("ieee", "0x0000000000000099"), ("room", "attic"))) in codes
    assert ("bulb_outside_rooms", (("ieee", "0x0000000000000099"),)) in codes
    assert any(code == "unknown_bulb" for code, _ in codes)
    await client.error("outglow/plan/import", "invalid_format", format="mieszkanie_yaml", text="rooms: [")
    await client.error("outglow/plan/import", "invalid_format", format="valetudo_json", text="{}")
    fixture = ws_fixture("outglow/plan/import")
    await client.ok("outglow/plan/import", **fixture["request"])
    as_json = await client.ok("outglow/plan/import", format="outglow_json", text='{"rooms": [], "bulbs": []}')
    assert as_json["plan"]["rooms"] == []


async def test_background_round_trip(ready: tuple[OutglowCoordinator, Client], config_dir: Any) -> None:
    _coordinator, client = ready
    folder = config_dir / "outglow"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plan.yaml").write_text("rooms: {}")
    (folder / "plan.webp").write_bytes(b"old")
    request = ws_fixture("outglow/plan/background/set")["request"]
    name = (await client.ok("outglow/plan/background/set", **request))["file"]
    assert name == ws_fixture("outglow/plan/background/set")["response"]["file"]
    assert (folder / name).is_file()
    assert (folder / "plan.yaml").read_text() == "rooms: {}"
    assert (folder / "plan.webp").read_bytes() == b"old"
    await client.error("outglow/plan/background/set", "invalid_format", mime="image/png", data_base64="@@@")
    big = base64.b64encode(b"").decode()
    await client.error("outglow/plan/background/set", "invalid_format", mime="image/png", data_base64=big)


BACKDROP = {"file": "plan.svg", "x": 0.0, "y": 0.0, "m_per_px": 0.05, "opacity": 0.6}


def background_of(coordinator: OutglowCoordinator) -> Any:
    return coordinator.plan.background


def image(data: bytes, deflated: bool = False) -> dict[str, Any]:
    body = zlib.compress(data) if deflated else data
    return {"mime": "image/svg+xml", "data_base64": base64.b64encode(body).decode(), "deflated": deflated}


async def test_the_background_is_stored_with_the_plan(
    ready: tuple[OutglowCoordinator, Client], config_dir: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    folder = config_dir / "outglow"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plan.png").write_bytes(b"legacy")
    (folder / "plan.yaml").write_text("rooms: {}")
    first = await client.ok(
        "outglow/plan/save",
        rev=1,
        plan={**plan_json(1), "background": BACKDROP},
        background_image=image(b"<svg>1</svg>"),
    )
    assert first["rev"] == 2
    assert first["background"]["file"].startswith("plan-")
    assert to_json(background_of(coordinator)) == first["background"]
    assert (folder / first["background"]["file"]).read_bytes() == b"<svg>1</svg>"
    assert not (folder / "plan.png").exists()
    assert (folder / "plan.yaml").exists()
    got = (await client.ok("outglow/plan/background/get"))["image"]
    assert base64.b64decode(got["data_base64"]) == b"<svg>1</svg>"
    stale = {**plan_json(1), "background": BACKDROP}
    await client.error(
        "outglow/plan/save", "rev_conflict", rev=1, plan=stale, background_image=image(b"<svg>lost</svg>")
    )
    assert sorted(p.name for p in folder.glob("plan-*")) == [first["background"]["file"]]
    second = await client.ok(
        "outglow/plan/save",
        rev=2,
        plan={**plan_json(2), "background": BACKDROP},
        background_image=image(b"<svg>2</svg>", deflated=True),
    )
    assert (folder / second["background"]["file"]).read_bytes() == b"<svg>2</svg>"
    assert (folder / first["background"]["file"]).exists()
    undone = {**plan_json(3), "background": first["background"]}
    third = await client.ok("outglow/plan/save", rev=3, plan=undone)
    assert third["background"] == first["background"]
    assert (folder / second["background"]["file"]).exists()
    fourth = await client.ok("outglow/plan/save", rev=4, plan={**plan_json(4), "background": first["background"]})
    assert fourth["background"] == first["background"]
    assert sorted(p.name for p in folder.glob("plan-*")) == [first["background"]["file"]]
    gone = await client.ok("outglow/plan/save", rev=5, plan={**plan_json(5), "background": second["background"]})
    assert gone["background"] is None
    assert background_of(coordinator) is None
    await client.error("outglow/plan/save", "invalid_format", rev=6, plan=plan_json(6), background_image=image(b"x"))
    await client.error(
        "outglow/plan/save",
        "invalid_format",
        rev=6,
        plan={**plan_json(6), "background": BACKDROP},
        background_image={**image(b"x"), "deflated": True},
    )
    monkeypatch.setattr(websocket_module, "BACKGROUND_MAX", 10)
    await client.error(
        "outglow/plan/save",
        "invalid_format",
        rev=6,
        plan={**plan_json(6), "background": BACKDROP},
        background_image=image(b"<svg>" + b" " * 100 + b"</svg>", deflated=True),
    )
    await client.error(
        "outglow/plan/save",
        "invalid_format",
        rev=6,
        plan={**plan_json(6), "background": {**BACKDROP, "file": "../x.svg"}},
    )
    assert coordinator.plan.rev == 6


async def test_a_deflated_file_is_imported(ready: tuple[OutglowCoordinator, Client]) -> None:
    _coordinator, client = ready
    packed = base64.b64encode(zlib.compress(FLAT.encode())).decode()
    result = await client.ok("outglow/plan/import", format="auto", deflated_base64=packed)
    assert result["source"] == "valetudo_map"
    assert result == await client.ok("outglow/plan/import", format="auto", text=FLAT)
    await client.error("outglow/plan/import", "invalid_format", format="auto")
    await client.error("outglow/plan/import", "invalid_format", format="auto", text=FLAT, deflated_base64=packed)
    await client.error("outglow/plan/import", "invalid_format", format="auto", deflated_base64="@@@")
    await client.error(
        "outglow/plan/import", "invalid_format", format="auto", deflated_base64=base64.b64encode(b"plain").decode()
    )
    latin = base64.b64encode(zlib.compress('{"a": "\u00e9"}'.encode("latin-1"))).decode()
    await client.error("outglow/plan/import", "invalid_format", format="auto", deflated_base64=latin)


def test_a_deflated_file_has_the_same_size_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plan_import, "MAX_TEXT", 10)
    with pytest.raises(OutglowError, match="too large"):
        plan_import.inflate_text(base64.b64encode(zlib.compress(b"x" * 11)).decode())
    assert plan_import.inflate_text(base64.b64encode(zlib.compress(b"x" * 10)).decode()) == "x" * 10


async def test_settings_set_and_validation(ready: tuple[OutglowCoordinator, Client]) -> None:
    coordinator, client = ready
    request = ws_fixture("outglow/settings/set")["request"]
    result = await client.ok("outglow/settings/set", **request)
    assert result["rooms"]["hall"]["hold_time_s"] == 90
    assert coordinator.settings.rooms["office"].false_alarm_budget == 0.3
    bad = {**request, "global": {**request["global"], "tick_s": 0.7}}
    await client.error("outglow/settings/set", "invalid_format", **bad)
    bad_room = {**request, "rooms": {"hall": {**request["rooms"]["hall"], "hold_time_s": 5}}}
    await client.error("outglow/settings/set", "invalid_format", **bad_room)
    unknown = {**request, "global": {**request["global"], "colour": "red"}}
    await client.error("outglow/settings/set", "invalid_format", **unknown)


async def test_live_subscription_sends_full_then_delta(ready: tuple[OutglowCoordinator, Client], clock: Clock) -> None:
    coordinator, client = ready
    coordinator.tick()
    await client.ws.send_json_auto_id({"type": "outglow/live/subscribe", "rate_hz": 4})
    reply = await client.ws.receive_json()
    assert reply["success"]
    assert reply["result"] is None
    spec = commands()["outglow/live/subscribe"]
    full = await client.ws.receive_json()
    validate(spec["event"], full["event"])
    assert full["event"]["kind"] == "full"
    clock.advance(0.5)
    frame = Frame(
        t=clock(),
        rooms={"living": RoomFrame(p=0.9, motion=True, occupied=True, coverage="good")},
        pairs=(PairFrame(a="0x0000000000000001", b="0x0000000000000002", obs=2, weight=0.8),),
        gates=dict(coordinator.frame.gates) if coordinator.frame else {},
    )
    coordinator.set_frame(frame)
    message = await client.ws.receive_json()
    validate(spec["event"], message["event"])
    assert message["event"]["kind"] == "full"
    clock.advance(0.5)
    coordinator.set_frame(
        Frame(
            t=clock(),
            rooms={"living": RoomFrame(p=0.5, motion=False, occupied=True, coverage="good")},
            pairs=frame.pairs,
            gates=frame.gates,
        )
    )
    delta = await client.ws.receive_json()
    validate(spec["event"], delta["event"])
    assert delta["event"]["kind"] == "delta"
    assert set(delta["event"]["delta"]) == {"t", "rooms"}
    assert delta["event"]["delta"]["rooms"]["living"]["p"] == 0.5
    await client.ws.send_json_auto_id({"type": "outglow/live/subscribe", "rate_hz": 0})
    assert (await client.ws.receive_json())["error"]["code"] == "invalid_format"


async def test_history_range_and_frames(ready: tuple[OutglowCoordinator, Client], clock: Clock) -> None:
    coordinator, client = ready
    start = clock()
    for step in range(6):
        clock.advance(10)
        p = 0.9 if step < 3 else 0.01
        coordinator.set_frame(
            Frame(
                t=clock(),
                rooms={"living": RoomFrame(p=p, motion=p > 0.5, occupied=p > 0.5, coverage="good")},
                pairs=(PairFrame(a="0x0000000000000001", b="0x0000000000000002", obs=2 if p > 0.5 else 0),),
            )
        )
    result = await client.ok("outglow/history/range", start=start, end=clock(), step_s=10, pairs=True)
    living = result["rooms"]["living"]
    assert [sample[1:] for sample in living] == [[0.9, True], [0.9, True], [0.9, True], [0.0, False]]
    assert result["rooms"]["office"] == []
    kinds = [event["kind"] for event in result["events"]]
    assert kinds.count("motion_on") == 1
    assert kinds.count("motion_off") == 1
    assert result["pairs"][0]["a"] == "0x0000000000000001"
    plain = await client.ok("outglow/history/range", start=start, end=clock(), step_s=60)
    assert plain["pairs"] is None
    await client.error("outglow/history/range", "invalid_format", start=clock(), end=start, step_s=1)
    frames = await client.ok("outglow/history/frames", start=clock() - 2, end=clock())
    assert len(frames["frames"]) == 5
    assert frames["truncated"] is True
    clock.advance(5)
    for ieee in BULBS:
        coordinator.observe(Observation(t=clock(), rx=ieee))
    later = await client.ok("outglow/history/frames", start=clock(), end=clock() + 1)
    assert later["truncated"] is False


async def test_model_flow_apply_discard_rollback(ready: tuple[OutglowCoordinator, Client], clock: Clock) -> None:
    coordinator, client = ready
    await client.error("outglow/model/apply", "not_found", pending_id="p-9999")
    await client.error("outglow/model/discard", "not_found", pending_id="p-9999")
    for _ in range(70):
        clock.advance(0.5)
        coordinator.tick()
    label = Label(t0=clock() - 30, t1=clock(), kind="room", room="living", activity="walk", source="service")
    pending = await coordinator.async_add_labels([label], background=False)
    assert pending is not None
    clock.advance(0.5)
    coordinator.tick()
    summary = await client.ok("outglow/model/get")
    assert summary["pending"]["pending_id"] == pending
    assert summary["pending"]["labels"] == {"service": 49}
    assert {room["room"] for room in summary["pending"]["rooms"]} == {"living", "hall", "office"}
    applied = await client.ok("outglow/model/apply", pending_id=pending)
    assert applied["model_version"] == 1
    assert applied["snapshot_id"] is not None
    after = await client.ok("outglow/model/get")
    assert after["pending"] is None
    assert after["labels"] == {"service": 49}
    other = await coordinator.async_add_labels([label], background=False)
    assert other is not None
    discarded = await client.ok("outglow/model/discard", pending_id=other)
    assert discarded == {"model_version": 1, "snapshot_id": None}
    snapshots = (await client.ok("outglow/model/snapshots"))["snapshots"]
    assert [s["reason"] for s in snapshots] == ["before_apply"]
    rolled = await client.ok("outglow/model/rollback", snapshot_id=snapshots[0]["snapshot_id"])
    assert rolled["model_version"] == 2
    await client.error("outglow/model/rollback", "not_found", snapshot_id="m-9999")
    assert coordinator.frame is not None


async def test_apply_switches_only_the_mode_of_the_current_settings(
    ready: tuple[OutglowCoordinator, Client], clock: Clock
) -> None:
    coordinator, client = ready
    for _ in range(70):
        clock.advance(0.5)
        coordinator.tick()
    label = Label(t0=clock() - 30, t1=clock(), kind="room", room="living", activity="walk", source="service")
    pending = await coordinator.async_add_labels([label], background=False)
    assert pending is not None
    seen = await client.ok("outglow/settings/get")
    assert seen["global"]["mode"] == "rules"
    await coordinator.async_update_settings(lambda s: replace(s, global_=replace(s.global_, others_may_be_home=True)))
    await client.error("outglow/model/apply", "invalid_format", pending_id=pending, mode="fast")
    applied = await client.ok("outglow/model/apply", pending_id=pending, mode="bayes")
    assert applied["model_version"] == 1
    settings = await client.ok("outglow/settings/get")
    assert settings["global"]["mode"] == "bayes"
    assert settings["global"]["others_may_be_home"] is True
    assert coordinator.settings.global_.mode == "bayes"


async def test_feedback_from_the_history_view(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], clock: Clock
) -> None:
    coordinator, client = ready
    start = clock()
    coordinator.event("motion_on", "living", {"p": 0.9}, start)
    clock.advance(120)
    result = await client.ok("outglow/feedback", room="living", kind="false_alarm", when=start + 30)
    validate("history.json#/$defs/FeedbackResponse", result)
    assert result["pending_id"] == coordinator.engine.pending_id()
    missed = await client.ok("outglow/feedback", room="hall", kind="missed")
    assert missed["pending_id"] == result["pending_id"]
    await client.error("outglow/feedback", "not_found", room="attic", kind="missed")
    labels = await pending_labels(hass, coordinator)
    assert sorted((lb.room or "", lb.kind, lb.t0, lb.t1) for lb in labels) == [
        ("hall", "room", clock() - 20, clock() + 5),
        ("living", "empty", start - 10, start + 5),
    ]
    await coordinator.async_update_settings(lambda s: replace(s, global_=replace(s.global_, learning=False)))
    assert await client.ok("outglow/feedback", room="hall", kind="correct", when=None) == {"pending_id": None}


async def test_bulb_write_preview_tokens(
    ready: tuple[OutglowCoordinator, Client], clock: Clock, mqtt_mock: MqttMockHAClient
) -> None:
    _coordinator, client = ready
    request = {"ieee": "0x0000000000000004", "setting": "sensitivity", "value": 50}
    preview = await client.ok("outglow/bulb/write_preview", **request)
    assert preview["previous"] == 40
    codes = [effect["code"] for effect in preview["effects"]]
    assert codes == ["overwrites_all_lines", "clears_calibration"]
    assert preview["effects"][0]["params"] == {"lines": 3}
    await client.error(
        "outglow/bulb/write", "token_mismatch", **{**request, "value": 51}, confirm_token=preview["confirm_token"]
    )
    assert mqtt_mock.async_publish.call_count == 0
    written = await client.ok("outglow/bulb/write", **request, confirm_token=preview["confirm_token"])
    assert written["written"] is True
    assert mqtt_mock.async_publish.call_count == 1
    assert mqtt_mock.async_publish.call_args.args[:2] == ("zigbee2mqtt/Office/set", '{"motion_sensitivity":50}')
    await client.error("outglow/bulb/write", "token_expired", **request, confirm_token=preview["confirm_token"])
    late = await client.ok("outglow/bulb/write_preview", **request)
    clock.advance(61)
    await client.error("outglow/bulb/write", "token_expired", **request, confirm_token=late["confirm_token"])
    await client.error("outglow/bulb/write_preview", "not_found", ieee="0x00000000000000aa", setting="probes", value=1)
    await client.error("outglow/bulb/write_preview", "invalid_format", ieee=request["ieee"], setting="probes", value=99)
    await client.error("outglow/bulb/write_preview", "invalid_format", ieee=request["ieee"], setting="colour", value=1)
    assert mqtt_mock.async_publish.call_count == 1


@pytest.mark.parametrize("command", sorted(commands()))
async def test_every_command_needs_admin(
    hass: HomeAssistant,
    mqtt_mock: MqttMockHAClient,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
    command: str,
) -> None:
    await setup_outglow(hass)
    ws = await hass_ws_client(hass, hass_read_only_access_token)
    await ws.send_json_auto_id({"type": command, **ws_fixture(command)["request"]})
    reply = await ws.receive_json()
    assert reply["error"]["code"] == "unauthorized"
    assert mqtt_mock.async_publish.call_count == 0


@pytest.mark.parametrize("command", sorted(commands()))
async def test_every_fixture_request_is_accepted(
    ready: tuple[OutglowCoordinator, Client], command: str, mqtt_mock: MqttMockHAClient
) -> None:
    _coordinator, client = ready
    fixture = ws_fixture(command)
    if command == "outglow/live/subscribe":
        await client.ws.send_json_auto_id({"type": command, **fixture["request"]})
        assert (await client.ws.receive_json())["success"]
        return
    reply = await client.call(command, **fixture["request"])
    if reply["success"]:
        validate(commands()[command]["response"], reply["result"])
    else:
        allowed = {e["code"] for e in fixture.get("errors", [])} | {"rev_conflict", "not_found", "no_session"}
        assert reply["error"]["code"] in allowed, reply
    assert mqtt_mock.async_publish.call_count == 0


async def test_frames_are_limited_to_five_minutes_and_built_off_the_loop(
    ready: tuple[OutglowCoordinator, Client], clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    start = clock()
    for _ in range(40):
        clock.advance(60)
        for ieee in BULBS:
            coordinator.observe(Observation(t=clock(), rx=ieee))
    on_loop: list[bool] = []

    def spy(value: Any) -> Any:
        if isinstance(value, Frame):
            on_loop.append(threading.current_thread() is threading.main_thread())
        return to_json(value)

    monkeypatch.setattr(session_module, "to_json", spy)
    monkeypatch.setattr(websocket_module, "to_json", spy)
    result = await client.ok("outglow/history/frames", start=start, end=start + 3600)
    assert result["truncated"] is True
    assert result["frames"][-1]["t"] <= start + 300
    assert result["frames"][-1]["t"] >= start + 299
    assert on_loop
    assert not any(on_loop)


async def test_snapshots_are_deleted_one_at_a_time_or_all(
    ready: tuple[OutglowCoordinator, Client], clock: Clock, hass_storage: dict[str, Any]
) -> None:
    coordinator, client = ready
    ids = [coordinator.snapshot("daily", clock.advance(60)) for _ in range(3)]
    left = await client.ok("outglow/model/snapshot/delete", snapshot_id=ids[1])
    assert [s["snapshot_id"] for s in left["snapshots"]] == [ids[0], ids[2]]
    assert [s["snapshot_id"] for s in hass_storage[SNAPSHOTS_KEY]["data"]["snapshots"]] == [ids[0], ids[2]]
    await client.error("outglow/model/snapshot/delete", "not_found", snapshot_id=ids[1])
    await client.error("outglow/model/snapshot/delete", "invalid_format")
    await client.error("outglow/model/snapshot/delete", "invalid_format", snapshot_id=ids[0], all=True)
    await client.error("outglow/model/snapshot/delete", "invalid_format", all=False)
    version = coordinator.model_version
    assert await client.ok("outglow/model/snapshot/delete", all=True) == {"snapshots": []}
    assert hass_storage[SNAPSHOTS_KEY]["data"]["snapshots"] == []
    assert coordinator.model_version == version
    fresh = coordinator.snapshot("daily", clock.advance(60))
    assert fresh not in ids


async def test_the_target_of_a_running_rollback_stays(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    target, other = (coordinator.snapshot("daily", clock.advance(60)) for _ in range(2))
    release = asyncio.Event()

    async def slow() -> None:
        await release.wait()

    monkeypatch.setattr(coordinator, "_async_drop_pending", slow)
    rollback = hass.async_create_task(coordinator.async_rollback(target))
    await asyncio.sleep(0)
    assert coordinator.rolling_back == target
    await client.error("outglow/model/snapshot/delete", "busy", snapshot_id=target)
    await client.error("outglow/model/rollback", "busy", snapshot_id=other)
    before = coordinator.model.snapshots[-1]["snapshot_id"]
    assert coordinator.model.snapshots[-1]["reason"] == "before_rollback"
    await client.error("outglow/model/snapshot/delete", "busy", snapshot_id=before)
    remaining = await client.ok("outglow/model/snapshot/delete", all=True)
    assert [s["snapshot_id"] for s in remaining["snapshots"]] == [target, before]
    release.set()
    assert (await rollback) == {"model_version": 1, "snapshot_id": before}
    assert (await client.ok("outglow/model/rollback", snapshot_id=target))["model_version"] == 2
    await client.ok("outglow/model/snapshot/delete", snapshot_id=target)


async def test_a_snapshot_taken_by_a_running_reset_stays(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    release = asyncio.Event()

    async def slow() -> None:
        await release.wait()

    monkeypatch.setattr(coordinator, "_async_drop_pending", slow)
    reset = hass.async_create_task(coordinator.async_reset_learning())
    await asyncio.sleep(0)
    (before,) = (s["snapshot_id"] for s in coordinator.model.snapshots if s["reason"] == "before_reset")
    await client.error("outglow/model/snapshot/delete", "busy", snapshot_id=before)
    assert (await client.ok("outglow/model/snapshot/delete", all=True))["snapshots"][0]["snapshot_id"] == before
    release.set()
    assert (await reset)["snapshot_id"] == before
    assert await client.ok("outglow/model/snapshot/delete", all=True) == {"snapshots": []}


async def test_learning_is_reset_from_the_panel_after_a_snapshot(ready: tuple[OutglowCoordinator, Client]) -> None:
    coordinator, client = ready
    plan, settings = coordinator.plan, coordinator.settings
    await client.error("outglow/model/reset", "not_found", room="attic")
    room = await client.ok("outglow/model/reset", room="living")
    assert room["model_version"] == 1
    snapshots = (await client.ok("outglow/model/snapshots"))["snapshots"]
    assert [(s["snapshot_id"], s["reason"], s["model_version"]) for s in snapshots] == [
        (room["snapshot_id"], "before_reset", 0)
    ]
    home = await client.ok("outglow/model/reset", room=None)
    assert home["model_version"] == 2
    assert (await client.ok("outglow/model/reset"))["model_version"] == 3
    assert len((await client.ok("outglow/model/snapshots"))["snapshots"]) == 3
    assert (coordinator.plan, coordinator.settings) == (plan, settings)


FLAT = (Path(__file__).resolve().parents[1] / "fixtures" / "valetudo" / "flat.json").read_text()
MAP_URL = "http://robot.test/api/v2/robot/state/map"


async def test_plan_import_recognises_a_valetudo_map_and_keeps_the_bulbs(
    ready: tuple[OutglowCoordinator, Client],
) -> None:
    coordinator, client = ready
    current = to_json(coordinator.plan)
    result = await client.ok("outglow/plan/import", format="auto", text=FLAT, current=current)
    assert result["source"] == "valetudo_map"
    assert result["background_image"]["mime"] == "image/svg+xml"
    assert base64.b64decode(result["background_image"]["data_base64"]).startswith(b"<svg")
    assert result["plan"]["background"]["file"] == "plan.svg"
    assert result["kept"]["bulbs"] == 4
    assert result["kept"]["rooms"] == 2
    ids = [room["id"] for room in result["plan"]["rooms"]]
    assert ids == ["living", "kitchen", "hall", "room_7"]
    assert len(result["plan"]["bulbs"]) == 4
    bare = await client.ok("outglow/plan/import", format="auto", text=FLAT)
    assert bare["kept"] is None
    assert bare["plan"]["bulbs"] == []
    await client.error("outglow/plan/import", "invalid_format", format="auto", text="just words")
    saved = {**result["plan"], "rev": coordinator.plan.rev}
    await client.ok("outglow/plan/save", rev=coordinator.plan.rev, plan=saved)


async def test_valetudo_robots_come_from_the_device_registry(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client]
) -> None:
    _coordinator, client = ready
    entry = MockConfigEntry(domain="mqtt")
    entry.add_to_hass(hass)
    registry = dr.async_get(hass)
    for ident, maker, url in (
        ("Robot1", "Valetudo", "http://valetudo-robot1.local"),
        ("Robot2", "Valetudo", "homeassistant://config/nope"),
        ("bad/id", "Valetudo", None),
        ("Other", "Acme", None),
    ):
        registry.async_get_or_create(
            config_entry_id=entry.entry_id,
            identifiers={("mqtt", ident)},
            manufacturer=maker,
            name=f"Vacuum {ident}",
            configuration_url=url,
        )
    result = await client.ok("outglow/plan/valetudo/robots")
    assert result == {
        "url": None,
        "robots": [
            {"id": "Robot1", "name": "Vacuum Robot1", "url": "http://valetudo-robot1.local"},
            {"id": "Robot2", "name": "Vacuum Robot2", "url": None},
        ],
    }


async def test_valetudo_fetch_over_mqtt(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], monkeypatch: pytest.MonkeyPatch
) -> None:
    _coordinator, client = ready
    await client.ws.send_json_auto_id({"type": "outglow/plan/valetudo/fetch", "robot": "Robot1"})
    for _ in range(10):
        await asyncio.sleep(0.01)
        async_fire_mqtt_message(hass, "valetudo/Robot1/MapData/map-data", zlib.compress(FLAT.encode()))
    reply = await client.ws.receive_json()
    assert reply["success"], reply
    validate(commands()["outglow/plan/valetudo/fetch"]["response"], reply["result"])
    assert len(reply["result"]["plan"]["rooms"]) == 4
    monkeypatch.setattr(valetudo_fetch, "MQTT_WAIT_S", 0.05)
    await client.error("outglow/plan/valetudo/fetch", "not_found", robot="Robot9")
    await client.error("outglow/plan/valetudo/fetch", "invalid_format", robot="a/#")
    await client.error("outglow/plan/valetudo/fetch", "invalid_format")


async def test_valetudo_fetch_over_http_remembers_the_address(
    ready: tuple[OutglowCoordinator, Client], aioclient_mock: AiohttpClientMocker, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    aioclient_mock.get(MAP_URL, text=FLAT)
    aioclient_mock.get("http://broken.test/api/v2/robot/state/map", status=500)
    aioclient_mock.get("http://garbage.test/api/v2/robot/state/map", text="<html>")
    aioclient_mock.get("http://other.test/api/v2/robot/state/map", text=json.dumps({"rooms": []}))
    aioclient_mock.get("http://slow.test/api/v2/robot/state/map", exc=TimeoutError())
    current = to_json(coordinator.plan)
    result = await client.ok("outglow/plan/valetudo/fetch", url=" robot.test/ ", current=current)
    assert result["source"] == "valetudo_map"
    assert result["kept"]["bulbs"] == 4
    assert (await client.ok("outglow/plan/valetudo/robots"))["url"] == "robot.test/"
    await client.ok("outglow/plan/valetudo/fetch", url=MAP_URL)
    assert aioclient_mock.mock_calls[-1][1].path == "/api/v2/robot/state/map"
    await client.error("outglow/plan/valetudo/fetch", "fetch_failed", url="http://broken.test")
    await client.error("outglow/plan/valetudo/fetch", "fetch_failed", url="http://slow.test")
    await client.error("outglow/plan/valetudo/fetch", "invalid_format", url="http://garbage.test")
    await client.error("outglow/plan/valetudo/fetch", "invalid_format", url="http://other.test")
    await client.error("outglow/plan/valetudo/fetch", "invalid_format", url="file:///etc/passwd")
    await client.error("outglow/plan/valetudo/fetch", "invalid_format", url="http://admin:secret@robot.test")
    await client.error("outglow/plan/valetudo/fetch", "invalid_format", url="http://admin@robot.test")
    monkeypatch.setattr(valetudo_fetch, "MAX_MAP_BYTES", 100)
    await client.error("outglow/plan/valetudo/fetch", "invalid_format", url="http://robot.test")
    assert (await client.ok("outglow/plan/valetudo/robots"))["url"] == "http://robot.test/api/v2/robot/state/map"


def test_inflate_refuses_bombs_and_garbage(monkeypatch: pytest.MonkeyPatch) -> None:
    assert valetudo_fetch.inflate(b' {"a": 1}') == b' {"a": 1}'
    assert valetudo_fetch.inflate(zlib.compress(b'{"a": 1}')) == b'{"a": 1}'
    monkeypatch.setattr(valetudo_fetch, "MAX_MAP_BYTES", 10)
    with pytest.raises(OutglowError, match="too large"):
        valetudo_fetch.inflate(zlib.compress(b"{" + b" " * 1000 + b"}"))
    with pytest.raises(OutglowError, match="too large"):
        valetudo_fetch.inflate(b"{" + b" " * 20 + b"}")
    with pytest.raises(OutglowError, match="neither"):
        valetudo_fetch.inflate(b"not deflate")
    assert valetudo_fetch.map_url("https://r.test:8443/x/") == "https://r.test:8443/x/api/v2/robot/state/map"
