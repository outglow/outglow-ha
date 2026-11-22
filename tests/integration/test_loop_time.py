import asyncio
import copy
import gc
import math
import os
import random
import statistics
import threading
import time
from collections.abc import Callable, Coroutine, Iterator, Mapping
from contextlib import contextmanager
from typing import Any

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import storage
from homeassistant.helpers.json import json_bytes
from homeassistant.util.json import json_loads
from pytest_homeassistant_custom_component.typing import MqttMockHAClient, WebSocketGenerator

from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine.defaults import CFAR_REFRESH_S, HIST_BINS
from custom_components.outglow.engine.model import Hist, RoomCal
from custom_components.outglow.engine.types import LinkReading, Observation
from custom_components.outglow.store import MODEL_KEY, SNAPSHOTS_KEY
from tests.integration.common import Clock, bridge, plan_json, setup_outglow, with_plan
from tests.integration.test_websocket import Client

BULB_COUNT = 30
LOOP_BUDGET_MS = 20.0
TICK_BUDGET_MS = 5.0
SCALE_ENV = "OUTGLOW_LOOP_TIME_SCALE"


def _budgets(env: Mapping[str, str]) -> tuple[float, float]:
    scale = float(env.get(SCALE_ENV, "1"))
    if not (math.isfinite(scale) and scale > 0):
        raise ValueError(f"{SCALE_ENV} must be a positive number, not {scale}")
    return LOOP_BUDGET_MS * scale, TICK_BUDGET_MS * scale


def test_the_budgets_scale_for_slow_machines() -> None:
    assert _budgets({}) == (LOOP_BUDGET_MS, TICK_BUDGET_MS)
    assert _budgets({SCALE_ENV: "2.5"}) == (50.0, 12.5)
    for bad in ("0", "-1", "nan", "inf"):
        with pytest.raises(ValueError, match=SCALE_ENV):
            _budgets({SCALE_ENV: bad})


