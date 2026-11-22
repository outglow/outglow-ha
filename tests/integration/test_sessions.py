import asyncio
from dataclasses import replace
from datetime import timedelta
from typing import Any

import pytest
from homeassistant.components import mqtt
from homeassistant.components.mqtt.const import MQTT_CONNECTION_STATE
from homeassistant.config_entries import ConfigEntryDisabler, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed
from pytest_homeassistant_custom_component.typing import MqttMockHAClient

from custom_components.outglow import leftover
from custom_components.outglow.const import (
    CONF_BASE_TOPIC,
    CONF_LOG_LEVEL,
    DOMAIN,
    ISSUE_RATES_LEFT,
    ISSUE_RATES_WAITING,
    ISSUE_SESSION_RATES,
    SESSION_RATES_REPAIR_S,
)
from custom_components.outglow.engine import Engine, from_json
from custom_components.outglow.engine.defaults import A_ON_START
from custom_components.outglow.engine.types import Plan
from custom_components.outglow.errors import OutglowError
from custom_components.outglow.store import LEFTOVER_KEY, MODEL_KEY, PLAN_KEY, RUNTIME_KEY
from tests.contract import validate
from tests.integration.common import (
    BASE,
    BULBS,
    Clock,
    bridge,
    bulb_state,
    devices_payload,
    fire,
    info_payload,
    pending_labels,
    plan_json,
    setup_outglow,
    with_plan,
)

OPTIONS = f"{BASE}/bridge/request/device/options"


def rate_calls(mqtt_mock: MqttMockHAClient) -> list[str]:
    return [str(c.args[1]) for c in mqtt_mock.async_publish.call_args_list if c.args[0] == OPTIONS]


def _info(rates: dict[str, int | None] | None = None, rate: int = 4) -> dict[str, Any]:
    info = info_payload(rate=rate)
    devices = info["config"]["devices"]
    for ieee, value in (rates or {}).items():
        if value is None:
            del devices[ieee]
        else:
            devices[ieee]["motion_activity_rate"] = value
    return info


async def _z2m(hass: HomeAssistant, rates: dict[str, int | None] | None = None, rate: int = 4) -> None:
    fire(hass, "bridge/info", _info(rates, rate))
    fire(hass, "bridge/state", {"state": "online"})
    await hass.async_block_till_done()


async def _ready(hass: HomeAssistant, rate: int | None = 2) -> Any:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass, rate=rate)
    await with_plan(hass, coordinator)
    for ieee, name in BULBS.items():
        fire(hass, name, bulb_state(ieee))
    await hass.async_block_till_done()
    return coordinator


