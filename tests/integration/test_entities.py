from dataclasses import replace

from homeassistant.const import STATE_OFF, STATE_ON, STATE_UNAVAILABLE
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.helpers import area_registry as ar
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.event import async_track_state_change_event
from pytest_homeassistant_custom_component.typing import MqttMockHAClient

from custom_components.outglow.const import DOMAIN
from custom_components.outglow.engine import from_json
from custom_components.outglow.engine.rooms import RoomState
from custom_components.outglow.engine.types import Frame, Plan, RoomFrame
from tests.integration.common import Clock, bridge, plan_json, setup_outglow, with_plan

LIVING = "binary_sensor.outglow_room_living_occupancy"


def state_of(hass: HomeAssistant, entity_id: str) -> State:
    found = hass.states.get(entity_id)
    assert found is not None, entity_id
    return found


def frame(t: float, **rooms: RoomFrame) -> Frame:
    return Frame(t=t, status="ready", model_version=3, rooms=dict(rooms), trail=(("hall", t - 5), ("living", t)))


async def test_room_entities_follow_frames(hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock) -> None:
    entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    assert coordinator.frame is not None
    assert coordinator.frame.rooms["living"].coverage != "none"
    assert state_of(hass, LIVING).state == STATE_OFF
    good = RoomFrame(
        p=0.934,
        motion=True,
        occupied=True,
        since=clock(),
        coverage="good",
        top_pairs=(("0x0000000000000001", "0x0000000000000002"),),
    )
    coordinator.set_frame(frame(clock(), living=good, hall=RoomFrame(p=0.2, coverage="weak")))
    await hass.async_block_till_done()
    state = state_of(hass, LIVING)
    assert state.state == STATE_ON
    assert state.attributes["probability"] == 0.93
    assert state.attributes["top_pairs"] == ["Test/Living 1 - Living 2"]
    assert state.attributes["coverage"] == "good"
    assert state.attributes["model_version"] == 3
    assert state.attributes["last_motion"] == clock()
    assert state_of(hass, "binary_sensor.outglow_room_hall_occupancy").state == STATE_OFF
    assert state_of(hass, "binary_sensor.outglow_room_office_occupancy").state == STATE_UNAVAILABLE
    assert state_of(hass, "binary_sensor.outglow_home_motion").state == STATE_ON
    room = state_of(hass, "sensor.outglow_motion_room")
    assert room.state == "living"
    assert room.attributes["rooms"] == {"living": 0.93, "hall": 0.2}
    assert room.attributes["trail"] == [["hall", clock() - 5], ["living", clock()]]
    assert "likely_person" not in room.attributes
    status = state_of(hass, "sensor.outglow_status")
    assert status.state == "ready"
    clock.advance(1)
    coordinator.set_frame(frame(clock(), living=RoomFrame(p=0.4, occupied=True, since=clock() - 1, coverage="good")))
    await hass.async_block_till_done()
    assert state_of(hass, "sensor.outglow_motion_room").state == "living"
    assert state_of(hass, "binary_sensor.outglow_home_motion").state == STATE_ON
    clock.advance(10)
    coordinator.set_frame(frame(clock(), living=RoomFrame(p=0.4, occupied=True, since=clock() - 1, coverage="good")))
    await hass.async_block_till_done()
    assert state_of(hass, "binary_sensor.outglow_home_motion").state == STATE_OFF
    devices = dr.async_get(hass)
    device = devices.async_get_device_by_identifier((DOMAIN, f"{entry.entry_id}_living"), entry.entry_id)
    assert device is not None
    assert device.name == "Living room · Outglow"
    area = ar.async_get(hass).async_create("Salon")
    renamed = replace(
        coordinator.plan,
        rooms=tuple(
            replace(r, name="Salon", area_id=area.id) if r.id == "living" else r for r in coordinator.plan.rooms
        ),
    )
    await coordinator.async_save_plan(coordinator.plan.rev, renamed)
    device = devices.async_get_device_by_identifier((DOMAIN, f"{entry.entry_id}_living"), entry.entry_id)
    assert device is not None
    assert device.name == "Salon · Outglow"
    assert device.area_id == area.id