def _plan(rooms: int) -> dict[str, Any]:
    width = 7.0 / rooms
    return {
        **plan_json(1),
        "rooms": [
            {
                "id": f"room{i}",
                "name": f"Room {i}",
                "outline": [[i * width, 0], [(i + 1) * width, 0], [(i + 1) * width, 7], [i * width, 7]],
                "colour": "#4e9af1",
                "area_id": None,
                "entrance": i == 0,
            }
            for i in range(rooms)
        ],
        "adjacent": [[f"room{i}", f"room{i + 1}"] for i in range(rooms - 1)],
        "bulbs": [
            {"ieee": f"0x{n + 1:016x}", "x": 0.2 + (n % 6) * 1.1, "y": 0.2 + (n // 6) * 1.2, "height": "ceiling"}
            for n in range(BULB_COUNT)
        ],
    }


def _learn(coordinator: OutglowCoordinator) -> None:
    engine, rng = coordinator.engine, random.Random(1)
    topo, model = engine.topology, engine._active
    for d in topo.directions:
        model.hist[d] = Hist([rng.uniform(0, 40) if i < 30 else 0.0 for i in range(HIST_BINS)], rng.random())
        model.bg_onsets[d] = rng.random()
    model.bg_ticks = 20000.0
    for p in topo.pairs:
        model.pair_bg[p] = [rng.uniform(100, 1000), rng.uniform(0, 30), rng.uniform(0, 5)]
        for r in topo.rooms:
            model.emit[(p, r)] = [rng.uniform(0, 100), rng.uniform(0, 40), rng.uniform(0, 30)]
    for r in topo.rooms:
        model.rooms[r] = RoomCal(a_on=0.7, false_per_day=0.1, detection=0.9)
        model.entries[r] = [rng.random() for _ in range(50)]
    engine._pending = model.clone()
    engine._pending_seq = 1


def _stored_off_the_loop(hass: HomeAssistant, hass_storage: dict[str, Any], monkeypatch: pytest.MonkeyPatch) -> None:
    def prepare(data: dict[str, Any]) -> Any:
        if "data_func" in data:
            data["data"] = data.pop("data_func")()
        return json_loads(json_bytes(data))

    def patch(store: storage.Store[Any]) -> None:
        async def write(data: dict[str, Any]) -> None:
            hass_storage[store.key] = await hass.async_add_executor_job(prepare, data)

        async def load() -> Any:
            stored = hass_storage.get(store.key)
            return None if stored is None else await hass.async_add_executor_job(copy.deepcopy, stored["data"])

        monkeypatch.setattr(store, "_async_write_data", write)
        monkeypatch.setattr(store, "_async_load", load)

    original = storage.Store.__init__

    def init(self: storage.Store[Any], *args: Any, **kwargs: Any) -> None:
        original(self, *args, **kwargs)
        if self.key in (MODEL_KEY, SNAPSHOTS_KEY):
            patch(self)

    monkeypatch.setattr(storage.Store, "__init__", init)


class Cpu:
    def __init__(self) -> None:
        self.thread = threading.get_ident()
        self.collecting = 0.0
        self.collected = 0.0

    def __enter__(self) -> Cpu:
        gc.callbacks.append(self.collection)
        return self

    def __exit__(self, *_: object) -> None:
        gc.callbacks.remove(self.collection)

    def collection(self, phase: str, _info: dict[str, int]) -> None:
        if threading.get_ident() == self.thread:
            now = time.thread_time()
            if phase == "start":
                self.collecting = now
            else:
                self.collected += now - self.collecting

    def mark(self) -> tuple[float, float]:
        return time.thread_time(), self.collected

    def since(self, mark: tuple[float, float]) -> float:
        return (time.thread_time() - mark[0] - (self.collected - mark[1])) * 1000


class Meter:
    def __init__(self) -> None:
        self.worst = 0.0
        self.where = ""

    def add(self, spent: float, where: str) -> None:
        if spent > self.worst:
            self.worst, self.where = spent, where


@pytest.fixture
def cpu() -> Iterator[Cpu]:
    with Cpu() as meter:
        yield meter


@contextmanager
def _metered(monkeypatch: pytest.MonkeyPatch, cpu: Cpu) -> Iterator[Meter]:
    meter = Meter()
    run = asyncio.Handle._run
    test = asyncio.current_task()

    def timed(handle: asyncio.Handle) -> None:
        mark = cpu.mark()
        try:
            run(handle)
        finally:
            if getattr(getattr(handle, "_callback", None), "__self__", None) is not test:
                meter.add(cpu.since(mark), repr(handle))

    loop = asyncio.get_running_loop()
    debug = loop.get_debug()
    loop.set_debug(False)
    with monkeypatch.context() as m:
        m.setattr(asyncio.Handle, "_run", timed)
        try:
            yield meter
        finally:
            loop.set_debug(debug)


def _observe(coordinator: OutglowCoordinator, t: float, rng: random.Random) -> None:
    bulbs = [b.ieee for b in coordinator.plan.bulbs]
    for rx in bulbs:
        links = tuple(
            LinkReading(tx=tx, level=rng.randint(0, 30), motion=False, signal_dbm=rng.randint(-90, -60))
            for tx in bulbs
            if tx != rx
        )
        coordinator.observe(Observation(t=t, rx=rx, links=links, occupancy=False, light=None, source="activity"))


@pytest.mark.parametrize("rooms", [3, 6])
async def test_a_learned_house_of_thirty_bulbs_never_holds_the_loop(
    hass: HomeAssistant,
    mqtt_mock: MqttMockHAClient,
    hass_ws_client: WebSocketGenerator,
    hass_storage: dict[str, Any],
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
    cpu: Cpu,
    rooms: int,
) -> None:
    loop_budget, tick_budget = _budgets(os.environ)
    _stored_off_the_loop(hass, hass_storage, monkeypatch)
    entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    await with_plan(hass, coordinator)
    client = Client(await hass_ws_client(hass))
    plan = _plan(rooms)
    assert (await client.ok("outglow/plan/save", rev=1, plan=plan))["rev"] == 2
    _learn(coordinator)
    await coordinator.async_save_model()
    worst: dict[str, Meter] = {}

    async def step(name: str, work: Callable[[], Coroutine[Any, Any, Any]]) -> Any:
        with _metered(monkeypatch, cpu) as meter:
            result: Any = await hass.async_create_task(work())
            await hass.async_block_till_done()
        worst[name] = meter
        return result

    async def reload() -> None:
        assert await hass.config_entries.async_reload(entry.entry_id)

    await step("setup", reload)
    coordinator = entry.runtime_data
    coordinator.clock = clock
    assert coordinator._tick_unsub is not None
    coordinator._tick_unsub()
    coordinator._tick_unsub = None
    assert len(coordinator.engine.topology.directions) == BULB_COUNT * (BULB_COUNT - 1)
    assert coordinator.engine.pending_id() is not None
    rng = random.Random(2)
    ticks: list[float] = []
    for _ in range(round(2.5 * CFAR_REFRESH_S / 0.5)):
        _observe(coordinator, clock.advance(0.4), rng)
        clock.advance(0.1)
        mark = cpu.mark()
        coordinator.tick()
        ticks.append(cpu.since(mark))
    smaller = {**plan, "rooms": plan["rooms"][:-1], "adjacent": plan["adjacent"][:-1]}
    await step("plan_save", lambda: client.ok("outglow/plan/save", rev=2, plan=smaller))
    assert coordinator.model_version == 1
    pending_id = coordinator.engine.pending_id()
    applied = await step("apply", lambda: client.ok("outglow/model/apply", pending_id=pending_id))
    await step("rollback", lambda: client.ok("outglow/model/rollback", snapshot_id=applied["snapshot_id"]))
    await step("reset_room", lambda: client.ok("outglow/model/reset", room=plan["rooms"][0]["id"]))
    await step("reset", lambda: client.ok("outglow/model/reset"))
    assert coordinator.model_version == 5
    report = sorted((round(m.worst, 1), name, m.where[:100]) for name, m in worst.items())
    assert max(ticks) < loop_budget, (max(ticks), report)
    assert statistics.mean(ticks) < tick_budget, (statistics.mean(ticks), report)
    assert all(m.worst < loop_budget for m in worst.values()), report
