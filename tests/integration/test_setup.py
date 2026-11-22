import asyncio
import contextlib
import hashlib
import json
import threading
import time
from pathlib import Path
from typing import Any, ClassVar

import pytest
from homeassistant.components import frontend
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, DATA_PANELS
from homeassistant.config_entries import SOURCE_USER, ConfigEntry, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.typing import (
    ClientSessionGenerator,
    MqttMockHAClient,
    WebSocketGenerator,
)

import custom_components.outglow as outglow
import custom_components.outglow.coordinator as coordinator_module
from custom_components.outglow import config_flow
from custom_components.outglow.const import (
    CARDS_FILE,
    CONF_BASE_TOPIC,
    CONF_LOG_LEVEL,
    DOMAIN,
    PANEL_FILE,
    PANEL_URL_PATH,
    STATIC_URL,
    VERSION,
)
from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine import Engine
from custom_components.outglow.session import SessionManager
from custom_components.outglow.store import MODEL_KEY
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
    setup_outglow,
    with_plan,
)

MANIFEST = Path(__file__).resolve().parents[2] / "custom_components" / "outglow" / "manifest.json"


async def _setup(hass: HomeAssistant) -> MockConfigEntry:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: "zigbee2mqtt"}, unique_id="zigbee2mqtt")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def test_manifest_version_matches_const() -> None:
    assert json.loads(MANIFEST.read_text())["version"] == VERSION


async def test_setup_registers_admin_panel_and_unload_removes_it(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient
) -> None:
    entry = await _setup(hass)
    panel = hass.data[DATA_PANELS][PANEL_URL_PATH]
    assert panel.require_admin is True
    assert panel.sidebar_icon == "mdi:motion-sensor"
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert PANEL_URL_PATH not in hass.data[DATA_PANELS]


async def test_info_matches_schema(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_ws_client: WebSocketGenerator
) -> None:
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "outglow/info"})
    reply: dict[str, Any] = await client.receive_json()
    assert reply["success"], reply
    validate("info.json", reply["result"])
    assert reply["result"]["base_topic"] == "zigbee2mqtt"


async def test_info_without_entry_is_not_found(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_ws_client: WebSocketGenerator
) -> None:
    entry = await _setup(hass)
    assert await hass.config_entries.async_unload(entry.entry_id)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": "outglow/info"})
    reply = await client.receive_json()
    assert reply["error"]["code"] == "not_found"
    validate("error.json", reply["error"])


async def test_info_needs_admin(
    hass: HomeAssistant,
    mqtt_mock: MqttMockHAClient,
    hass_ws_client: WebSocketGenerator,
    hass_read_only_access_token: str,
) -> None:
    await _setup(hass)
    client = await hass_ws_client(hass, hass_read_only_access_token)
    await client.send_json_auto_id({"type": "outglow/info"})
    reply = await client.receive_json()
    assert reply["error"]["code"] == "unauthorized"


async def test_config_flow_creates_entry_once(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(config_flow, "BRIDGE_WAIT_S", 0.01)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_BASE_TOPIC: "z2m/#"})
    assert result["errors"] == {CONF_BASE_TOPIC: "invalid_topic"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_BASE_TOPIC: " z2m/ "})
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "no_bridge"
    placeholders = result["description_placeholders"]
    assert placeholders is not None
    assert placeholders["bridge"] == "no"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_BASE_TOPIC: "z2m"}
    await hass.async_block_till_done()
    again = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert again["type"] is FlowResultType.ABORT
    assert mqtt_mock.async_publish.call_count == 0


async def test_config_flow_counts_bulbs_from_the_bridge(hass: HomeAssistant, mqtt_mock: MqttMockHAClient) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    task = hass.async_create_task(hass.config_entries.flow.async_configure(result["flow_id"], {CONF_BASE_TOPIC: BASE}))
    await asyncio.sleep(0.01)
    fire(hass, "bridge/devices", devices_payload())
    for _ in range(50):
        await asyncio.sleep(0.01)
        fire(hass, "bridge/info", info_payload())
        for ieee, name in BULBS.items():
            fire(hass, name, bulb_state(ieee))
        fire(hass, "Unknown", bulb_state("0x00000000000000aa"))
        fire(hass, "Broken", "not json")
        if task.done():
            break
    result = await task
    assert result["step_id"] == "summary"
    placeholders = result["description_placeholders"]
    assert placeholders is not None
    assert placeholders["bridge"] == "yes"
    assert placeholders["bulbs"] == "4"
    assert placeholders["sensing"] == "4"
    assert placeholders["reporting"] == "4"
    assert placeholders["version"] == "2.9.1"
    assert mqtt_mock.async_publish.call_count == 0