async def test_motion_room_breaks_a_tie_by_the_room_shown_then_the_latest_motion(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)

    def lit(since: float) -> RoomFrame:
        return RoomFrame(p=1.0, motion=True, occupied=True, since=since, coverage="good")

    def shown() -> str:
        return state_of(hass, "sensor.outglow_motion_room").state

    coordinator.set_frame(frame(clock(), hall=lit(clock())))
    await hass.async_block_till_done()
    assert shown() == "hall"
    for _ in range(3):
        clock.advance(6)
        coordinator.set_frame(frame(clock(), hall=lit(clock() - 12), living=lit(clock() - 1)))
        await hass.async_block_till_done()
    assert shown() == "hall"
    clock.advance(6)
    coordinator.set_frame(frame(clock(), living=lit(clock() - 1)))
    await hass.async_block_till_done()
    assert shown() == "living"
    clock.advance(1)
    coordinator.set_frame(frame(clock(), office=RoomFrame(p=0.3, occupied=True, since=clock() - 30)))
    await hass.async_block_till_done()
    assert shown() == "office"
    clock.advance(1)
    coordinator.set_frame(frame(clock(), hall=lit(clock() - 5), living=lit(clock() - 1)))
    await hass.async_block_till_done()
    assert shown() == "living"
    coordinator.set_frame(frame(clock(), office=RoomFrame(p=0.3, occupied=True, since=clock() - 30)))
    await hass.async_block_till_done()
    clock.advance(1)
    coordinator.set_frame(frame(clock(), hall=lit(clock() - 1), living=lit(clock() - 5)))
    await hass.async_block_till_done()
    assert shown() == "hall"


