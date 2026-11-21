import json
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import pytest
from homeassistant.auth.models import User
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import ServiceValidationError, Unauthorized
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import async_fire_time_changed
from pytest_homeassistant_custom_component.components.diagnostics import get_diagnostics_for_config_entry
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator, MqttMockHAClient

from custom_components.outglow.const import DOMAIN
from custom_components.outglow.engine.types import LinkReading, Observation
from tests.integration.common import (
    BASE,
    BULBS,
    Clock,
    bridge,
    bulb_state,
    fire,
    pending_labels,
    setup_outglow,
    with_plan,
)


async def test_diagnostics_redact_addresses_names_and_shapes(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_client: ClientSessionGenerator, clock: Clock
) -> None:
    entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    await coordinator.async_update_settings(lambda s: replace(s, global_=replace(s.global_, persons=("person.alex",))))
    for ieee, name in BULBS.items():
        fire(hass, name, bulb_state(ieee))
    await hass.async_block_till_done()
    coordinator.tick()
    data = await get_diagnostics_for_config_entry(hass, hass_client, entry)
    text = json.dumps(data)
    for ieee, name in BULBS.items():
        assert ieee not in text
        assert name not in text
    assert "person.alex" not in text
    assert "Living room" not in text
    assert "[0, 0]" not in text
    living = data["plan"]["rooms"][0]
    assert living == {"id": "living", "points": 4, "size_m": [5.0, 4.0], "entrance": False}
    assert data["bulbs"][0]["ieee"].startswith("bulb_")
    assert data["bulbs"][0]["name"] == "**REDACTED**"
    assert data["stats"]["ticks_measured"] >= 1
    assert data["stats"]["tick_ms_p99"] is not None
    assert data["history_rows"]["raw"] >= 0


async def test_services_feedback_label_and_session(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    await hass.services.async_call(DOMAIN, "feedback", {"room": "living", "kind": "missed"}, blocking=True)
    await hass.services.async_call(DOMAIN, "label", {"empty": True, "activity": "still", "duration": 30}, blocking=True)
    await hass.services.async_call(
        DOMAIN, "label", {"room": "Hall", "activity": "transition", "duration": 5}, blocking=True
    )
    labels = await pending_labels(hass, coordinator)
    assert sorted((lb.kind, lb.room or "", lb.source) for lb in labels) == [
        ("empty", "", "service"),
        ("room", "living", "feedback"),
        ("transition", "hall", "service"),
    ]
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "feedback", {"room": "attic", "kind": "missed"}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "label", {"activity": "walk"}, blocking=True)
    await hass.services.async_call(DOMAIN, "start_session", {"name": "x"}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "start_session", {"name": "y"}, blocking=True)
    await hass.services.async_call(DOMAIN, "stop_session", {}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "stop_session", {}, blocking=True)
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "reset_learning", {"room": "attic"}, blocking=True)
    await hass.services.async_call(DOMAIN, "reset_learning", {"room": "Living room"}, blocking=True)
    assert coordinator.model_version == 1
    assert coordinator.engine.pending_id() is not None
    await hass.services.async_call(DOMAIN, "reset_learning", {}, blocking=True)
    assert coordinator.model_version == 2
    assert coordinator.engine.pending_id() is None
    reasons = [s["reason"] for s in coordinator.model.snapshot_list()]
    assert reasons == ["before_session", "before_reset", "before_reset"]