async def test_options_flow_sets_log_level(hass: HomeAssistant, mqtt_mock: MqttMockHAClient) -> None:
    entry = await _setup(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(result["flow_id"], {CONF_LOG_LEVEL: "debug"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    assert entry.options[CONF_LOG_LEVEL] == "debug"
    assert entry.state is ConfigEntryState.LOADED


async def test_config_flow_needs_mqtt(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "mqtt_missing"


async def test_built_frontend_is_served(
    hass: HomeAssistant,
    mqtt_mock: MqttMockHAClient,
    hass_client: ClientSessionGenerator,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / PANEL_FILE).write_text("export {};")
    (tmp_path / CARDS_FILE).write_text("export {};")
    monkeypatch.setattr(outglow, "FRONTEND_DIR", tmp_path)
    await _setup(hass)
    client = await hass_client()
    reply = await client.get(f"{STATIC_URL}/{PANEL_FILE}")
    assert reply.status == 200
    assert await reply.text() == "export {};"
    tag = hashlib.sha256(b"export {};").hexdigest()[:12]
    assert f"{STATIC_URL}/{CARDS_FILE}?v={tag}" in hass.data[DATA_EXTRA_MODULE_URL].urls
    module = (hass.data[DATA_PANELS][PANEL_URL_PATH].config or {})["_panel_custom"]["module_url"]
    assert module == f"{STATIC_URL}/{PANEL_FILE}?v={tag}"


def _state(entry: ConfigEntry) -> ConfigEntryState:
    return entry.state


class _Spy(OutglowCoordinator):
    created: ClassVar[list[OutglowCoordinator]] = []

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        super().__init__(hass, entry)
        _Spy.created.append(self)


async def test_failed_setup_stops_everything_and_reload_runs_one_coordinator(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _Spy.created = []
    monkeypatch.setattr(outglow, "OutglowCoordinator", _Spy)
    broken = [True]
    resume = SessionManager.async_resume

    async def flaky(self: SessionManager, carry_on: bool = False) -> None:
        if broken[0]:
            raise HomeAssistantError("broker away")
        await resume(self, carry_on)

    monkeypatch.setattr(SessionManager, "async_resume", flaky)
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: BASE}, unique_id=BASE)
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert _state(entry) is ConfigEntryState.SETUP_RETRY
    first = _Spy.created[0]
    assert first.source._unsub is None
    assert first._tick_unsub is None
    assert first._unsubs == []
    assert first.history._db is None
    assert PANEL_URL_PATH not in hass.data.get(DATA_PANELS, {})
    broken[0] = False
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert _state(entry) is ConfigEntryState.LOADED
    assert len(_Spy.created) == 2
    fire(hass, "bridge/devices", devices_payload())
    for ieee, name in BULBS.items():
        fire(hass, name, bulb_state(ieee))
    await hass.async_block_till_done()
    assert first.source.messages == 0
    assert _Spy.created[1].source.messages == len(BULBS)


def _stored_bg_ticks(hass_storage: dict[str, Any]) -> Any:
    return hass_storage[MODEL_KEY]["data"]["engine"]["active"]["bg_ticks"]


@pytest.mark.parametrize("failure", ["cancel", "error"])
async def test_a_setup_stopped_while_the_engine_is_built_keeps_the_learned_model(
    hass: HomeAssistant,
    mqtt_mock: MqttMockHAClient,
    hass_storage: dict[str, Any],
    clock: Clock,
    monkeypatch: pytest.MonkeyPatch,
    failure: str,
) -> None:
    entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    await with_plan(hass, coordinator)
    coordinator.engine._active.bg_ticks = 1234.0
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert _stored_bg_ticks(hass_storage) == 1234.0
    started = threading.Event()

    def build(*args: Any, **kwargs: Any) -> Any:
        if len(args) >= 3 and args[2]:
            started.set()
            if failure == "error":
                raise RuntimeError("engine")
            time.sleep(0.3)
        return Engine(*args, **kwargs)

    monkeypatch.setattr(coordinator_module, "Engine", build)
    task = hass.async_create_task(hass.config_entries.async_setup(entry.entry_id))
    for _ in range(400):
        if started.is_set():
            break
        await asyncio.sleep(0.005)
    assert started.is_set()
    if failure == "cancel":
        task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task
    await hass.async_block_till_done()
    assert _stored_bg_ticks(hass_storage) == 1234.0


async def test_setup_waits_for_mqtt(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_BASE_TOPIC: BASE}, unique_id=BASE)
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_RETRY


async def test_a_foreign_panel_on_the_path_is_a_repair_not_a_failure(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient
) -> None:
    frontend.async_register_built_in_panel(
        hass, "iframe", sidebar_title="Prototype", frontend_url_path=PANEL_URL_PATH, config={"url": "/x"}
    )
    entry = await _setup(hass)
    assert entry.state is ConfigEntryState.LOADED
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "iframe"
    assert ir.async_get(hass).async_get_issue(DOMAIN, "panel_conflict") is not None
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert hass.data[DATA_PANELS][PANEL_URL_PATH].component_name == "iframe"