async def test_session_steps_become_pending_labels(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    coordinator = await _ready(hass)
    session = await coordinator.sessions.async_start("Evening", False)
    validate("session.json", session)
    assert session["raised_rate"] is False
    with pytest.raises(OutglowError) as busy:
        await coordinator.sessions.async_start("Again", False)
    assert busy.value.code == "busy"
    with pytest.raises(OutglowError) as missing:
        await coordinator.sessions.async_label("room", "attic", "walk", None)
    assert missing.value.code == "not_found"
    await coordinator.sessions.async_label("empty", None, "any", None)
    clock.advance(600)
    await coordinator.sessions.async_label("room", "living", "walk", clock() - 0.2)
    clock.advance(60)
    await coordinator.sessions.async_label("room", "living", "still", None)
    clock.advance(20)
    await coordinator.sessions.async_label("transition", "hall", "any", None)
    clock.advance(2)
    await coordinator.sessions.async_label("transition", None, "any", None)
    with pytest.raises(OutglowError):
        await coordinator.sessions.async_label("room", None, "walk", None)
    clock.advance(5)
    stopped = await coordinator.sessions.async_stop()
    validate("session.json", stopped)
    summary = stopped["summary"]
    assert summary["rooms"] == ["living", "hall", "office"]
    assert summary["matrix_before"][0] == [0, 0, 0, 121]
    assert summary["accuracy_before"] == 0.0
    assert summary["mode"] == "rules"
    assert summary["matrix_after"] == summary["matrix_before"]
    assert summary["bayes"]["matrix_before"][0] == [0, 0, 0, 121]
    assert summary["rooms_without_bulbs"] == []
    assert summary["pending_id"] == coordinator.engine.pending_id()
    labels = await pending_labels(hass, coordinator)
    assert [(lb.kind, lb.room, lb.activity, lb.weight) for lb in labels] == [
        ("empty", None, "any", 1.0),
        ("room", "living", "walk", 1.0),
        ("room", "living", "still", 0.5),
        ("transition", "hall", "any", 1.0),
        ("transition", None, "any", 1.0),
    ]
    assert labels[0].t1 - labels[0].t0 == 600 - 240
    await coordinator.async_flush_history()
    events = await hass.async_add_executor_job(coordinator.history.events, 0, clock() + 1, ["label"])
    assert [(e.t, e.room, e.data["activity"]) for e in events] == [(lb.t0, lb.room, lb.activity) for lb in labels]
    assert coordinator.sessions.delays == [pytest.approx(0.2)]
    assert (await coordinator.async_quality(1)).days == 1
    with pytest.raises(OutglowError) as none:
        await coordinator.sessions.async_stop()
    assert none.value.code == "no_session"
    assert rate_calls(mqtt_mock) == []


async def test_summary_counts_the_empty_house_learned_in_the_background(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await coordinator.sessions.async_start("Evening", False)
    state = coordinator.engine.model_state()
    active = state["active"]
    assert isinstance(active, dict)
    coordinator.engine = Engine(
        coordinator.plan, coordinator.settings, {**state, "pending": {**active, "empty_s": 3 * 3600.0}}
    )
    coordinator.engine.context(coordinator._context(coordinator.now()))
    await coordinator.sessions.async_label("room", "living", "walk", None)
    clock.advance(60)
    stopped = await coordinator.sessions.async_stop()
    validate("session.json", stopped)
    assert stopped["summary"]["empty_house_hours"] == 3.0
    assert stopped["summary"]["empty_setup"] == "persons"


async def _ticks(hass: HomeAssistant, coordinator: Any, clock: Clock, seconds: float) -> None:
    for _ in range(int(2 * seconds)):
        clock.advance(0.5)
        coordinator.tick()
    await hass.async_block_till_done()


async def test_summary_hours_of_a_soft_absence_with_an_empty_step_are_what_apply_gives(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    hass.states.async_set("person.a", "not_home")
    coordinator = await _ready(hass)
    await coordinator.async_update_settings(
        lambda s: replace(
            s, global_=replace(s.global_, use_persons=True, persons=("person.a",), others_may_be_home=True)
        )
    )
    await coordinator.sessions.async_start("Away", False)
    await coordinator.sessions.async_label("empty", None, "any", None)
    await _ticks(hass, coordinator, clock, 1800)
    hass.states.async_set("person.a", "home")
    await _ticks(hass, coordinator, clock, 1)
    stopped = await coordinator.sessions.async_stop()
    hours = stopped["summary"]["empty_house_hours"]
    await _ticks(hass, coordinator, clock, 5)
    pending = coordinator.engine.model_state()["pending"]
    assert hours == round(pending["empty_s"] / 3600, 3)
    assert hours < 1800 / 3600


async def test_raised_rate_is_restored_after_thirty_minutes(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    coordinator = await _ready(hass, rate=None)
    session = await coordinator.sessions.async_start("Long", True)
    assert session["raised_rate"] is True
    assert len(rate_calls(mqtt_mock)) == 4
    assert coordinator.sessions.rate_restore == dict.fromkeys(BULBS, 0.0)
    await _z2m(hass, {"0x0000000000000003": 7})
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1801))
    await hass.async_block_till_done()
    restored = rate_calls(mqtt_mock)[4:]
    others = [ieee for ieee in sorted(BULBS) if ieee != "0x0000000000000003"]
    assert [call.split('"')[3] for call in restored] == others
    assert all('"motion_activity_rate":0}' in call for call in restored)
    assert coordinator.sessions.rate_restore == dict.fromkeys(others, 0.0)
    await _z2m(hass, {"0x0000000000000003": 7}, rate=0)
    assert coordinator.sessions.rate_restore == {}
    assert len(rate_calls(mqtt_mock)) == 7
    assert coordinator.sessions.session is not None
    assert coordinator.sessions.session["state"] == "running"


async def test_rate_is_restored_after_a_restart(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    hass_storage[RUNTIME_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": RUNTIME_KEY,
        "data": {
            "session": {
                "session_id": "s-0001",
                "name": "Interrupted",
                "started": clock() - 100,
                "state": "running",
                "raised_rate": True,
                "steps": [
                    {"index": 0, "kind": "room", "room": "living", "activity": "walk", "t0": clock() - 90, "t1": None}
                ],
                "summary": None,
            },
            "rate_restore": {"0x0000000000000001": 2, "0x0000000000000002": 1, "0x0000000000000003": None},
            "rate_until": clock() + 1000,
        },
    }
    hass_storage[PLAN_KEY] = {"version": 1, "minor_version": 2, "key": PLAN_KEY, "data": plan_json()}
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: BASE}, unique_id=BASE)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock) == []
    assert set(hass_storage[RUNTIME_KEY]["data"]["rate_restore"]) == {
        "0x0000000000000001",
        "0x0000000000000002",
        "0x0000000000000003",
    }
    fire(hass, "bridge/devices", devices_payload())
    fire(hass, "bridge/state", {"state": "offline"})
    fire(hass, "bridge/info", _info({"0x0000000000000002": 7}))
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock) == []
    fire(hass, "bridge/state", {"state": "online"})
    await hass.async_block_till_done()
    calls = rate_calls(mqtt_mock)
    assert calls == [
        '{"id":"0x0000000000000001","options":{"motion_activity_rate":2}}',
        '{"id":"0x0000000000000003","options":{"motion_activity_rate":0}}',
    ]
    coordinator = entry.runtime_data
    assert coordinator.devices.activity_rate("0x0000000000000002") == 7
    fire(hass, "bridge/info", _info({"0x0000000000000002": 7}))
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock) == calls
    assert set(hass_storage[RUNTIME_KEY]["data"]["rate_restore"]) == {"0x0000000000000001", "0x0000000000000003"}
    await _z2m(hass, {"0x0000000000000001": 2, "0x0000000000000002": 7, "0x0000000000000003": 0})
    assert rate_calls(mqtt_mock) == calls
    session = coordinator.sessions.get()
    assert session is not None
    assert session["state"] == "stopped"
    assert session["steps"][0]["t1"] == clock()
    assert [lb.room for lb in (await pending_labels(hass, coordinator))] == ["living"]
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == {}