async def test_export_recording_writes_jsonl_v2(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, config_dir: Path
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    coordinator.observe(Observation(t=clock(), rx="0x0000000000000001", links=(LinkReading(tx="0x0000000000000002"),)))
    await hass.services.async_call(DOMAIN, "feedback", {"room": "living", "kind": "missed"}, blocking=True)
    start, end = clock() - 100, clock() + 100
    result = await hass.services.async_call(
        DOMAIN,
        "export_recording",
        {"start": _iso(start), "end": _iso(end)},
        blocking=True,
        return_response=True,
    )
    assert result is not None
    path = Path(str(result["path"]))
    assert path.parent == config_dir / "outglow" / "exports"
    text = await hass.async_add_executor_job(path.read_text)
    lines = [json.loads(line) for line in text.splitlines()]
    assert lines[0]["type"] == "header"
    assert lines[0]["format"] == 2
    assert [line["type"] for line in lines[1:]] == ["bulb", "label"]
    assert lines[1]["name"] == "Test/Living 1"


async def test_write_bulb_setting_needs_confirm_and_admin(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, hass_read_only_user: User
) -> None:
    await setup_outglow(hass)
    await bridge(hass)
    fire(hass, "Hall", bulb_state("0x0000000000000003"))
    await hass.async_block_till_done()
    with pytest.raises(Exception, match="confirm"):
        await hass.services.async_call(
            DOMAIN,
            "write_bulb_setting",
            {"bulb": "Hall", "setting": "probes", "value": 3, "confirm": False},
            blocking=True,
        )
    with pytest.raises(Unauthorized):
        await hass.services.async_call(
            DOMAIN,
            "write_bulb_setting",
            {"bulb": "Hall", "setting": "probes", "value": 3, "confirm": True},
            blocking=True,
            context=Context(user_id=hass_read_only_user.id),
        )
    assert mqtt_mock.async_publish.call_count == 0
    result = await hass.services.async_call(
        DOMAIN,
        "write_bulb_setting",
        {"bulb": "0x0000000000000003", "setting": "calibrate", "value": "start", "confirm": True},
        blocking=True,
        return_response=True,
    )
    assert result is not None
    assert result["effects"] == ["starts_calibration", "overwrites_all_lines"]
    assert mqtt_mock.async_publish.call_args.args[:2] == (f"{BASE}/Hall/set", '{"motion_calibrate":"start"}')
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN,
            "write_bulb_setting",
            {"bulb": "Nope", "setting": "probes", "value": 3, "confirm": True},
            blocking=True,
        )


async def test_nightly_calibration_proposes_a_model(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await with_plan(hass, coordinator)
    for i in range(10):
        coordinator.observe(Observation(t=clock() + i, rx="0x0000000000000001"))
    await coordinator.async_copy_empty(clock(), clock() + 3600)
    clock.advance(3600)
    short = await coordinator.async_calibrate()
    assert {room.status for room in short.rooms.values()} == {"uncertain"}
    assert coordinator.model_summary()["pending"] is None
    await coordinator.async_copy_empty(clock(), clock() + 3 * 3600)
    clock.advance(3 * 3600)
    result = await coordinator.async_calibrate()
    assert set(result.rooms) == {"living", "hall", "office"}
    assert all(0.0 < room.a_on < 1.0 for room in result.rooms.values())
    assert coordinator.model_version == 0
    assert coordinator.model.book["last_calibration"] == clock()
    assert [s["reason"] for s in coordinator.model.snapshot_list()] == ["daily", "daily"]
    assert coordinator.last_quality is not None
    pending = coordinator.model_summary()["pending"]
    assert isinstance(pending, dict)
    after = {change["room"]: change["a_on_after"] for change in pending["rooms"]}
    assert after == {room: c.a_on for room, c in result.rooms.items()}
    assert (await coordinator.async_apply(pending["pending_id"]))["model_version"] == 1
    assert coordinator.model_version == 1


def _iso(t: float) -> str:
    return dt_util.utc_from_timestamp(t).isoformat()


async def test_calibration_runs_at_half_past_three(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    calls: list[float] = []

    async def fake() -> None:
        calls.append(clock())

    monkeypatch.setattr(coordinator, "async_calibrate", fake)
    now = dt_util.now()
    target = now.replace(hour=3, minute=30, second=0, microsecond=0) + timedelta(days=1)
    async_fire_time_changed(hass, target)
    await hass.async_block_till_done()
    assert calls == [clock()]


async def test_session_services_need_admin(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock, hass_read_only_user: User
) -> None:
    await setup_outglow(hass)
    with pytest.raises(Unauthorized):
        await hass.services.async_call(
            DOMAIN, "start_session", {"name": "x"}, blocking=True, context=Context(user_id=hass_read_only_user.id)
        )
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(
            DOMAIN,
            "feedback",
            {"room": "x", "kind": "missed"},
            blocking=True,
            context=Context(user_id=hass_read_only_user.id),
        )
