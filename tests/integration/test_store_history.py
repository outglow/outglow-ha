from pathlib import Path
from typing import Any

import pytest
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import MqttMockHAClient

from custom_components.outglow.const import CONF_BASE_TOPIC, DOMAIN
from custom_components.outglow.engine import Engine
from custom_components.outglow.engine.types import HistoryEvent, Label, LinkReading, Observation, Retention
from custom_components.outglow.history import History, series
from custom_components.outglow.store import MODEL_KEY, PLAN_KEY, RUNTIME_KEY, SETTINGS_KEY, SNAPSHOTS_KEY
from tests.integration.common import BASE, Clock, plan_json, setup_outglow, with_plan

HOUR = 3600.0
DAY = 86400.0


async def test_plan_and_model_migrate_from_minor_one(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    old_plan = plan_json(4)
    old_plan["bulbs"][0]["ieee"] = "0x00000000000000AB"
    old_plan["legacy"] = {"pixels": True}
    hass_storage[PLAN_KEY] = {"version": 1, "minor_version": 1, "key": PLAN_KEY, "data": old_plan}
    hass_storage[MODEL_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": MODEL_KEY,
        "data": {"state": {"format": 1}, "version": 5},
    }
    hass_storage[SETTINGS_KEY] = {"version": 1, "key": SETTINGS_KEY, "data": {"rooms": {}, "global": {"tick_s": 1}}}
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: BASE}, unique_id=BASE)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    coordinator = entry.runtime_data
    assert coordinator.plan.rev == 4
    assert coordinator.plan.bulbs[0].ieee == "0x00000000000000ab"
    assert coordinator.model_version == 5
    assert coordinator.model.engine_state() == {"active": {"model_version": 5}}
    assert coordinator.model_summary()["labels"] == {}
    assert coordinator.settings.global_.tick_s == 1.0
    assert set(coordinator.settings.rooms) == {"living", "hall", "office"}
    assert coordinator.engine.tick(clock()).model_version == 5


