from dataclasses import replace

import pytest
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from pytest_homeassistant_custom_component.typing import MqttMockHAClient

from custom_components.outglow.const import BRIDGE_SETTLE_S, MANUAL_LIGHT_AFTER_S, MANUAL_LIGHT_BEFORE_S
from custom_components.outglow.context import HouseState, light_origin
from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine.types import Frame, LightEvent, RoomFrame
from tests.integration.common import BULBS, Clock, bridge, fire, pending_labels, setup_outglow, with_plan

RX = "0x0000000000000001"


def empty_of(coordinator: OutglowCoordinator) -> str:
    return str(coordinator.house_empty)


LIGHT = "light.living_1"


def test_light_origin() -> None:
    assert light_origin(Context(user_id="u"), frozenset()) == "user"
    assert light_origin(Context(), frozenset()) == "remote"
    assert light_origin(Context(parent_id="automation"), frozenset()) == "unknown"
    ours = Context()
    assert light_origin(ours, frozenset({ours.id})) == "ours"
    assert light_origin(None, frozenset()) == "unknown"


def test_house_state_needs_ten_minutes_and_trims_margins() -> None:
    house = HouseState()
    away = {"person.a": "not_home", "person.b": "not_home"}
    assert house.update(0.0, away, soft=False) == []
    assert house.empty(599.0, soft=False) == "unknown"
    assert house.empty(600.0, soft=False) == "yes"
    assert house.empty(600.0, soft=True) == "soft"
    closed = house.update(1000.0, {"person.a": "home", "person.b": "not_home"}, soft=False)
    assert [(i.t0, i.t1, i.soft) for i in closed] == [(120.0, 880.0, False)]
    assert house.empty(1000.0, soft=False) == "no"
    assert house.persons_home == frozenset({"person.a"})
    assert house.update(1001.0, away, soft=False) == []
    assert house.update(1100.0, {"person.a": None, "person.b": "not_home"}, soft=False) == []
    assert house.empty(1100.0, soft=False) == "unknown"


async def _with_light(hass: HomeAssistant) -> None:
    mqtt_entry = hass.config_entries.async_entries("mqtt")[0]
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=mqtt_entry.entry_id, identifiers={("mqtt", f"zigbee2mqtt_{RX}")}, name="Living 1"
    )
    er.async_get(hass).async_get_or_create(
        "light", "mqtt", f"{RX}_light", device_id=device.id, suggested_object_id="living_1"
    )


