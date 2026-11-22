import asyncio
import base64
import contextlib
import json
import random
import threading
import zlib
from collections.abc import Awaitable, Callable
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers import storage
from homeassistant.helpers.json import json_bytes
from homeassistant.util import dt as dt_util
from homeassistant.util.json import json_loads
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_mqtt_message,
    async_fire_time_changed,
)
from pytest_homeassistant_custom_component.test_util.aiohttp import AiohttpClientMocker
from pytest_homeassistant_custom_component.typing import MqttMockHAClient, WebSocketGenerator

from custom_components.outglow import coordinator as coordinator_module
from custom_components.outglow import plan_import, valetudo_fetch
from custom_components.outglow import session as session_module
from custom_components.outglow import websocket as websocket_module
from custom_components.outglow.const import DOMAIN
from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine import Engine, from_json, to_json
from custom_components.outglow.engine.defaults import HIST_BINS
from custom_components.outglow.engine.learn import TickRecord
from custom_components.outglow.engine.model import Hist, RoomCal
from custom_components.outglow.engine.types import (
    Context,
    Frame,
    Label,
    Observation,
    PairFrame,
    Plan,
    RoomFrame,
    RoomSettings,
)
from custom_components.outglow.errors import OutglowError
from custom_components.outglow.store import MODEL_KEY, PLAN_KEY, SNAPSHOTS_KEY
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
    assert await client.ok("outglow/plan/background/get") == {"image": None, "file": None}


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


async def test_a_save_retires_every_room_it_leaves_out_and_says_so(ready: tuple[OutglowCoordinator, Client]) -> None:
    _coordinator, client = ready
    plan = plan_json(1)
    rooms = [room for room in plan["rooms"] if room["id"] != "office"]
    without = {**plan, "rooms": rooms, "adjacent": [["living", "hall"]], "retired_rooms": []}
    assert await client.ok("outglow/plan/save", rev=1, plan=without) == {
        "rev": 2,
        "warnings": [],
        "background": None,
        "retired_rooms": ["office"],
    }
    office = {**plan["rooms"][2], "id": "office_2"}
    again = {**without, "rooms": [*rooms, office], "retired_rooms": []}
    assert await client.ok("outglow/plan/save", rev=2, plan=again) == {
        "rev": 3,
        "warnings": [],
        "background": None,
        "retired_rooms": ["office"],
    }
    assert (await client.ok("outglow/plan/get"))["plan"]["retired_rooms"] == ["office"]


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