def _runtime(clock: Clock, restore: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": 1,
        "minor_version": 1,
        "key": RUNTIME_KEY,
        "data": {"session": None, "rate_restore": restore, "rate_until": clock() + 1000},
    }


async def test_restore_survives_a_broker_that_is_away_at_startup(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    hass_storage[RUNTIME_KEY] = _runtime(clock, {"0x0000000000000001": 2})
    mqtt_mock.async_publish.side_effect = HomeAssistantError("not connected")
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: BASE}, unique_id=BASE)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.LOADED
    coordinator = entry.runtime_data
    await _z2m(hass)
    assert coordinator.sessions.rate_restore == {"0x0000000000000001": 2.0}
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=31))
    await hass.async_block_till_done()
    assert coordinator.sessions.rate_restore == {"0x0000000000000001": 2.0}
    mqtt_mock.async_publish.side_effect = None
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=62))
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock)[-1] == '{"id":"0x0000000000000001","options":{"motion_activity_rate":2}}'
    assert coordinator.sessions.rate_restore == {"0x0000000000000001": 2.0}
    await _z2m(hass, {"0x0000000000000001": 2})
    assert coordinator.sessions.rate_restore == {}
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == {}


async def test_no_raise_while_the_previous_rate_is_unknown(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    fire(hass, "bridge/devices", devices_payload())
    await with_plan(hass, coordinator)
    for ieee, name in BULBS.items():
        fire(hass, name, bulb_state(ieee))
    await hass.async_block_till_done()
    session = await coordinator.sessions.async_start("Blind", True)
    assert session["raised_rate"] is False
    assert rate_calls(mqtt_mock) == []


async def test_unloading_or_removing_restores_the_rate(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    entry = coordinator.entry
    await coordinator.sessions.async_start("Short", True)
    assert len(rate_calls(mqtt_mock)) == 4
    mqtt_mock.async_publish.side_effect = HomeAssistantError("not connected")
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == {}
    assert hass_storage[LEFTOVER_KEY]["data"] == {"rates": {BASE: dict.fromkeys(BULBS, 2.0)}}
    mqtt_mock.async_publish.side_effect = None
    sent = len(rate_calls(mqtt_mock))
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert LEFTOVER_KEY not in hass_storage
    assert len(rate_calls(mqtt_mock)) == sent
    await _z2m(hass)
    assert rate_calls(mqtt_mock)[-4:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    await _z2m(hass, rate=2)
    assert entry.runtime_data.sessions.rate_restore == {}
    await entry.runtime_data.sessions.async_start("Again", True)
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == {}
    assert rate_calls(mqtt_mock)[-1] == '{"id":"0x0000000000000004","options":{"motion_activity_rate":2}}'
    assert LEFTOVER_KEY not in hass_storage
    sent = len(rate_calls(mqtt_mock))
    hass_storage[RUNTIME_KEY] = _runtime(clock, {"0x0000000000000002": 1})
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert len(rate_calls(mqtt_mock)) == sent
    await _z2m(hass)
    assert rate_calls(mqtt_mock)[-1] == '{"id":"0x0000000000000002","options":{"motion_activity_rate":1}}'


async def test_an_abandoned_session_ends_and_its_steps_stay_short(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await coordinator.sessions.async_start("Forgotten", False)
    await coordinator.sessions.async_label("empty", None, "any", None)
    clock.advance(700)
    started = clock()
    await coordinator.sessions.async_label("room", "living", "walk", None)
    for _ in range(6):
        clock.advance(1200)
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1200 * (_ + 1)))
        await hass.async_block_till_done()
    session = coordinator.sessions.get()
    assert session is not None
    assert session["state"] == "stopped"
    assert session["summary"] is not None
    assert session["steps"][1]["t1"] == started + 600
    labels = await pending_labels(hass, coordinator)
    assert max(lb.t1 - lb.t0 for lb in labels) <= 600
    await coordinator.async_flush_history()
    stops = await hass.async_add_executor_job(coordinator.history.events, 0, clock() + 1, ["session_stop"])
    assert stops[-1].data["reason"] == "idle"


async def test_a_session_left_running_over_a_restart_keeps_its_step_short(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    t0 = clock() - 5 * 3600
    hass_storage[RUNTIME_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": RUNTIME_KEY,
        "data": {
            "session": {
                "session_id": "s-0007",
                "name": "Night",
                "started": t0 - 10,
                "state": "running",
                "raised_rate": False,
                "steps": [{"index": 0, "kind": "empty", "room": None, "activity": "any", "t0": t0, "t1": None}],
                "summary": None,
            },
            "rate_restore": {},
            "rate_until": None,
        },
    }
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: BASE}, unique_id=BASE)
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    session = entry.runtime_data.sessions.get()
    assert session is not None
    assert session["steps"][0]["t1"] == t0 + 1800


def _manual_ticks(coordinator: Any) -> None:
    if coordinator._tick_unsub is not None:
        coordinator._tick_unsub()
        coordinator._tick_unsub = None


async def _walk(hass: HomeAssistant, coordinator: Any, clock: Clock, seconds: float, room: str) -> None:
    await coordinator.sessions.async_label("room", room, "walk", None)
    for i in range(int(seconds * 2)):
        clock.advance(0.5)
        for ieee, name in BULBS.items():
            fire(hass, name, bulb_state(ieee, activity=10 + 30 * (i % 3), motion=i % 2 == 0))
        await hass.async_block_till_done()
        coordinator.tick()


def _without(plan: Plan, bulb: str | None = None, room: str | None = None) -> Plan:
    return replace(
        plan,
        bulbs=tuple(b for b in plan.bulbs if b.ieee != bulb),
        rooms=tuple(r for r in plan.rooms if r.id != room),
        adjacent=tuple(a for a in plan.adjacent if room not in a),
    )


@pytest.mark.parametrize("edit", [False, True])
async def test_a_plan_edit_during_a_session_keeps_its_labels(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, edit: bool
) -> None:
    coordinator = await _ready(hass)
    _manual_ticks(coordinator)
    await coordinator.sessions.async_start("Edited", False)
    await _walk(hass, coordinator, clock, 60, "living")
    if edit:
        await coordinator.async_save_plan(coordinator.plan.rev, _without(coordinator.plan, bulb="0x0000000000000004"))
    clock.advance(0.5)
    await coordinator.sessions.async_stop()
    clock.advance(0.5)
    coordinator.tick()
    pending = coordinator.model_summary()["pending"]
    assert pending is not None
    assert pending["labels"] == {"wizard": 110}


@pytest.mark.parametrize("before_stop", [False, True])
async def test_removing_the_labelled_room_drops_the_empty_proposal(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, before_stop: bool
) -> None:
    coordinator = await _ready(hass)
    await coordinator.sessions.async_start("Office", False)
    await _walk(hass, coordinator, clock, 20, "office")
    clock.advance(0.5)
    if before_stop:
        await coordinator.async_save_plan(coordinator.plan.rev, _without(coordinator.plan, room="office"))
        await coordinator.sessions.async_stop()
    else:
        await coordinator.sessions.async_stop()
        assert coordinator.engine.pending_id() is not None
        await coordinator.async_save_plan(coordinator.plan.rev, _without(coordinator.plan, room="office"))
    clock.advance(0.5)
    coordinator.tick()
    assert coordinator.model_summary()["pending"] is None
    assert await pending_labels(hass, coordinator) == []
    discarded = await hass.async_add_executor_job(coordinator.history.labels, 0.0, 1e12, "discarded")
    assert [(lb.room, lb.source) for lb in discarded] == [("office", "wizard")]


async def test_removal_with_the_broker_away_keeps_restoring(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    entry = coordinator.entry
    await coordinator.sessions.async_start("Short", True)
    fire(hass, "bridge/state", {"state": "offline"})
    await hass.async_block_till_done()
    assert ir.async_get(hass).async_get_issue(DOMAIN, "bridge_offline") is not None
    mqtt_mock.async_publish.side_effect = HomeAssistantError("not connected")
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert [key for key in ir.async_get(hass).issues if key[0] == DOMAIN] == [(DOMAIN, ISSUE_RATES_LEFT)]
    assert hass_storage[LEFTOVER_KEY]["data"] == {"rates": {BASE: dict.fromkeys(BULBS, 2.0)}}
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT)
    assert issue is not None
    assert issue.is_persistent
    assert issue.translation_key == ISSUE_RATES_WAITING
    assert issue.translation_placeholders == {"count": "4", "bulbs": ", ".join(sorted(BULBS))}
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=31))
    await hass.async_block_till_done()
    assert LEFTOVER_KEY in hass_storage
    mqtt_mock.async_publish.side_effect = None
    async_dispatcher_send(hass, MQTT_CONNECTION_STATE, True)
    await hass.async_block_till_done()
    assert LEFTOVER_KEY in hass_storage
    await _z2m(hass)
    assert rate_calls(mqtt_mock)[-4:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    assert LEFTOVER_KEY in hass_storage
    await _z2m(hass, rate=2)
    assert LEFTOVER_KEY not in hass_storage
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is None


async def test_rates_left_by_a_removal_are_restored_by_the_next_setup_and_other_topics_dropped(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    rates = {
        BASE: {"0x0000000000000002": 1, "0x0000000000000003": None, "0x0000000000000004": 2},
        "other": {"0x0000000000000009": 3},
    }
    hass_storage[LEFTOVER_KEY] = {"version": 1, "minor_version": 1, "key": LEFTOVER_KEY, "data": {"rates": rates}}
    mqtt_mock.async_publish.side_effect = HomeAssistantError("not connected")
    _entry, coordinator = await setup_outglow(hass)
    assert coordinator.sessions.rate_restore == {
        "0x0000000000000002": 1.0,
        "0x0000000000000003": 0.0,
        "0x0000000000000004": 2.0,
    }
    assert LEFTOVER_KEY not in hass_storage
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is None
    mqtt_mock.async_publish.side_effect = None
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=31))
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock) == []
    fire(hass, "bridge/info", _info({"0x0000000000000003": 7, "0x0000000000000004": None}))
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock) == []
    await _z2m(hass, {"0x0000000000000003": 7, "0x0000000000000004": None})
    assert coordinator.sessions.rate_restore == {"0x0000000000000002": 1.0}
    assert rate_calls(mqtt_mock) == ['{"id":"0x0000000000000002","options":{"motion_activity_rate":1}}']
    await _z2m(hass, {"0x0000000000000002": 1, "0x0000000000000003": 7, "0x0000000000000004": None})
    assert coordinator.sessions.rate_restore == {}
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == {}
    assert LEFTOVER_KEY not in hass_storage
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is None