async def test_manual_light_on_in_an_empty_room_is_a_correction(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    await _with_light(hass)
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    assert coordinator.light_entity(RX) == LIGHT
    seen: list[LightEvent] = []
    original = coordinator.engine.light

    def capture(event: LightEvent) -> None:
        seen.append(event)
        original(event)

    coordinator.engine.light = capture  # type: ignore[method-assign]
    clock.advance(BRIDGE_SETTLE_S)
    coordinator.set_frame(Frame(t=clock(), rooms={"living": RoomFrame(occupied=False, coverage="good")}))
    hass.states.async_set(LIGHT, "on")
    await hass.async_block_till_done()
    hass.states.async_set(LIGHT, "off")
    await hass.async_block_till_done()
    hass.states.async_set(LIGHT, "on", context=Context(user_id="someone"))
    await hass.async_block_till_done()
    assert [(e.ieee, e.origin, e.on) for e in seen] == [(RX, "remote", False), (RX, "user", True)]
    labels = await pending_labels(hass, coordinator)
    assert [(lb.room, lb.source, lb.weight, lb.t1 - lb.t0) for lb in labels] == [("living", "manual_light", 0.3, 25.0)]
    coordinator.set_frame(Frame(t=clock(), rooms={"living": RoomFrame(occupied=True, coverage="good")}))
    hass.states.async_set(LIGHT, "off", context=Context(parent_id="automation"))
    hass.states.async_set(LIGHT, "on")
    await hass.async_block_till_done()
    assert len(await pending_labels(hass, coordinator)) == 1


async def test_one_switch_of_several_bulbs_is_one_correction(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    await _with_light(hass)
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    clock.advance(BRIDGE_SETTLE_S)
    coordinator.set_frame(Frame(t=clock(), rooms={"living": RoomFrame(occupied=False, coverage="good")}))

    async def switch() -> int:
        hass.states.async_set(LIGHT, "off")
        await hass.async_block_till_done()
        hass.states.async_set(LIGHT, "on", context=Context(user_id="someone"))
        await hass.async_block_till_done()
        return len(await pending_labels(hass, coordinator))

    assert await switch() == 1
    clock.advance(MANUAL_LIGHT_BEFORE_S + MANUAL_LIGHT_AFTER_S - 1)
    assert await switch() == 1
    clock.advance(MANUAL_LIGHT_BEFORE_S + MANUAL_LIGHT_AFTER_S)
    assert await switch() == 2


async def test_lights_coming_back_are_not_corrections(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    await _with_light(hass)
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    clock.advance(BRIDGE_SETTLE_S)
    coordinator.set_frame(Frame(t=clock(), rooms={"living": RoomFrame(occupied=False, coverage="good")}))
    for previous in (STATE_UNAVAILABLE, STATE_UNKNOWN):
        hass.states.async_set(LIGHT, previous)
        await hass.async_block_till_done()
        hass.states.async_set(LIGHT, "on")
        await hass.async_block_till_done()
    hass.states.async_set(LIGHT, "off")
    await hass.async_block_till_done()
    fire(hass, "bridge/state", {"state": "offline"})
    fire(hass, "bridge/state", {"state": "online"})
    await hass.async_block_till_done()
    clock.advance(5)
    hass.states.async_set(LIGHT, "on")
    await hass.async_block_till_done()
    assert await pending_labels(hass, coordinator) == []
    clock.advance(BRIDGE_SETTLE_S)
    hass.states.async_set(LIGHT, "off")
    await hass.async_block_till_done()
    hass.states.async_set(LIGHT, "on", context=Context(user_id="someone"))
    await hass.async_block_till_done()
    assert [lb.source for lb in await pending_labels(hass, coordinator)] == ["manual_light"]


async def test_learning_off_keeps_corrections_out_of_the_model(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    await coordinator.async_update_settings(lambda s: replace(s, global_=replace(s.global_, learning=False)))
    assert await coordinator.async_feedback("living", "missed", clock()) is None
    assert coordinator.engine.pending_id() is None
    assert await coordinator.async_feedback("living", "correct", clock()) is None


async def test_persons_are_ignored_unless_enabled(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    hass.states.async_set("person.a", "not_home")
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    clock.advance(700)
    coordinator.tick()
    assert coordinator.house_empty == "unknown"
    await coordinator.async_update_settings(
        lambda s: replace(s, global_=replace(s.global_, use_persons=True, persons=("person.a",)))
    )
    clock.advance(700)
    coordinator.tick()
    assert empty_of(coordinator) == "yes"
    hass.states.async_set("person.a", "home")
    await hass.async_block_till_done()
    assert empty_of(coordinator) == "no"
    await hass.async_block_till_done()
    assert await pending_labels(hass, coordinator) == []
    assert await hass.async_add_executor_job(coordinator.history.empty_spans, 0, clock() + 1) != []
    await coordinator.async_flush_history()
    events = await hass.async_add_executor_job(
        coordinator.history.events, 0, clock() + 1, ["house_empty", "house_occupied"]
    )
    assert [e.kind for e in events] == ["house_empty", "house_occupied"]


async def test_an_empty_house_is_learned_once_while_it_lasts(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    hass.states.async_set("person.a", "not_home")
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    await coordinator.async_update_settings(
        lambda s: replace(s, global_=replace(s.global_, use_persons=True, persons=("person.a",)))
    )
    away = clock()
    for _ in range(2 * 1200):
        clock.advance(0.5)
        coordinator.tick()
    hass.states.async_set("person.a", "home")
    await hass.async_block_till_done()
    for _ in range(4):
        clock.advance(0.5)
        coordinator.tick()
    await hass.async_block_till_done()
    pending = coordinator.engine.model_state()["pending"]
    assert isinstance(pending, dict)
    seconds = pending["empty_s"]
    assert isinstance(seconds, float)
    assert seconds == pytest.approx(1200 - 600 - 2 * 120, abs=1)
    assert pending["labels"] == {"empty_house": round(seconds / 0.5)}
    spans = await hass.async_add_executor_job(coordinator.history.empty_spans, 0, clock() + 1)
    assert spans == [(away + 120, away + 1200 - 120)]


async def test_offline_bulbs_reach_the_engine_context(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    coordinator.devices.set_available("0x0000000000000004", False)
    coordinator.availability_changed("0x0000000000000004", False)
    assert coordinator.tick().gates["0x0000000000000004"] == "offline"
    assert set(coordinator.tick().gates) == set(BULBS)