async def test_pause_makes_rooms_unavailable(hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    coordinator.set_frame(frame(clock(), living=RoomFrame(p=0.9, motion=True, occupied=True, coverage="good")))
    await hass.async_block_till_done()
    assert state_of(hass, LIVING).state == STATE_ON
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.outglow_sensing"}, blocking=True)
    assert coordinator.settings.global_.sensing is False
    assert state_of(hass, LIVING).state == STATE_UNAVAILABLE
    assert state_of(hass, "switch.outglow_sensing").state == STATE_OFF
    assert coordinator.tick().status == "paused"
    await hass.async_block_till_done()
    assert state_of(hass, "sensor.outglow_status").state == "paused"
    await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.outglow_sensing"}, blocking=True)
    assert coordinator.settings.global_.sensing is True


async def test_room_settings_entities(hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    budget = "select.outglow_room_living_false_alarm_budget"
    assert state_of(hass, budget).state == "1"
    await hass.services.async_call("select", "select_option", {"entity_id": budget, "option": "0.3"}, blocking=True)
    assert coordinator.settings.rooms["living"].false_alarm_budget == 0.3
    assert state_of(hass, budget).state == "0.3"
    reaction = "select.outglow_room_office_reaction"
    await hass.services.async_call("select", "select_option", {"entity_id": reaction, "option": "calm"}, blocking=True)
    assert coordinator.settings.rooms["office"].reaction == "calm"
    hold = "number.outglow_room_hall_hold_time"
    await hass.services.async_call("number", "set_value", {"entity_id": hold, "value": 90}, blocking=True)
    assert coordinator.settings.rooms["hall"].hold_time_s == 90
    assert float(state_of(hass, hold).state) == 90
    assert state_of(hass, "sensor.outglow_room_hall_false_alarms_24h").state == "0"
    await hass.services.async_call(DOMAIN, "feedback", {"room": "Hall", "kind": "false_alarm"}, blocking=True)
    coordinator.tick()
    await hass.async_block_till_done()
    assert state_of(hass, "sensor.outglow_room_hall_false_alarms_24h").state == "1"


async def test_plan_save_adds_and_removes_room_entities(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    registry = er.async_get(hass)
    office = registry.async_get("binary_sensor.outglow_room_office_occupancy")
    assert office is not None
    assert office.unique_id == f"{entry.entry_id}_office_occupancy"
    data = plan_json(coordinator.plan.rev)
    data["rooms"] = [room for room in data["rooms"] if room["id"] != "office"] + [
        {"id": "kitchen", "name": "Kitchen", "outline": [[0, 4], [2, 4], [2, 7], [0, 7]]}
    ]
    data["adjacent"] = [["living", "hall"]]
    await coordinator.async_save_plan(coordinator.plan.rev, from_json(Plan, data))
    await hass.async_block_till_done()
    assert registry.async_get("binary_sensor.outglow_room_office_occupancy") is None
    assert registry.async_get("select.outglow_room_office_reaction") is None
    assert hass.states.get("binary_sensor.outglow_room_kitchen_occupancy") is not None
    assert "office" not in coordinator.settings.rooms
    assert "kitchen" in coordinator.settings.rooms
    devices = dr.async_get(hass)
    assert devices.async_get_device_by_identifier((DOMAIN, f"{entry.entry_id}_office"), entry.entry_id) is None


async def test_room_devices_join_existing_areas_and_never_create_one(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    areas = ar.async_get(hass)
    bathroom = areas.async_create("Łazienka")
    assert bathroom.id == "lazienka"
    known = {area.id for area in areas.async_list_areas()}
    entry, coordinator = await setup_outglow(hass)
    data = plan_json(coordinator.plan.rev)
    data["rooms"][0]["area_id"] = bathroom.id
    data["rooms"][1]["area_id"] = "nowhere"
    await coordinator.async_save_plan(coordinator.plan.rev, from_json(Plan, data))
    await hass.async_block_till_done()
    assert {area.id for area in areas.async_list_areas()} == known
    devices = dr.async_get(hass)
    living = devices.async_get_device_by_identifier((DOMAIN, f"{entry.entry_id}_living"), entry.entry_id)
    hall = devices.async_get_device_by_identifier((DOMAIN, f"{entry.entry_id}_hall"), entry.entry_id)
    assert living is not None
    assert hall is not None
    assert living.area_id == "lazienka"
    assert hall.area_id is None
    assert er.async_get(hass).async_get("binary_sensor.outglow_room_living_occupancy") is not None
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert {area.id for area in areas.async_list_areas()} == known


async def test_changing_settings_or_the_plan_keeps_occupied_rooms_on(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    seen: list[str] = []

    @callback
    def changed(event: Event[EventStateChangedData]) -> None:
        new = event.data["new_state"]
        if new is not None:
            seen.append(new.state)

    async_track_state_change_event(hass, [LIVING], changed)
    coordinator.engine._rooms.state["living"] = RoomState(
        p=0.97, motion=True, run=3, last_motion=clock(), since=clock()
    )
    coordinator.tick()
    await hass.async_block_till_done()
    assert state_of(hass, LIVING).state == STATE_ON
    budget = "select.outglow_room_living_false_alarm_budget"
    await hass.services.async_call("select", "select_option", {"entity_id": budget, "option": "3"}, blocking=True)
    clock.advance(0.5)
    coordinator.tick()
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.outglow_learning"}, blocking=True)
    clock.advance(0.5)
    coordinator.tick()
    await hass.services.async_call(
        "number", "set_value", {"entity_id": "number.outglow_room_living_hold_time", "value": 120}, blocking=True
    )
    clock.advance(0.5)
    coordinator.tick()
    renamed = replace(
        coordinator.plan,
        rooms=tuple(replace(r, name="Lounge") if r.id == "living" else r for r in coordinator.plan.rooms),
    )
    await coordinator.async_save_plan(coordinator.plan.rev, renamed)
    clock.advance(0.5)
    coordinator.tick()
    await hass.async_block_till_done()
    assert coordinator.settings.rooms["living"].false_alarm_budget == 3.0
    assert coordinator.settings.global_.learning is False
    assert state_of(hass, LIVING).state == STATE_ON
    assert STATE_OFF not in seen
    await coordinator.async_flush_history()
    events = await hass.async_add_executor_job(coordinator.history.events, 0, clock() + 1, ["motion_off"])
    assert events == []


async def test_motion_room_moves_at_once_to_new_motion_but_not_between_two_moving_rooms(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    start = clock()

    async def show(at: float, **rooms: tuple[float, bool]) -> str:
        clock.t = start + at
        frames = {
            room: RoomFrame(p=p, motion=moving, occupied=True, since=start, coverage="good")
            for room, (p, moving) in rooms.items()
        }
        coordinator.set_frame(frame(clock(), **frames))
        await hass.async_block_till_done()
        return state_of(hass, "sensor.outglow_motion_room").state

    assert await show(0, living=(0.9, True)) == "living"
    assert await show(1, living=(0.6, True), hall=(0.95, True)) == "living"
    assert await show(2, living=(0.5, False), hall=(0.95, True)) == "living"
    assert await show(5, living=(0.9, True), hall=(0.8, True)) == "living"
    for at in range(6, 15):
        assert await show(at, living=(0.6, True), hall=(0.95, True)) == "living"
    assert await show(16, living=(0.6, True), hall=(0.95, True)) == "hall"
    for at in range(17, 30):
        assert await show(at, living=(0.4, False), hall=(0.5, False)) == "hall"
    assert await show(30, living=(0.4, False), hall=(0.5, False), office=(0.7, True)) == "office"
    assert await show(31, living=(0.9, True), office=(0.7, True)) == "office"
