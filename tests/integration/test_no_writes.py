from typing import Any

from homeassistant.core import Context, HomeAssistant
from pytest_homeassistant_custom_component.common import async_fire_time_changed
from pytest_homeassistant_custom_component.typing import MqttMockHAClient, WebSocketGenerator

from custom_components.outglow.const import DOMAIN
from custom_components.outglow.engine.types import Frame, RoomFrame
from tests.contract import commands, ws_fixture
from tests.integration.common import BASE, BULBS, Clock, bridge, bulb_state, fire, plan_json, setup_outglow

READ_ONLY = sorted(c for c in commands() if c not in {"outglow/bulb/write"})


def publishes(mqtt_mock: MqttMockHAClient) -> list[tuple[Any, ...]]:
    return [tuple(call.args[:2]) for call in mqtt_mock.async_publish.call_args_list]


async def test_nothing_is_published_without_an_explicit_write(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_ws_client: WebSocketGenerator, clock: Clock
) -> None:
    entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "outglow/plan/save", "rev": 0, "plan": plan_json(0)})
    assert (await ws.receive_json())["success"]
    for second in range(20):
        clock.advance(0.5)
        for ieee, name in BULBS.items():
            fire(hass, name, bulb_state(ieee, activity=second, motion=second % 3 == 0))
        await hass.async_block_till_done()
        coordinator.tick()
    hass.states.async_set("light.test_living_1", "on", context=Context(user_id="abc"))
    coordinator.set_frame(Frame(t=clock(), rooms={"living": RoomFrame(p=0.9, motion=True, occupied=True)}))
    for command in READ_ONLY:
        request = ws_fixture(command)["request"]
        if command == "outglow/session/start":
            request = {**request, "raise_rate": False}
        await ws.send_json_auto_id({"type": command, **request})
        await ws.receive_json()
    await hass.services.async_call(DOMAIN, "feedback", {"room": "living", "kind": "false_alarm"}, blocking=True)
    await hass.services.async_call(DOMAIN, "label", {"room": "hall", "activity": "walk"}, blocking=True)
    await hass.services.async_call(DOMAIN, "start_session", {"name": "x"}, blocking=True)
    await hass.services.async_call(DOMAIN, "stop_session", {}, blocking=True)
    await hass.services.async_call(
        DOMAIN, "export_recording", {"start": "2027-01-01 00:00:00", "end": "2027-01-15 00:00:00"}, blocking=True
    )
    await hass.services.async_call(DOMAIN, "reset_learning", {}, blocking=True)
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.outglow_learning"}, blocking=True)
    await hass.services.async_call(
        "select",
        "select_option",
        {"entity_id": "select.outglow_room_living_reaction", "option": "fast"},
        blocking=True,
    )
    await hass.services.async_call(
        "number", "set_value", {"entity_id": "number.outglow_room_hall_hold_time", "value": 120}, blocking=True
    )
    await hass.services.async_call(
        "button", "press", {"entity_id": "button.outglow_delete_motion_history"}, blocking=True
    )
    await coordinator.async_hourly()
    await coordinator.async_calibrate()
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    ours = [p for p in publishes(mqtt_mock) if str(p[0]).startswith(f"{BASE}/")]
    assert ours == []


async def test_explicit_write_and_consented_rate_are_the_only_publishes(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_ws_client: WebSocketGenerator, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    for ieee, name in BULBS.items():
        fire(hass, name, bulb_state(ieee))
    await hass.async_block_till_done()
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": "outglow/bulb/write_preview", "ieee": "0x0000000000000002", "setting": "sensing", "value": False}
    )
    preview = (await ws.receive_json())["result"]
    assert [e["code"] for e in preview["effects"]] == ["stops_sensing"]
    await ws.send_json_auto_id(
        {
            "type": "outglow/bulb/write",
            "ieee": "0x0000000000000002",
            "setting": "sensing",
            "value": False,
            "confirm_token": preview["confirm_token"],
        }
    )
    assert (await ws.receive_json())["success"]
    await ws.send_json_auto_id({"type": "outglow/session/start", "name": "Evening", "raise_rate": True})
    assert (await ws.receive_json())["result"]["raised_rate"] is True
    await ws.send_json_auto_id({"type": "outglow/session/stop"})
    assert (await ws.receive_json())["result"]["state"] == "stopped"
    calls = publishes(mqtt_mock)
    assert calls[0] == (f"{BASE}/Living 2/set", '{"motion_sensing":"OFF"}')
    raised = calls[1:5]
    restored = calls[5:]
    options = f"{BASE}/bridge/request/device/options"
    assert {c[0] for c in raised + restored} == {options}
    assert all('"motion_activity_rate":4' in c[1] for c in raised)
    assert all('"motion_activity_rate":2}' in c[1] for c in restored)
    assert len(restored) == len(raised) == 4
    await coordinator.async_flush_history()
    events = await hass.async_add_executor_job(coordinator.history.events, 0, clock() + 10, ["bulb_write"])
    assert len(events) == 9
    assert events[0].data["setting"] == "sensing"
    assert events[0].data["previous"] is True