async def test_a_session_survives_an_options_change(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    entry = coordinator.entry
    started = await coordinator.sessions.async_start("Options", True)
    await coordinator.sessions.async_label("room", "living", "walk", None)
    assert len(rate_calls(mqtt_mock)) == 4
    clock.advance(30)
    hass.config_entries.async_update_entry(entry, options={CONF_LOG_LEVEL: "debug"})
    await hass.async_block_till_done()
    reloaded = entry.runtime_data
    assert reloaded is not coordinator
    session = reloaded.sessions.get()
    assert session is not None
    assert (session["session_id"], session["state"], session["raised_rate"]) == (started["session_id"], "running", True)
    assert session["steps"][0]["t1"] is None
    assert len(rate_calls(mqtt_mock)) == 4
    assert reloaded.sessions.rate_restore == dict.fromkeys(BULBS, 2.0)
    await _z2m(hass)
    clock.advance(30)
    stopped = await reloaded.sessions.async_stop()
    assert stopped["steps"][0]["t1"] - stopped["steps"][0]["t0"] == 60
    assert rate_calls(mqtt_mock)[4:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    plain = await entry.runtime_data.sessions.async_start("Plain", False)
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    after = entry.runtime_data.sessions.get()
    assert after is not None
    assert (after["session_id"], after["state"]) == (plain["session_id"], "stopped")


def _rooms_in(model: Any) -> set[str]:
    return {key.rsplit("|", 1)[1] for key in model["emit"]} | set(model["entries"]) | set(model["rooms"])


async def _learn(hass: HomeAssistant, coordinator: Any, clock: Clock, rooms: tuple[str, ...]) -> None:
    await coordinator.sessions.async_start("Rooms", False)
    for room in rooms:
        await _walk(hass, coordinator, clock, 20, room)
    clock.advance(0.5)
    await coordinator.sessions.async_stop()
    clock.advance(0.5)
    coordinator.tick()
    assert coordinator.engine._labels == []


async def test_a_removed_room_takes_its_learning_along(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await _learn(hass, coordinator, clock, ("office", "living"))
    pending_id = coordinator.engine.pending_id()
    await coordinator.async_apply(pending_id)
    await _learn(hass, coordinator, clock, ("office", "living"))
    assert "office" in _rooms_in(coordinator.engine.model_state()["active"])
    assert "office" in _rooms_in(coordinator.engine.model_state()["pending"])
    snapshots = len(coordinator.model.snapshots)
    version = coordinator.model_version
    await coordinator.async_save_plan(coordinator.plan.rev, _without(coordinator.plan, room="office"))
    state = coordinator.engine.model_state()
    assert _rooms_in(state["active"]) == _rooms_in(state["pending"]) == {"living"}
    assert coordinator.model_version == version + 1
    stored = hass_storage[MODEL_KEY]["data"]["engine"]
    assert (stored["model_version"], _rooms_in(stored["active"])) == (version + 1, {"living"})
    moved = await pending_labels(hass, coordinator)
    assert coordinator.model.snapshots[snapshots:][0]["reason"] == "before_reset"
    assert "office" in _rooms_in(coordinator.model.snapshots[-1]["state"])
    assert {lb.room for lb in await pending_labels(hass, coordinator)} == {"living"}
    discarded = await hass.async_add_executor_job(coordinator.history.labels, 0.0, 1e12, "discarded")
    assert {lb.room for lb in discarded} == {"office"}
    assert coordinator.plan.retired_rooms == ("office",)
    again = from_json(Plan, plan_json(coordinator.plan.rev))
    with pytest.raises(OutglowError) as reused:
        await coordinator.async_save_plan(coordinator.plan.rev, again)
    assert reused.value.code == "invalid_format"
    office = next(room for room in again.rooms if room.id == "office")
    renamed = replace(again, rooms=tuple(replace(r, id="office_2") if r is office else r for r in again.rooms))
    renamed = replace(renamed, adjacent=(("living", "hall"), ("hall", "office_2")))
    await coordinator.async_save_plan(coordinator.plan.rev, renamed)
    assert coordinator.plan.retired_rooms == ("office",)
    clock.advance(0.5)
    coordinator.tick()
    assert "office_2" not in _rooms_in(coordinator.engine.model_state()["pending"])
    assert coordinator.engine.summary()["pending"]["rooms"][2]["a_on_after"] == A_ON_START
    await coordinator.async_apply(coordinator.engine.pending_id())
    assert await pending_labels(hass, coordinator) == []
    applied = await hass.async_add_executor_job(coordinator.history.labels, 0.0, 1e12, "applied")
    assert len(applied) >= len(moved) > 0


async def test_a_proposal_learned_only_in_a_removed_room_is_discarded(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await _learn(hass, coordinator, clock, ("office",))
    assert coordinator.engine.pending_id() is not None
    await coordinator.async_save_plan(coordinator.plan.rev, _without(coordinator.plan, room="office"))
    assert coordinator.model_summary()["pending"] is None
    assert await pending_labels(hass, coordinator) == []


async def _removed_with_broker_away(hass: HomeAssistant, mqtt_mock: MqttMockHAClient) -> None:
    coordinator = await _ready(hass)
    await coordinator.sessions.async_start("Short", True)
    mqtt_mock.async_publish.side_effect = HomeAssistantError("not connected")
    assert await hass.config_entries.async_remove(coordinator.entry.entry_id)
    await hass.async_block_till_done()


async def test_left_rates_wait_for_zigbee2mqtt_and_keep_manual_changes(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    await _removed_with_broker_away(hass, mqtt_mock)
    mqtt_mock.async_publish.side_effect = None
    sent = len(rate_calls(mqtt_mock))
    async_dispatcher_send(hass, MQTT_CONNECTION_STATE, True)
    await hass.async_block_till_done()
    assert len(rate_calls(mqtt_mock)) == sent
    manual: dict[str, int | None] = {"0x0000000000000003": 3, "0x0000000000000004": None}
    await _z2m(hass, manual)
    assert rate_calls(mqtt_mock)[sent:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}'
        for ieee in ("0x0000000000000001", "0x0000000000000002")
    ]
    assert hass_storage[LEFTOVER_KEY]["data"] == {
        "rates": {BASE: {"0x0000000000000001": 2.0, "0x0000000000000002": 2.0}}
    }
    await _z2m(hass, manual)
    assert len(rate_calls(mqtt_mock)) == sent + 2
    await _z2m(hass, {**manual, "0x0000000000000001": 2, "0x0000000000000002": 2})
    assert LEFTOVER_KEY not in hass_storage
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is None
    await _z2m(hass)
    assert len(rate_calls(mqtt_mock)) == sent + 2


async def test_left_rates_wait_while_zigbee2mqtt_is_offline_and_are_sent_again_after_a_drop(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    await _removed_with_broker_away(hass, mqtt_mock)
    mqtt_mock.async_publish.side_effect = None
    sent = len(rate_calls(mqtt_mock))
    async_dispatcher_send(hass, MQTT_CONNECTION_STATE, True)
    fire(hass, "bridge/state", {"state": "offline"})
    fire(hass, "bridge/info", info_payload(rate=4))
    await hass.async_block_till_done()
    assert len(rate_calls(mqtt_mock)) == sent
    assert LEFTOVER_KEY in hass_storage
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT)
    assert issue is not None
    assert issue.translation_key == ISSUE_RATES_WAITING
    fire(hass, "bridge/state", "online")
    await hass.async_block_till_done()
    assert len(rate_calls(mqtt_mock)) == sent + 4
    fire(hass, "bridge/state", "offline")
    await hass.async_block_till_done()
    fire(hass, "bridge/state", "online")
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock)[sent + 4 :] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    await _z2m(hass, rate=2)
    assert LEFTOVER_KEY not in hass_storage
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is None


async def test_left_rates_are_retried_less_and_less_often(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    await _removed_with_broker_away(hass, mqtt_mock)
    await _z2m(hass)
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT)
    assert issue is not None
    assert issue.translation_key == ISSUE_RATES_LEFT
    assert (issue.translation_placeholders or {})["retry"] == "0.5"
    attempts = [mqtt_mock.async_publish.call_count]
    for delay in (30, 60, 120, 240, 480, 960, 1800, 1800):
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=delay - 1))
        await hass.async_block_till_done()
        assert mqtt_mock.async_publish.call_count == attempts[-1]
        async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=delay + 1))
        await hass.async_block_till_done()
        attempts.append(mqtt_mock.async_publish.call_count)
        assert attempts[-1] == attempts[-2] + 1
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT)
    assert issue is not None
    assert (issue.translation_placeholders or {})["retry"] == "30"
    mqtt_mock.async_publish.side_effect = None
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=1802))
    await hass.async_block_till_done()
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT)
    assert issue is not None
    assert issue.translation_key == ISSUE_RATES_WAITING
    await _z2m(hass, rate=2)
    assert LEFTOVER_KEY not in hass_storage