async def test_state_survives_a_reload(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    label = Label(t0=clock() - 20, t1=clock(), kind="room", room="hall", activity="walk", source="service")
    pending = await coordinator.async_add_labels([label], background=False)
    assert pending is not None
    await coordinator.async_apply(pending)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    again = entry.runtime_data
    assert again.plan.rev == 1
    assert again.model_version == 1
    assert again.model_summary()["updated"] == clock()
    assert [s["reason"] for s in again.model.snapshot_list()] == ["before_apply"]
    assert hass_storage[PLAN_KEY]["minor_version"] == 2


def test_history_retention_and_series(tmp_path: Path) -> None:
    history = History(tmp_path / "history.db")
    history.open()
    now = 10 * DAY
    for age in (0.5 * HOUR, 47 * HOUR, 49 * HOUR):
        history.add_record(
            Observation(t=now - age, rx="0x0000000000000001", links=(LinkReading(tx="0x0000000000000002"),))
        )
    for age in (DAY, 15 * DAY):
        history.add_tick(now - age, {"living": [0.5, True]}, [])
    for age in (DAY, 366 * DAY):
        history.add_event(HistoryEvent(t=now - age, kind="motion_on", room="living"))
    history.flush()
    assert history.copy_to_empty(now - 48 * HOUR, now) == 2
    history.copy_to_empty(now - 3 * DAY, now - 2.5 * DAY)
    history.copy_to_empty(now - 2 * HOUR, now - HOUR)
    assert history.empty_spans(now - 2 * DAY, now) == [(now - 48 * HOUR, now)]
    assert history.empty_spans(0, now)[0] == (now - 3 * DAY, now - 2.5 * DAY)
    history.purge(Retention(), now)
    counts = history.counts()
    assert counts == {"raw": 2, "empty_raw": 2, "ticks": 1, "events": 1, "labels": 0}
    history.purge(Retention(raw_h=1, empty_raw_d=1, ticks_d=1, events_d=1), now + 1)
    assert history.counts()["raw"] == 1
    assert history.counts()["empty_raw"] == 1
    assert history.empty_spans(0, now) == [(now - 48 * HOUR, now)]
    observations = list(history.iter_observations(0, now, "empty_raw"))
    assert [o.rx for o in observations] == ["0x0000000000000001"]
    assert observations[0].links[0].tx == "0x0000000000000002"
    history.add_labels([Label(t0=1, t1=2, kind="empty")], "pending", "p-1")
    history.set_label_status("p-1", "applied")
    assert history.labels(0, 10, "applied") == [Label(t0=1, t1=2, kind="empty")]
    history.clear_motion()
    assert history.empty_spans(0, now) == []
    assert history.counts() == {"raw": 0, "empty_raw": 0, "ticks": 0, "events": 0, "labels": 1}
    history.close()
    rooms, pairs = series(
        [(0.0, {"a": [0.2, False]}, [["x", "y", 1]]), (5.0, {"a": [0.6, True]}, []), (25.0, {"a": [0.1, False]}, [])],
        0.0,
        40.0,
        10.0,
        ["a", "b"],
        True,
    )
    assert rooms == {"a": [[0.0, 0.6, True], [10.0, 0.0, False], [20.0, 0.1, False], [30.0, 0.0, False]], "b": []}
    assert pairs == [{"a": "x", "b": "y", "samples": [[0.0, 1], [10.0, None]]}]


def _stored(key: str, data: dict[str, Any]) -> dict[str, Any]:
    return {"version": 1, "minor_version": 1, "key": key, "data": data}


async def test_ids_stay_unique_after_a_restart(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    snapshot = {"t": clock() - 10, "reason": "before_session", "model_version": 0, "state": {}}
    hass_storage[MODEL_KEY] = _stored(MODEL_KEY, {"engine": None, "seq": 0})
    hass_storage[SNAPSHOTS_KEY] = _stored(
        SNAPSHOTS_KEY,
        {
            "snapshots": [
                {**snapshot, "snapshot_id": "m-0001"},
                {**snapshot, "snapshot_id": "m-0001", "t": clock() - 5},
                {**snapshot, "snapshot_id": "m-0003"},
            ]
        },
    )
    session = {"session_id": "s-0004", "name": "Old", "started": clock() - 100, "state": "stopped"}
    hass_storage[RUNTIME_KEY] = _stored(
        RUNTIME_KEY, {"session": {**session, "raised_rate": False, "steps": [], "summary": None}}
    )
    _entry, coordinator = await setup_outglow(hass, clock)
    await with_plan(hass, coordinator)
    ids = [item["snapshot_id"] for item in coordinator.model.snapshot_list()]
    assert len(set(ids)) == len(ids) == 3
    started = await coordinator.sessions.async_start("New", False)
    assert started["session_id"] not in {"s-0001", "s-0004"}
    ids = [item["snapshot_id"] for item in coordinator.model.snapshot_list()]
    assert len(set(ids)) == len(ids) == 4
    for snapshot_id in ids:
        await coordinator.async_rollback(snapshot_id)
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STOP)
    await hass.async_block_till_done()
    assert hass_storage[MODEL_KEY]["data"]["seq"] >= max(int(i.split("-")[1]) for i in ids)


async def test_stopping_home_assistant_saves_the_model_and_the_history(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass, clock)
    await with_plan(hass, coordinator)
    await coordinator.async_flush_history()
    coordinator.event("correct", "living", {"source": "test"})
    coordinator.model.next_seq()
    hass_storage.pop(MODEL_KEY, None)
    hass.bus.async_fire(EVENT_HOMEASSISTANT_STOP)
    await hass.async_block_till_done()
    assert hass_storage[MODEL_KEY]["data"]["seq"] == coordinator.model.book["seq"]
    reader = History(coordinator.history.path)
    await hass.async_add_executor_job(reader.open)
    events = await hass.async_add_executor_job(reader.events, 0, clock() + 1, ["correct"])
    await hass.async_add_executor_job(reader.close)
    assert [e.room for e in events] == ["living"]


def test_iter_records_pages_through_equal_times(tmp_path: Path) -> None:
    history = History(tmp_path / "h.db")
    history.open()
    for i in range(7):
        history.add_record(Observation(t=100.0 + (i // 3), rx=f"0x{i:016x}"))
    history.flush()
    paged = list(history.iter_records(100.0, 102.0, chunk=2))
    assert paged == history.records(100.0, 102.0)
    assert len(paged) == 7
    assert list(history.iter_observations(101.0, 101.0)) == history.records(101.0, 101.0)
    history.close()


async def test_export_and_calibration_stream_from_the_history(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _entry, coordinator = await setup_outglow(hass, clock)
    await with_plan(hass, coordinator)
    for i in range(30):
        coordinator.observe(Observation(t=clock() + i, rx="0x0000000000000001"))
    await coordinator.async_copy_empty(clock(), clock() + 3600)
    clock.advance(3600)

    def whole(*_args: Any) -> Any:
        raise AssertionError("loaded the whole range")

    monkeypatch.setattr(History, "records", whole)
    seen: list[type] = []
    calibrate = Engine.calibrate

    def spy(self: Engine, samples: Any, t: float, intervals: Any = None) -> Any:
        seen.append(type(samples))
        return calibrate(self, samples, t, intervals)

    monkeypatch.setattr(Engine, "calibrate", spy)
    await coordinator.async_calibrate()
    assert seen
    assert list not in seen
    start = dt_util.utc_from_timestamp(clock() - 7200).isoformat()
    end = dt_util.utc_from_timestamp(clock()).isoformat()
    result = await hass.services.async_call(
        DOMAIN, "export_recording", {"start": start, "end": end}, blocking=True, return_response=True
    )
    assert result is not None
    assert result["records"] == 30


def _steps(history: History, t0: float, t1: float, chunk: int) -> tuple[list[Any], int]:
    db = history._conn()
    count = [0]

    def tick() -> int:
        count[0] += 1
        return 0

    db.set_progress_handler(tick, 100)
    try:
        return list(history.iter_records(t0, t1, chunk=chunk)), count[0]
    finally:
        db.set_progress_handler(None, 0)


def test_iter_records_reads_each_row_once(tmp_path: Path) -> None:
    history = History(tmp_path / "h.db")
    history.open()
    for i in range(8000):
        history.add_record(Observation(t=1000.0 + i // 4, rx=f"0x{i % 7:016x}"))
    history.flush()
    small, small_steps = _steps(history, 1000.0, 1999.0, 50)
    large, large_steps = _steps(history, 1000.0, 2999.0, 50)
    assert small == history.records(1000.0, 1999.0)
    assert large == history.records(1000.0, 2999.0)
    assert [len(small), len(large)] == [4000, 8000]
    assert large_steps < 2.5 * small_steps
    assert list(history.iter_records(1500.0, 1500.0, chunk=3)) == history.records(1500.0, 1500.0)
    history.close()