def _many_bulbs() -> list[dict[str, Any]]:
    return [
        {
            "ieee": f"0x{n + 1:016x}",
            "x": 0.2 + (n % 6) * 1.1,
            "y": 0.2 + (n // 6) * 1.2,
            "height": "ceiling",
            "room": None,
        }
        for n in range(30)
    ]


def _learned(engine: Engine) -> None:
    topo, model, rng = engine.topology, engine._active, random.Random(1)
    for d in topo.directions:
        model.hist[d] = Hist([rng.random() for _ in range(HIST_BINS)], rng.random())
        model.bg_onsets[d] = rng.random()
    for p in topo.pairs:
        model.pair_bg[p] = [rng.random() for _ in range(3)]
        for r in topo.rooms:
            model.emit[(p, r)] = [rng.random() for _ in range(3)]
    for r in topo.rooms:
        model.rooms[r] = RoomCal(a_on=0.7, false_per_day=0.1, detection=0.9)
        model.entries[r] = [rng.random() for _ in range(50)]
    engine._pending = model.clone()
    engine._pending_seq = 1


async def _gaps(hass: HomeAssistant, work: Callable[[], Awaitable[None]]) -> float:
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
    beating = loop.create_task(beat())
    await asyncio.sleep(0.01)
    try:
        await work()
    finally:
        stop = True
        await beating
        loop.set_debug(debug)
    return max(gaps)


async def test_model_saves_and_snapshots_of_a_learned_house_do_not_block_the_loop(
    hass: HomeAssistant,
    ready: tuple[OutglowCoordinator, Client],
    clock: Clock,
    hass_storage: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    coordinator, client = ready

    def prepare(data: dict[str, Any]) -> Any:
        if "data_func" in data:
            data["data"] = data.pop("data_func")()
        return json_loads(json_bytes(data))

    def off_the_loop(store: storage.Store[Any]) -> None:
        async def write(data: dict[str, Any]) -> None:
            hass_storage[store.key] = await hass.async_add_executor_job(prepare, data)

        monkeypatch.setattr(store, "_async_write_data", write)

    off_the_loop(coordinator.store._model)
    off_the_loop(coordinator.store._snapshots)
    plan = plan_json(1)
    assert (await client.ok("outglow/plan/save", rev=1, plan={**plan, "bulbs": _many_bulbs()}))["rev"] == 2
    engine = coordinator.engine
    _learned(engine)
    if coordinator._tick_unsub is not None:
        coordinator._tick_unsub()
        coordinator._tick_unsub = None
    assert len(engine.topology.directions) == 870
    pending_id = engine.pending_id()
    assert pending_id is not None
    wizard = Label(t0=clock() - 60, t1=clock() - 30, kind="empty", source="wizard")

    async def snapshot() -> None:
        await coordinator.async_snapshot("daily", clock())
        await hass.async_block_till_done()

    async def hourly() -> None:
        await coordinator.async_hourly()
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=6))
        await hass.async_block_till_done()

    async def apply() -> None:
        assert (await client.ok("outglow/model/apply", pending_id=pending_id))["model_version"] == 1
        await hass.async_block_till_done()

    async def label() -> None:
        await coordinator.async_add_labels([wizard], background=False)
        await hass.async_block_till_done()

    gaps = {step.__name__: await _gaps(hass, step) for step in (snapshot, hourly, apply, label)}
    gap = max(gaps.values())
    assert hass_storage[MODEL_KEY]["data"]["engine"] == coordinator.engine.model_state()
    stored = hass_storage[SNAPSHOTS_KEY]["data"]["snapshots"]
    assert [s["reason"] for s in stored] == ["daily", "before_apply"]
    assert len(stored[0]["state"]["hist"]) == 870
    assert gap < 0.05, gap


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
    stored = await client.ok("outglow/plan/background/get")
    assert stored["file"] == first["background"]["file"]
    got = stored["image"]
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