async def test_left_rates_wait_when_mqtt_cannot_subscribe(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    async def refused(_hass: HomeAssistant, topic: str, *_args: Any, **_kwargs: Any) -> Any:
        calls.append(topic)
        raise HomeAssistantError("MQTT is not set up")

    await _removed_with_broker_away(hass, mqtt_mock)
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is not None
    real = mqtt.async_subscribe
    monkeypatch.setattr(mqtt, "async_subscribe", refused)
    await leftover.async_forget(hass, "gone", others=True)
    await leftover.async_forget(hass, BASE)
    await leftover.async_keep(hass, BASE, {"0x0000000000000001": 2.0})
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT)
    assert issue is not None
    assert (issue.translation_placeholders or {})["retry"] == "0.5"
    assert calls == [f"{BASE}/bridge/+"]
    monkeypatch.setattr(mqtt, "async_subscribe", real)
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=31))
    await hass.async_block_till_done()
    mqtt_mock.async_publish.side_effect = None
    fire(hass, "bridge/info", "not json")
    fire(hass, "bridge/info", "[]")
    fire(hass, "bridge/devices", [])
    fire(hass, "bridge/state", "online")
    await hass.async_block_till_done()
    assert LEFTOVER_KEY in hass_storage
    await _z2m(hass)
    assert rate_calls(mqtt_mock)[-1] == '{"id":"0x0000000000000001","options":{"motion_activity_rate":2}}'
    await _z2m(hass, rate=2)
    assert LEFTOVER_KEY not in hass_storage


