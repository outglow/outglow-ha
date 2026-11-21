import json
import logging

import pytest
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from pytest_homeassistant_custom_component.typing import MqttMockHAClient

from custom_components.outglow.const import DOMAIN
from custom_components.outglow.engine.source import SourceClassifier
from custom_components.outglow.engine.types import LinkReading, Observation
from custom_components.outglow.mqtt_source import (
    loads_finite,
    parse_link,
    parse_observation,
    parse_online,
)
from tests.integration.common import BULBS, OTHER, Clock, bridge, bulb_state, fire, setup_outglow

RX = "0x0000000000000001"


def obs(t: float, level: int = 5) -> Observation:
    return Observation(t=t, rx=RX, links=(LinkReading(tx="0x0000000000000002", raw_activity=level),))


def test_parse_link_keeps_raw_activity_and_drops_unknown_senders() -> None:
    link = parse_link(
        {"ieee_address": "0x00000000000000AB", "activity": 12, "motion": True, "signal": -71, "noise": 0.4}
    )
    assert link == LinkReading(
        tx="0x00000000000000ab", motion=True, signal_dbm=-71, noise_db=0.4, raw_activity=12, level=None
    )
    assert parse_link({"address": "0x1234", "activity": 3}) is None
    silent = parse_link({"ieee_address": "0x0000000000000002", "signal": 0})
    assert silent is not None
    assert silent.signal_dbm is None
    assert parse_link("nope") is None


def test_parse_observation_reads_light_and_occupancy() -> None:
    data = bulb_state(RX, activity=7, motion=True, state="OFF")
    parsed = parse_observation(5.0, RX, data)
    assert parsed is not None
    assert parsed.light is not None
    assert parsed.light.on is False
    assert parsed.light.brightness == 120
    assert parsed.occupancy is True
    assert {link.tx for link in parsed.links} == set(BULBS) - {RX}
    assert all(link.level is None and link.raw_activity == 7 for link in parsed.links)
    assert parse_observation(5.0, RX, {"linkquality": 100}) is None


def test_parse_online_accepts_json_and_plain() -> None:
    assert parse_online('{"state": "online"}') is True
    assert parse_online("offline") is False
    assert parse_online("{}") is None


def test_stream_heuristic_marks_streams_as_activity() -> None:
    classifier = SourceClassifier()
    assert classifier.push(obs(100.0, 4)) == []
    out = classifier.push(obs(100.5, 6))
    assert [o.source for o in out] == ["activity", "activity"]
    assert [o.links[0].level for o in out] == [4, 6]
    assert [o.source for o in classifier.push(obs(101.0, 7))] == ["activity"]
    assert [o.source for o in classifier.push(obs(101.2, 7))] == ["unknown"]


def test_single_message_becomes_unknown_after_the_hold() -> None:
    classifier = SourceClassifier()
    assert classifier.push(obs(100.0, 9)) == []
    assert classifier.expire(101.0) == []
    flushed = classifier.expire(102.0)
    assert [o.source for o in flushed] == ["unknown"]
    assert flushed[0].links[0].level is None
    assert flushed[0].links[0].raw_activity == 9


async def test_messages_route_by_exact_name_and_skip_set_get(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _entry, coordinator = await setup_outglow(hass, clock)
    seen: list[Observation] = []
    original = coordinator.observe

    def capture(item: Observation) -> None:
        seen.append(item)
        original(item)

    monkeypatch.setattr(coordinator, "observe", capture)
    await bridge(hass)
    fire(hass, "Test/Living 1", bulb_state(RX, activity=3))
    fire(hass, "Test/Living 1/set", {"state": "ON"})
    fire(hass, "Test/Living 1/get", {"state": ""})
    fire(hass, "Test", bulb_state(RX))
    fire(hass, "Plug", {"state": "ON"})
    fire(hass, "Living 2", "not json")
    await hass.async_block_till_done()
    clock.advance(0.5)
    fire(hass, "Test/Living 1", bulb_state(RX, activity=8))
    await hass.async_block_till_done()
    assert [(o.rx, o.source) for o in seen] == [(RX, "activity"), (RX, "activity")]
    assert seen[1].links[0].level == 8
    assert coordinator.source.messages == 2
    device = coordinator.devices.get(RX)
    assert device is not None
    assert device.state["motion_sensitivity"] == 40
    assert coordinator.devices.get(OTHER) is not None
    assert coordinator.last_activity[RX] == clock()


async def test_availability_marks_bulb_offline(hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock) -> None:
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    fire(hass, "Office/availability", {"state": "offline"})
    await hass.async_block_till_done()
    assert coordinator.devices.offline() == frozenset({"0x0000000000000004"})
    infos = {b["ieee"]: b for b in coordinator.bulb_infos()}
    assert infos["0x0000000000000004"]["available"] is False
    fire(hass, "Office/availability", "online")
    await hass.async_block_till_done()
    assert coordinator.devices.offline() == frozenset()


async def test_bridge_problems_raise_repairs(hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock) -> None:
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass, output="attribute")
    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, "output_attribute") is not None
    fire(hass, "bridge/state", "offline")
    await hass.async_block_till_done()
    assert registry.async_get_issue(DOMAIN, "bridge_offline") is not None
    assert coordinator.tick().status == "degraded"
    fire(hass, "bridge/state", {"state": "online"})
    fire(hass, "bridge/info", {"version": "2.9.1", "config": {"advanced": {"output": "json"}}})
    await hass.async_block_till_done()
    assert registry.async_get_issue(DOMAIN, "output_attribute") is None
    assert registry.async_get_issue(DOMAIN, "bridge_offline") is None
    assert registry.async_get_issue(DOMAIN, "plan_missing") is None


async def test_missing_converter_and_plan_repairs(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass, sensing=False)
    registry = ir.async_get(hass)
    assert registry.async_get_issue(DOMAIN, "no_converter") is None
    clock.advance(601)
    await coordinator.async_hourly()
    assert registry.async_get_issue(DOMAIN, "no_converter") is not None
    await bridge(hass)
    for ieee, name in BULBS.items():
        fire(hass, name, bulb_state(ieee))
    await hass.async_block_till_done()
    await coordinator.async_hourly()
    assert registry.async_get_issue(DOMAIN, "no_converter") is None
    assert registry.async_get_issue(DOMAIN, "plan_missing") is not None
    clock.advance(86400)
    await coordinator.async_hourly()
    assert registry.async_get_issue(DOMAIN, f"no_activity_reports_{RX}") is not None


async def test_non_finite_numbers_drop_the_message(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    before = coordinator.source.messages
    for bad in ("NaN", "Infinity", "-Infinity", "1e999"):
        text = json.dumps(bulb_state(RX)).replace('"activity": 10', f'"activity": {bad}', 1)
        assert bad in text
        fire(hass, BULBS[RX], text)
        fire(hass, "bridge/devices", f'[{{"ieee_address": "0x0000000000000009", "friendly_name": "X", "n": {bad}}}]')
        fire(hass, "bridge/state", f'{{"state": {bad}}}')
    await hass.async_block_till_done()
    assert coordinator.source.messages == before
    assert coordinator.devices.get(RX) is not None
    assert [r.message for r in caplog.records if r.levelno >= logging.ERROR] == []


def test_loads_finite_rejects_nan_and_infinity() -> None:
    for bad in ("NaN", "Infinity", "-Infinity", "1e999"):
        with pytest.raises(ValueError, match="finite"):
            loads_finite(f'{{"a": {bad}}}')
    assert loads_finite('{"a": 1.5, "b": [2]}') == {"a": 1.5, "b": [2]}