async def test_a_failure_after_the_plan_is_kept_leaves_its_background(
    ready: tuple[OutglowCoordinator, Client], config_dir: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready

    async def full(*_args: Any) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(coordinator.store, "async_save_settings", full)
    rev = coordinator.plan.rev
    plan = {**plan_json(rev), "background": BACKDROP}
    reply = await client.call("outglow/plan/save", rev=rev, plan=plan, background_image=image(b"<svg>late</svg>"))
    assert not reply["success"]
    background = background_of(coordinator)
    assert coordinator.plan.rev == rev + 1
    assert background is not None
    assert (config_dir / "outglow" / background.file).read_bytes() == b"<svg>late</svg>"


async def two_saves(client: Client, *bodies: dict[str, Any]) -> list[dict[str, Any]]:
    for body in bodies:
        await client.ws.send_json_auto_id({"type": "outglow/plan/save", **body})
    return [await client.ws.receive_json() for _ in bodies]


async def test_the_losing_save_of_the_same_image_leaves_the_winners_file(
    ready: tuple[OutglowCoordinator, Client], config_dir: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    save = coordinator.async_save_plan
    committed = asyncio.Event()
    calls: list[int] = []

    async def slow_first(rev: int, plan: Any) -> Plan:
        calls.append(rev)
        if len(calls) == 1:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(committed.wait(), 0.5)
        try:
            return await save(rev, plan)
        finally:
            committed.set()

    monkeypatch.setattr(coordinator, "async_save_plan", slow_first)
    rev = coordinator.plan.rev
    body = {
        "rev": rev,
        "plan": {**plan_json(rev), "background": BACKDROP},
        "background_image": image(b"<svg>same</svg>"),
    }
    replies = await two_saves(client, body, body)
    assert sorted("ok" if r["success"] else r["error"]["code"] for r in replies) == ["ok", "rev_conflict"]
    background = background_of(coordinator)
    assert background is not None
    assert (config_dir / "outglow" / background.file).read_bytes() == b"<svg>same</svg>"


async def test_a_save_leaves_the_image_of_a_save_still_in_flight(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], config_dir: Any, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    cleaned = asyncio.Event()
    remove = websocket_module._remove_backgrounds

    def removed(folder: Path, keep: set[str]) -> None:
        remove(folder, keep)
        hass.loop.call_soon_threadsafe(cleaned.set)

    monkeypatch.setattr(websocket_module, "_remove_backgrounds", removed)
    save = coordinator.async_save_plan
    late = plan_import.background_file(b"<svg>late</svg>", "svg")

    async def waiting(rev: int, plan: Any) -> Plan:
        if plan.background is not None and plan.background.file == late:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(cleaned.wait(), 0.5)
        return await save(rev, plan)

    monkeypatch.setattr(coordinator, "async_save_plan", waiting)
    rev = coordinator.plan.rev
    replies = await two_saves(
        client,
        {
            "rev": rev + 1,
            "plan": {**plan_json(rev + 1), "background": BACKDROP},
            "background_image": image(b"<svg>late</svg>"),
        },
        {"rev": rev, "plan": {**plan_json(rev), "background": BACKDROP}, "background_image": image(b"<svg>now</svg>")},
    )
    assert any(r["success"] for r in replies)
    background = background_of(coordinator)
    assert background is not None
    assert (config_dir / "outglow" / background.file).is_file()


async def test_a_save_clears_partial_files_and_never_writes_through_a_fixed_name(
    ready: tuple[OutglowCoordinator, Client], config_dir: Any
) -> None:
    coordinator, client = ready
    folder = config_dir / "outglow"
    folder.mkdir(parents=True, exist_ok=True)
    name = plan_import.background_file(b"<svg>p</svg>", "svg")
    (folder / f".{name}.part").mkdir()
    (folder / ".plan-0123456789abcdef.svg.part").write_bytes(b"left over")
    (folder / ".plan-abc.part").write_bytes(b"left over")
    rev = coordinator.plan.rev
    result = await client.ok(
        "outglow/plan/save",
        rev=rev,
        plan={**plan_json(rev), "background": BACKDROP},
        background_image=image(b"<svg>p</svg>"),
    )
    assert result["background"]["file"] == name
    assert (folder / name).read_bytes() == b"<svg>p</svg>"
    assert sorted(p.name for p in folder.glob(".plan-*")) == [f".{name}.part"]
    assert (folder / f".{name}.part").is_dir()


def test_a_hashed_background_name_passes_check_plan() -> None:
    for name in ("plan-0123456789abcdef.svg", "plan-fedcba9876543210.png", "plan.webp", "plan.jpg"):
        websocket_module.check_plan(from_json(Plan, {**plan_json(), "background": {**BACKDROP, "file": name}}))
    for name in ("plan-0123.svg", "plan-0123456789abcdeg.svg", "plan-0123456789abcdef.gif", "../plan.svg"):
        with pytest.raises(OutglowError, match="Background file"):
            websocket_module.check_plan(from_json(Plan, {**plan_json(), "background": {**BACKDROP, "file": name}}))
    big = {**plan_json(), "bulbs": [], "rooms": [{"id": f"r{i}", "name": "R", "outline": []} for i in range(251)]}
    with pytest.raises(OutglowError, match="too many rooms"):
        websocket_module.check_plan(from_json(Plan, {**big, "adjacent": []}))


async def test_a_plan_saved_with_a_hashed_background_keeps_it(
    ready: tuple[OutglowCoordinator, Client], config_dir: Any
) -> None:
    coordinator, client = ready
    folder = config_dir / "outglow"
    folder.mkdir(parents=True, exist_ok=True)
    name = plan_import.background_file(b"<svg>h</svg>", "svg")
    (folder / name).write_bytes(b"<svg>h</svg>")
    rev = coordinator.plan.rev
    result = await client.ok(
        "outglow/plan/save", rev=rev, plan={**plan_json(rev), "background": {**BACKDROP, "file": name}}
    )
    assert result["background"]["file"] == name
    assert background_of(coordinator).file == name


def test_a_cut_or_padded_deflate_stream_is_refused() -> None:
    data = zlib.compress(MIESZKANIE.encode(), 9)
    for broken in (
        data[: len(data) - 4],
        data[: len(data) // 2],
        data + b"GARBAGE",
        data + zlib.compress(b"rooms: {}"),
    ):
        with pytest.raises(OutglowError, match="cut short") as err:
            plan_import.inflate_text(base64.b64encode(broken).decode())
        assert err.value.code == "invalid_format"
        with pytest.raises(OutglowError, match="cut short"):
            websocket_module._decode_image(
                {**image(b""), "data_base64": base64.b64encode(broken).decode(), "deflated": True}
            )
        with pytest.raises(OutglowError, match="cut short"):
            valetudo_fetch.inflate(broken)
    assert plan_import.inflate_text(base64.b64encode(data).decode()) == MIESZKANIE


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
    snapshots = await client.ok("outglow/model/snapshots")
    validate("model.json#/$defs/SnapshotList", snapshots)
    assert [(s["reason"], s.get("mode")) for s in snapshots["snapshots"]] == [("before_apply", "rules")]
    await client.ok("outglow/model/rollback", snapshot_id=snapshots["snapshots"][0]["snapshot_id"])
    assert (await client.ok("outglow/settings/get"))["global"]["mode"] == "rules"
    assert (await client.ok("outglow/settings/get"))["global"]["others_may_be_home"] is True
    snapshots = await client.ok("outglow/model/snapshots")
    assert [(s["reason"], s.get("mode")) for s in snapshots["snapshots"]] == [
        ("before_apply", "rules"),
        ("before_rollback", "bayes"),
    ]
    await client.ok("outglow/model/rollback", snapshot_id=snapshots["snapshots"][1]["snapshot_id"])
    assert (await client.ok("outglow/settings/get"))["global"]["mode"] == "bayes"
    other = await coordinator.async_add_labels([label], background=False)
    assert other is not None
    await client.ok("outglow/model/apply", pending_id=other, mode="bayes")
    snapshots = await client.ok("outglow/model/snapshots")
    assert snapshots["snapshots"][-1]["reason"] == "before_apply"
    assert "mode" not in snapshots["snapshots"][-1]
    await client.ok("outglow/model/rollback", snapshot_id=snapshots["snapshots"][-1]["snapshot_id"])
    assert (await client.ok("outglow/settings/get"))["global"]["mode"] == "bayes"


async def test_an_apply_derives_off_the_loop_again_when_the_proposal_learned_meanwhile(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    for _ in range(70):
        clock.advance(0.5)
        coordinator.tick()
    label = Label(t0=clock() - 30, t1=clock(), kind="room", room="living", activity="walk", source="service")
    pending_id = await coordinator.async_add_labels([label], background=False)
    clock.advance(0.5)
    coordinator.tick()
    engine = coordinator.engine
    real = engine.derive
    made: list[tuple[int, Any]] = []

    def learn() -> None:
        assert engine._pending is not None
        engine._pending.bg_ticks += 1.0

    def derive(model: Any, weak: Any) -> Any:
        result = real(model, weak)
        made.append((threading.get_ident(), result))
        if len(made) == 1:
            asyncio.run_coroutine_threadsafe(_call(learn), hass.loop).result(5)
        return result

    monkeypatch.setattr(engine, "derive", derive)
    assert (await client.ok("outglow/model/apply", pending_id=pending_id))["model_version"] == 1
    assert [thread != threading.get_ident() for thread, _ in made] == [True, True]
    assert engine._emission is made[1][1].emission


async def _call(work: Callable[[], None]) -> None:
    work()


async def test_two_applies_and_a_reset_racing_leave_one_consistent_model(
    ready: tuple[OutglowCoordinator, Client], clock: Clock
) -> None:
    coordinator, _client = ready
    for _ in range(70):
        clock.advance(0.5)
        coordinator.tick()
    label = Label(t0=clock() - 30, t1=clock(), kind="room", room="living", activity="walk", source="service")
    pending_id = await coordinator.async_add_labels([label], background=False)
    assert pending_id is not None
    clock.advance(0.5)
    coordinator.tick()
    results = await asyncio.gather(
        coordinator.async_apply(pending_id),
        coordinator.async_apply(pending_id),
        coordinator.async_reset_learning("hall"),
        return_exceptions=True,
    )
    assert [type(r).__name__ for r in results] == ["dict", "OutglowError", "dict"]
    assert coordinator.model_version == 2
    engine = coordinator.engine
    fresh = engine.derive(engine._active, engine.weak_pairs())
    assert fresh.params == engine._params
    assert fresh.coverage == engine._coverage
    assert fresh.cfar == engine._cfar._basis


async def test_an_apply_in_an_empty_house_hits_with_its_first_slow_derivation(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    hass.states.async_set("person.a", "not_home")
    await coordinator.async_update_settings(
        lambda s: replace(s, global_=replace(s.global_, use_persons=True, persons=("person.a",)))
    )
    clock.advance(700)
    coordinator.tick()
    assert coordinator.house_empty == "yes"
    for _ in range(600):
        clock.advance(0.5)
        coordinator.tick()
    engine = coordinator.engine
    pending_id = engine.pending_id()
    assert pending_id is not None
    learned = engine.pending_model()
    clock.advance(0.5)
    coordinator.tick()
    assert engine.pending_model() != learned
    real = engine.derive
    made: list[tuple[int, Any]] = []

    def slow(model: Any, weak: Any) -> Any:
        result = real(model, weak)
        made.append((threading.get_ident(), result))
        threading.Event().wait(0.2)
        return result

    monkeypatch.setattr(engine, "derive", slow)
    applying = hass.async_create_task(client.ok("outglow/model/apply", pending_id=pending_id))
    ticks = 0
    while not applying.done():
        clock.advance(0.5)
        coordinator.tick()
        ticks += 1
        await asyncio.sleep(0.02)
    assert (await applying)["model_version"] == 1
    assert ticks > 5
    assert len(made) == 1
    assert made[0][0] != threading.get_ident()
    assert engine._emission is made[0][1].emission
    after = engine.pending_model()
    assert after is not None
    assert engine.pending_id() != pending_id
    assert after.bg_ticks > engine._active.bg_ticks


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


async def recorded(hass: HomeAssistant, coordinator: OutglowCoordinator, kind: str) -> list[tuple[str | None, Any]]:
    await coordinator.async_flush_history()
    events = await hass.async_add_executor_job(coordinator.history.events, 0, coordinator.now() + 1, [kind])
    return [(e.room, e.data) for e in events]


async def test_snapshots_are_deleted_one_at_a_time_or_all(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], clock: Clock, hass_storage: dict[str, Any]
) -> None:
    coordinator, client = ready
    ids = [await coordinator.async_snapshot("daily", clock.advance(60)) for _ in range(3)]
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
    fresh = await coordinator.async_snapshot("daily", clock.advance(60))
    assert fresh not in ids
    assert await recorded(hass, coordinator, "snapshot_delete") == [
        (None, {"snapshot_id": ids[1], "deleted": 1}),
        (None, {"all": True, "deleted": 2}),
    ]


async def test_the_target_of_a_running_rollback_stays(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    coordinator, client = ready
    target = await coordinator.async_snapshot("daily", clock.advance(60))
    other = await coordinator.async_snapshot("daily", clock.advance(60))
    release, entered = asyncio.Event(), asyncio.Event()

    async def slow() -> None:
        entered.set()
        await release.wait()

    monkeypatch.setattr(coordinator, "_async_drop_pending", slow)
    rollback = hass.async_create_task(coordinator.async_rollback(target))
    await entered.wait()
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
    release, entered = asyncio.Event(), asyncio.Event()

    async def slow() -> None:
        entered.set()
        await release.wait()

    monkeypatch.setattr(coordinator, "_async_drop_pending", slow)
    reset = hass.async_create_task(coordinator.async_reset_learning())
    await entered.wait()
    (before,) = (s["snapshot_id"] for s in coordinator.model.snapshots if s["reason"] == "before_reset")
    await client.error("outglow/model/snapshot/delete", "busy", snapshot_id=before)
    assert (await client.ok("outglow/model/snapshot/delete", all=True))["snapshots"][0]["snapshot_id"] == before
    release.set()
    assert (await reset)["snapshot_id"] == before
    assert await client.ok("outglow/model/snapshot/delete", all=True) == {"snapshots": []}


async def test_learning_is_reset_from_the_panel_after_a_snapshot(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client]
) -> None:
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
    again = await client.ok("outglow/model/reset")
    assert again["model_version"] == 3
    assert len((await client.ok("outglow/model/snapshots"))["snapshots"]) == 3
    assert await recorded(hass, coordinator, "model_reset") == [
        ("living", {"room": "living", "model_version": 1, "snapshot_id": room["snapshot_id"]}),
        (None, {"room": None, "model_version": 2, "snapshot_id": home["snapshot_id"]}),
        (None, {"room": None, "model_version": 3, "snapshot_id": again["snapshot_id"]}),
    ]
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
    assert result["plan"]["background"]["file"] == plan_import.background_file(
        base64.b64decode(result["background_image"]["data_base64"]), "svg"
    )
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


def _office_entities(hass: HomeAssistant, entry_id: str) -> list[str]:
    registry = er.async_get(hass)
    return sorted(
        e.entity_id for e in er.async_entries_for_config_entry(registry, entry_id) if "_office_" in e.unique_id
    )


def _office_device(hass: HomeAssistant, entry_id: str) -> Any:
    return dr.async_get(hass).async_get_device_by_identifier(("outglow", f"{entry_id}_office"), entry_id)


async def test_a_model_save_overtaken_by_a_scheduled_one_still_writes_at_once(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, _client = ready
    await hass.async_block_till_done()
    real = coordinator._model_data
    overtaken: list[bool] = []

    def model_data() -> Callable[[], dict[str, Any]]:
        data = real()
        if overtaken:
            return data

        async def schedule() -> None:
            coordinator.schedule_save_model()

        def serialise() -> dict[str, Any]:
            overtaken.append(True)
            asyncio.run_coroutine_threadsafe(schedule(), hass.loop).result(5)
            return data()

        return serialise

    coordinator._model_data = model_data  # type: ignore[method-assign]
    hass_storage.pop(MODEL_KEY, None)
    await coordinator.async_save_model()
    assert overtaken == [True]
    assert hass_storage[MODEL_KEY]["data"]["seq"] == coordinator.model.book["seq"]


async def test_an_unreadable_plan_keeps_every_room_and_a_copy_to_import(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, client = ready
    entry = coordinator.entry
    await coordinator.async_update_settings(
        lambda s: replace(s, rooms={**s.rooms, "office": RoomSettings(hold_time_s=120)})
    )
    registry = er.async_get(hass)
    uid = f"{entry.entry_id}_office_occupancy"
    old = registry.async_get_entity_id("binary_sensor", DOMAIN, uid)
    assert old is not None
    registry.async_update_entity(old, new_entity_id="binary_sensor.my_office")
    before = _office_entities(hass, entry.entry_id)
    assert len(before) == 5
    assert await hass.config_entries.async_unload(entry.entry_id)
    stored = json.loads(json.dumps(hass_storage[PLAN_KEY]))
    hass_storage[PLAN_KEY] = {**stored, "data": {**stored["data"], "rooms": [{"id": 5}]}}
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    fresh = entry.runtime_data
    assert fresh.plan.rooms == ()
    assert _office_entities(hass, entry.entry_id) == before
    assert registry.async_get("binary_sensor.my_office") is not None
    assert _office_device(hass, entry.entry_id) is not None
    copies = [key for key in hass_storage if key.startswith(f"{PLAN_KEY}.corrupt-")]
    assert len(copies) == 1
    assert hass_storage[copies[0]]["data"]["rooms"] == [{"id": 5}]
    issues = {key for d, key in ir.async_get(hass).issues if d == DOMAIN}
    assert "plan_unreadable" in issues
    assert "plan_missing" not in issues
    issue = ir.async_get(hass).async_get_issue(DOMAIN, "plan_unreadable")
    assert issue is not None
    assert (issue.translation_placeholders or {})["path"].endswith(copies[0])
    assert (await client.ok("outglow/settings/get"))["rooms"]["office"]["hold_time_s"] == 120
    repaired = {**stored, "key": copies[0]}
    imported = await client.ok("outglow/plan/import", format="outglow_json", text=json.dumps(repaired))
    assert [room["id"] for room in imported["plan"]["rooms"]] == ["living", "hall", "office"]
    await client.ok("outglow/plan/save", rev=fresh.plan.rev, plan=imported["plan"])
    await hass.async_block_till_done()
    assert hass_storage[PLAN_KEY]["data"]["rooms"][2]["id"] == "office"
    assert registry.async_get("binary_sensor.my_office") is not None
    assert fresh.settings.rooms["office"].hold_time_s == 120
    assert "plan_unreadable" not in {key for d, key in ir.async_get(hass).issues if d == DOMAIN}


def _slow_successor(monkeypatch: pytest.MonkeyPatch) -> tuple[threading.Event, threading.Event]:
    gate, entered = threading.Event(), threading.Event()
    real = coordinator_module._successor

    def slow(*args: Any) -> Any:
        entered.set()
        gate.wait(10)
        return real(*args)

    monkeypatch.setattr(coordinator_module, "_successor", slow)
    return gate, entered


async def _start_dropping_office(client: Client, entered: threading.Event) -> None:
    plan = plan_json(1)
    small = {**plan, "rooms": plan["rooms"][:2], "adjacent": [["living", "hall"]]}
    await client.ws.send_json_auto_id({"type": "outglow/plan/save", "rev": 1, "plan": small})
    assert await asyncio.get_running_loop().run_in_executor(None, entered.wait, 10)


@pytest.mark.parametrize("reload", [False, True])
async def test_unloading_during_a_plan_rebuild_waits_for_it(
    hass: HomeAssistant,
    ready: tuple[OutglowCoordinator, Client],
    hass_storage: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    reload: bool,
) -> None:
    coordinator, client = ready
    entry = coordinator.entry
    assert _office_entities(hass, entry.entry_id)
    gate, entered = _slow_successor(monkeypatch)
    await _start_dropping_office(client, entered)
    if reload:
        task = hass.async_create_task(hass.config_entries.async_reload(entry.entry_id))
    else:
        task = hass.async_create_task(hass.config_entries.async_unload(entry.entry_id))
    await asyncio.sleep(0.1)
    gate.set()
    reply = await client.ws.receive_json()
    assert reply["success"], reply
    assert reply["result"]["rev"] == 2
    assert await task
    await hass.async_block_till_done()
    assert hass_storage[PLAN_KEY]["data"]["rev"] == 2
    assert _office_entities(hass, entry.entry_id) == []
    assert _office_device(hass, entry.entry_id) is None
    if not reload:
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    fresh = entry.runtime_data
    assert fresh is not coordinator
    assert (fresh.plan.rev, [room.id for room in fresh.plan.rooms]) == (2, ["living", "hall"])
    assert _office_entities(hass, entry.entry_id) == []
    assert (await client.ok("outglow/plan/get"))["rev"] == 2


async def test_setup_removes_the_entities_of_rooms_no_longer_in_the_plan(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, _client = ready
    entry = coordinator.entry
    assert await hass.config_entries.async_unload(entry.entry_id)
    plan = plan_json(1)
    hass_storage[PLAN_KEY]["data"] = {
        **plan,
        "rooms": plan["rooms"][:2],
        "adjacent": [["living", "hall"]],
        "retired_rooms": ["office"],
    }
    assert _office_entities(hass, entry.entry_id)
    assert _office_device(hass, entry.entry_id) is not None
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert _office_entities(hass, entry.entry_id) == []
    assert _office_device(hass, entry.entry_id) is None
    living = [
        e for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id) if "_living_" in e.unique_id
    ]
    assert len(living) == 5


def store_over_limit(hass_storage: dict[str, Any]) -> dict[str, Any]:
    stored = plan_json(3)
    extra = [
        {"id": f"x{i}", "name": f"X{i}", "outline": [[20 + i, 0], [20.5 + i, 0], [20.5 + i, 1]], "colour": "#000000"}
        for i in range(plan_import.MAX_ROOMS)
    ]
    stored["rooms"] = [*stored["rooms"], *extra]
    hass_storage[PLAN_KEY] = {"version": 1, "minor_version": 2, "key": PLAN_KEY, "data": stored}
    return stored


def sensed(coordinator: OutglowCoordinator) -> tuple[str | None, tuple[str, ...], int]:
    return coordinator.plan_problem, coordinator.engine.topology.rooms, len(coordinator.engine.topology.bulbs)


async def test_a_stored_plan_over_the_limits_starts_without_sensing_and_asks_to_simplify(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], hass_ws_client: WebSocketGenerator
) -> None:
    stored = store_over_limit(hass_storage)
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    rooms = len(stored["rooms"])
    problem = f"The plan has too many rooms: {rooms}, at most {plan_import.MAX_ROOMS}"
    assert sensed(coordinator) == (problem, (), 0)
    issues = ir.async_get(hass)
    issue = issues.async_get_issue(DOMAIN, "plan_too_large")
    assert issue is not None
    assert issue.translation_placeholders == {"problem": problem}
    assert issues.async_get_issue(DOMAIN, "plan_incomplete") is None
    client = Client(await hass_ws_client(hass))
    got = await client.ok("outglow/plan/get")
    assert len(got["plan"]["rooms"]) == rooms
    refused = await client.error("outglow/plan/save", "invalid_format", rev=got["rev"], plan=got["plan"])
    assert refused["error"]["message"] == problem
    simpler = {**got["plan"], "rooms": got["plan"]["rooms"][:3]}
    await client.ok("outglow/plan/save", rev=got["rev"], plan=simpler)
    await hass.async_block_till_done()
    assert sensed(coordinator) == (None, ("living", "hall", "office"), len(stored["bulbs"]))
    assert issues.async_get_issue(DOMAIN, "plan_too_large") is None


async def test_over_the_limits_history_and_session_summary_build_no_engine_from_the_plan(
    hass: HomeAssistant,
    mqtt_mock: MqttMockHAClient,
    hass_storage: dict[str, Any],
    hass_ws_client: WebSocketGenerator,
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store_over_limit(hass_storage)
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    for ieee, name in BULBS.items():
        fire(hass, name, bulb_state(ieee, activity=200, motion=True))
    await hass.async_block_till_done()
    clock.advance(1)
    coordinator.tick()
    real = Engine
    built: list[int] = []

    def spy(plan: Plan, *args: Any, **kwargs: Any) -> Any:
        built.append(len(plan.rooms) + len(plan.bulbs))
        return real(plan, *args, **kwargs)

    monkeypatch.setattr(session_module, "Engine", spy)
    client = Client(await hass_ws_client(hass))
    got = await client.ok("outglow/history/frames", start=clock() - 2, end=clock())
    assert all(frame["rooms"] == {} for frame in got["frames"])
    await coordinator.sessions.async_start("S", False)
    clock.advance(30)
    await coordinator.sessions.async_label("room", "living", "walk", None)
    clock.advance(30)
    stopped = await coordinator.sessions.async_stop()
    assert built
    assert set(built) == {0}
    assert stopped["summary"]["rooms"] == []
    assert stopped["summary"]["pending_id"] is None


async def test_over_the_limits_the_home_entities_say_so(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    store_over_limit(hass_storage)
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    clock.advance(1)
    coordinator.tick()
    await hass.async_block_till_done()
    states = {
        entity: getattr(hass.states.get(entity), "state", None)
        for entity in ("binary_sensor.outglow_home_motion", "sensor.outglow_motion_room", "sensor.outglow_status")
    }
    assert states == {
        "binary_sensor.outglow_home_motion": "unavailable",
        "sensor.outglow_motion_room": "unavailable",
        "sensor.outglow_status": "plan_too_large",
    }
    got = await coordinator.async_save_plan(coordinator.plan.rev, from_json(Plan, plan_json(coordinator.plan.rev)))
    assert got
    clock.advance(1)
    coordinator.tick()
    await hass.async_block_till_done()
    assert hass.states.get("binary_sensor.outglow_home_motion").state == "off"  # type: ignore[union-attr]
    assert hass.states.get("sensor.outglow_motion_room").state == "none"  # type: ignore[union-attr]
    assert hass.states.get("sensor.outglow_status").state == "learning"  # type: ignore[union-attr]


async def test_over_the_limits_learning_and_calibration_wait(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    store_over_limit(hass_storage)
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    before = coordinator.engine.model_state()
    coordinator.engine.context(Context(t=clock(), house_empty="yes"))
    for _ in range(600):
        clock.advance(coordinator.settings.global_.tick_s)
        coordinator.tick()
    label = Label(t0=clock() - 60, t1=clock() - 1, kind="room", room="living", source="feedback", weight=1.0)
    assert await coordinator.async_add_labels([label], background=False) is None
    result = await coordinator.async_calibrate()
    assert result.rooms == {}
    assert coordinator.engine.pending_id() is None
    assert coordinator.engine.model_state() == before
    assert coordinator.model.book.get("last_calibration") is None
    assert await pending_labels(hass, coordinator) == []