async def test_disabling_with_the_broker_away_hands_the_rates_over(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    entry = coordinator.entry
    await coordinator.sessions.async_start("Short", True)
    mqtt_mock.async_publish.side_effect = HomeAssistantError("not connected")
    await hass.config_entries.async_set_disabled_by(entry.entry_id, ConfigEntryDisabler.USER)
    await hass.async_block_till_done()
    assert entry.state == ConfigEntryState.NOT_LOADED
    assert hass_storage[LEFTOVER_KEY]["data"] == {"rates": {BASE: dict.fromkeys(BULBS, 2.0)}}
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == {}
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is not None
    mqtt_mock.async_publish.side_effect = None
    await _z2m(hass)
    assert rate_calls(mqtt_mock)[-4:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    await _z2m(hass, rate=2)
    assert LEFTOVER_KEY not in hass_storage
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is None
    sent = len(rate_calls(mqtt_mock))
    await hass.config_entries.async_set_disabled_by(entry.entry_id, None)
    await hass.async_block_till_done()
    reloaded = hass.config_entries.async_get_entry(entry.entry_id)
    assert reloaded is not None
    assert reloaded.state == ConfigEntryState.LOADED
    assert len(rate_calls(mqtt_mock)) == sent


async def test_a_session_restore_waits_for_zigbee2mqtt_and_is_sent_again_after_a_drop(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await coordinator.sessions.async_start("Short", True)
    await _z2m(hass)
    fire(hass, "bridge/state", {"state": "offline"})
    await hass.async_block_till_done()
    await coordinator.sessions.async_stop()
    assert len(rate_calls(mqtt_mock)) == 4
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == dict.fromkeys(BULBS, 2.0)
    fire(hass, "bridge/state", {"state": "online"})
    await hass.async_block_till_done()
    assert len(rate_calls(mqtt_mock)) == 8
    fire(hass, "bridge/devices", devices_payload())
    await hass.async_block_till_done()
    assert len(rate_calls(mqtt_mock)) == 8
    fire(hass, "bridge/state", {"state": "offline"})
    fire(hass, "bridge/state", {"state": "online"})
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock)[8:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    assert coordinator.sessions.rate_restore == dict.fromkeys(BULBS, 2.0)
    await _z2m(hass, rate=2)
    assert coordinator.sessions.rate_restore == {}
    assert hass_storage[RUNTIME_KEY]["data"]["rate_restore"] == {}


async def test_a_session_restore_is_sent_again_when_home_assistant_reconnects_to_mqtt(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await coordinator.sessions.async_start("Short", True)
    await _z2m(hass)
    await coordinator.sessions.async_stop()
    assert len(rate_calls(mqtt_mock)) == 8
    async_dispatcher_send(hass, MQTT_CONNECTION_STATE, False)
    await hass.async_block_till_done()
    async_dispatcher_send(hass, MQTT_CONNECTION_STATE, True)
    await hass.async_block_till_done()
    assert rate_calls(mqtt_mock)[8:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_SESSION_RATES) is None
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=SESSION_RATES_REPAIR_S + 1))
    await hass.async_block_till_done()
    issue = ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_SESSION_RATES)
    assert issue is not None
    assert issue.translation_placeholders == {"count": "4", "bulbs": ", ".join(sorted(BULBS)), "minutes": "10"}
    await _z2m(hass, rate=2)
    assert coordinator.sessions.rate_restore == {}
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_SESSION_RATES) is None
    assert await hass.config_entries.async_unload(coordinator.entry.entry_id)
    async_dispatcher_send(hass, MQTT_CONNECTION_STATE, True)
    await hass.async_block_till_done()
    assert len(rate_calls(mqtt_mock)) == 12


async def test_a_session_started_while_a_restore_is_in_flight_raises_after_it(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    sessions = coordinator.sessions
    await sessions.async_start("One", True)
    await _z2m(hass)
    fire(hass, "bridge/state", {"state": "offline"})
    await hass.async_block_till_done()
    await sessions.async_stop()
    gate = asyncio.Event()
    real = coordinator.writer.async_set_activity_rate
    order: list[tuple[str, float]] = []

    async def slow(ieee: str, rate: float, reason: str, assume: bool = True) -> None:
        order.append((ieee, rate))
        if len(order) == 1:
            await gate.wait()
        await real(ieee, rate, reason, assume=assume)

    coordinator.writer.async_set_activity_rate = slow
    fire(hass, "bridge/state", {"state": "online"})
    for _ in range(5):
        await asyncio.sleep(0)
    assert order == [(sorted(BULBS)[0], 2.0)]
    start = hass.async_create_task(sessions.async_start("Two", True))
    for _ in range(20):
        await asyncio.sleep(0)
    stale = hass.async_create_task(sessions.async_restore_rates())
    for _ in range(5):
        await asyncio.sleep(0)
    gate.set()
    await start
    assert await stale is False
    await hass.async_block_till_done()
    assert order == [(ieee, 2.0) for ieee in sorted(BULBS)] + [(ieee, 4) for ieee in sorted(BULBS)]
    assert sessions.session is not None
    assert sessions.session["raised_rate"] is True
    assert sessions.rate_until is not None
    assert sessions.rate_restore == dict.fromkeys(BULBS, 2.0)


async def test_an_unload_hands_unconfirmed_restores_over(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_storage: dict[str, Any], clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await coordinator.sessions.async_start("Short", True)
    await _z2m(hass)
    assert await hass.config_entries.async_unload(coordinator.entry.entry_id)
    assert rate_calls(mqtt_mock)[4:] == [
        f'{{"id":"{ieee}","options":{{"motion_activity_rate":2}}}}' for ieee in sorted(BULBS)
    ]
    assert hass_storage[LEFTOVER_KEY]["data"] == {"rates": {BASE: dict.fromkeys(BULBS, 2.0)}}
    await _z2m(hass, rate=2)
    assert LEFTOVER_KEY not in hass_storage
    assert len(rate_calls(mqtt_mock)) == 8
    assert ir.async_get(hass).async_get_issue(DOMAIN, ISSUE_RATES_LEFT) is None


async def test_resetting_one_room_keeps_the_labels_of_the_proposal_with_it(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    coordinator = await _ready(hass)
    await _learn(hass, coordinator, clock, ("office", "living"))
    before = coordinator.engine.pending_id()
    labelled = await pending_labels(hass, coordinator)
    await coordinator.async_reset_learning("office")
    after = coordinator.engine.pending_id()
    assert after is not None
    assert after != before
    assert await pending_labels(hass, coordinator) == labelled
    await coordinator.async_apply(after)
    assert await pending_labels(hass, coordinator) == []
    applied = await hass.async_add_executor_job(coordinator.history.labels, 0.0, 1e12, "applied")
    assert applied == labelled
