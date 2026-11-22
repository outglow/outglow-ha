import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from homeassistant.components.repairs import repairs_flow_manager
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers import issue_registry as ir
from homeassistant.setup import async_setup_component
from pytest_homeassistant_custom_component.typing import MqttMockHAClient, WebSocketGenerator

from custom_components.outglow import async_remove_entry
from custom_components.outglow.const import DOMAIN
from custom_components.outglow.coordinator import OutglowCoordinator
from custom_components.outglow.engine.types import RoomSettings
from custom_components.outglow.store import COPIES_KEY, PLAN_KEY, SETTINGS_KEY
from tests.integration.common import BULBS, Clock, bridge, bulb_state, fire, plan_json, setup_outglow, with_plan
from tests.integration.test_websocket import Client

OLD = ["hall", "living", "office"]


@pytest.fixture
async def ready(
    hass: HomeAssistant, mqtt_mock: MqttMockHAClient, hass_ws_client: WebSocketGenerator, clock: Clock
) -> tuple[OutglowCoordinator, Client]:
    _entry, coordinator = await setup_outglow(hass, clock)
    await bridge(hass)
    await with_plan(hass, coordinator)
    await coordinator.async_update_settings(
        lambda s: replace(s, rooms={**s.rooms, "office": RoomSettings(hold_time_s=120)})
    )
    for ieee in BULBS:
        fire(hass, BULBS[ieee], bulb_state(ieee))
    await hass.async_block_till_done()
    return coordinator, Client(await hass_ws_client(hass))


def _copies(hass_storage: dict[str, Any]) -> list[str]:
    return sorted(key for key in hass_storage if key.startswith(f"{PLAN_KEY}.corrupt-"))


def _issues(hass: HomeAssistant) -> set[str]:
    return {key for d, key in ir.async_get(hass).issues if d == DOMAIN}


def _rooms_in_registry(hass: HomeAssistant, entry_id: str) -> set[str]:
    entities = er.async_entries_for_config_entry(er.async_get(hass), entry_id)
    found = {room for e in entities for room in OLD if f"_{room}_" in e.unique_id}
    devices = dr.async_entries_for_config_entry(dr.async_get(hass), entry_id)
    return found | {room for d in devices for _, item in d.identifiers for room in OLD if item.endswith(f"_{room}")}


async def _restart(
    hass: HomeAssistant, storage: dict[str, Any], coordinator: OutglowCoordinator, rooms: object = None
) -> OutglowCoordinator:
    entry = coordinator.entry
    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    if rooms is not None:
        stored = storage[PLAN_KEY]
        storage[PLAN_KEY] = {**stored, "data": {**stored["data"], "rooms": rooms}}
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    fresh: OutglowCoordinator = entry.runtime_data
    return fresh


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _kitchen_plan(rev: int, room_id: str = "kitchen") -> dict[str, Any]:
    plan = plan_json(rev)
    kitchen = {**plan["rooms"][0], "id": room_id, "name": "Kitchen"}
    return {**plan, "rooms": [kitchen], "adjacent": [], "bulbs": [{**b, "room": None} for b in plan["bulbs"]]}


async def _flow(hass: HomeAssistant, step: str | None = None, data: dict[str, Any] | None = None) -> Any:
    assert await async_setup_component(hass, "repairs", {})
    manager = repairs_flow_manager(hass)
    assert manager is not None
    result = await manager.async_init(DOMAIN, data={"issue_id": "plan_unreadable"})
    assert result["type"] is FlowResultType.MENU
    if step is None:
        return result
    result = await manager.async_configure(result["flow_id"], {"next_step_id": step})
    if data is not None and result["type"] is FlowResultType.FORM:
        result = await manager.async_configure(result["flow_id"], data)
    await hass.async_block_till_done()
    return result


async def test_a_new_plan_drawn_after_an_unreadable_one_retires_the_old_rooms(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, client = ready
    fresh = await _restart(hass, hass_storage, coordinator, [{"id": 5}])
    entry_id = fresh.entry.entry_id
    assert _rooms_in_registry(hass, entry_id) == set(OLD)
    got = await client.ok("outglow/plan/get")
    assert got["reserved_rooms"] == OLD
    saved = await client.ok("outglow/plan/save", rev=got["rev"], plan=_kitchen_plan(got["rev"]))
    await hass.async_block_till_done()
    assert saved["retired_rooms"] == OLD
    assert _rooms_in_registry(hass, entry_id) == set()
    assert "plan_unreadable" not in _issues(hass)
    assert set(fresh.settings.rooms) == {"kitchen"}
    assert (await client.ok("outglow/plan/get"))["reserved_rooms"] == []
    again = await _restart(hass, hass_storage, fresh)
    assert _rooms_in_registry(hass, entry_id) == set()
    assert again.plan_copy is None
    office = _kitchen_plan(again.plan.rev, "office")
    office["rooms"].append(_kitchen_plan(0)["rooms"][0])
    await client.error("outglow/plan/save", "invalid_format", rev=again.plan.rev, plan=office)


async def test_a_save_without_rooms_keeps_the_repair_and_the_old_rooms(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, client = ready
    fresh = await _restart(hass, hass_storage, coordinator, [{"id": 5}])
    got = await client.ok("outglow/plan/get")
    a, b = sorted(BULBS)[:2]
    plan = {**got["plan"], "excluded_directions": [{"rx": a, "tx": b, "reason": "user"}]}
    await client.ok("outglow/plan/save", rev=got["rev"], plan=plan)
    await hass.async_block_till_done()
    assert "plan_unreadable" in _issues(hass)
    assert fresh.settings.rooms["office"].hold_time_s == 120
    assert hass_storage[SETTINGS_KEY]["data"]["rooms"]["office"]["hold_time_s"] == 120
    again = await _restart(hass, hass_storage, fresh)
    assert again.plan.excluded_directions
    assert again.plan_copy is not None
    assert "plan_unreadable" in _issues(hass)
    assert _rooms_in_registry(hass, again.entry.entry_id) == set(OLD)
    assert again.settings.rooms["office"].hold_time_s == 120


async def test_an_unreadable_plan_is_copied_once_and_at_most_three_copies_are_kept(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, _client = ready
    fresh = await _restart(hass, hass_storage, coordinator, [{"id": 5}])
    for _ in range(4):
        fresh = await _restart(hass, hass_storage, fresh)
    assert len(_copies(hass_storage)) == 1
    first = _copies(hass_storage)[0]
    for n in range(6, 9):
        fresh = await _restart(hass, hass_storage, fresh, [{"id": n}])
    kept = _copies(hass_storage)
    assert len(kept) == 3
    assert first not in kept
    assert [hass_storage[key]["data"]["rooms"] for key in kept] == [[{"id": 6}], [{"id": 7}], [{"id": 8}]]
    assert fresh.plan_copy is not None
    assert fresh.plan_copy.endswith(kept[-1])
    entry = fresh.entry
    assert await hass.config_entries.async_unload(entry.entry_id)
    await async_remove_entry(hass, entry)
    assert _copies(hass_storage) == []
    assert COPIES_KEY not in hass_storage


async def test_the_repair_restores_the_fixed_copy_and_keeps_every_entity_id(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, client = ready
    registry = er.async_get(hass)
    uid = f"{coordinator.entry.entry_id}_office_occupancy"
    old = registry.async_get_entity_id("binary_sensor", DOMAIN, uid)
    assert old is not None
    registry.async_update_entity(old, new_entity_id="binary_sensor.my_office")
    good = json.loads(json.dumps(hass_storage[PLAN_KEY]))
    fresh = await _restart(hass, hass_storage, coordinator, [{"id": 5}])
    assert (await _flow(hass, "restore"))["reason"] == "still_unreadable"
    assert "plan_unreadable" in _issues(hass)
    copy = _copies(hass_storage)[0]
    hass_storage[copy] = {**hass_storage[copy], "data": good["data"]}
    result = await _flow(hass, "restore")
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert [room.id for room in fresh.plan.rooms] == ["living", "hall", "office"]
    assert hass_storage[PLAN_KEY]["data"]["rooms"][2]["id"] == "office"
    assert registry.async_get("binary_sensor.my_office") is not None
    assert fresh.settings.rooms["office"].hold_time_s == 120
    assert "plan_unreadable" not in _issues(hass)
    assert (await client.ok("outglow/plan/get"))["reserved_rooms"] == []


async def test_the_repair_discards_the_old_plan(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, _client = ready
    fresh = await _restart(hass, hass_storage, coordinator, [{"id": 5}])
    form = await _flow(hass, "discard")
    assert form["type"] is FlowResultType.FORM
    assert form["description_placeholders"]["rooms"] == ", ".join(OLD)
    manager = repairs_flow_manager(hass)
    assert manager is not None
    await manager.async_configure(form["flow_id"], {})
    await hass.async_block_till_done()
    assert fresh.plan.retired_rooms == tuple(OLD)
    assert _rooms_in_registry(hass, fresh.entry.entry_id) == set()
    assert "plan_unreadable" not in _issues(hass)
    again = await _restart(hass, hass_storage, fresh)
    assert again.plan_copy is None
    assert "plan_unreadable" not in _issues(hass)


async def test_a_plan_file_home_assistant_set_aside_as_corrupt_gets_the_same_repair(
    hass: HomeAssistant, ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    coordinator, _client = ready
    entry = coordinator.entry
    good = json.loads(json.dumps(hass_storage[PLAN_KEY]))
    assert await hass.config_entries.async_unload(entry.entry_id)
    hass_storage.pop(PLAN_KEY)
    name = f"{PLAN_KEY}.corrupt.2026-11-21T10:00:00.000000+00:00"
    path = Path(hass.config.path(".storage", name))
    await hass.async_add_executor_job(_write, path, "{not json")
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    fresh: OutglowCoordinator = entry.runtime_data
    assert fresh.plan_copy == str(path)
    assert "plan_unreadable" in _issues(hass)
    assert _rooms_in_registry(hass, entry.entry_id) == set(OLD)
    await fresh.async_update_settings(lambda s: s)
    assert hass_storage[SETTINGS_KEY]["data"]["rooms"]["office"]["hold_time_s"] == 120
    hass_storage[name] = good
    assert (await _flow(hass, "restore"))["type"] is FlowResultType.CREATE_ENTRY
    assert [room.id for room in fresh.plan.rooms] == ["living", "hall", "office"]
    assert "plan_unreadable" not in _issues(hass)


@pytest.mark.parametrize(
    "data",
    [{"rooms": [], "bulbs": 5}, {"rooms": [], "excluded_directions": 7}],
)
async def test_an_import_with_wrong_types_is_an_invalid_format(
    ready: tuple[OutglowCoordinator, Client], data: dict[str, Any]
) -> None:
    _coordinator, client = ready
    text = json.dumps({"version": 1, "minor_version": 1, "key": f"{PLAN_KEY}.corrupt-x", "data": data})
    await client.error("outglow/plan/import", "invalid_format", format="outglow_json", text=text)
    await client.error("outglow/plan/save", "invalid_format", rev=_coordinator.plan.rev, plan=data)


async def test_a_stored_plan_file_reads_the_same_in_any_format(
    ready: tuple[OutglowCoordinator, Client], hass_storage: dict[str, Any]
) -> None:
    _coordinator, client = ready
    text = json.dumps({**hass_storage[PLAN_KEY], "key": f"{PLAN_KEY}.corrupt-x"})
    for fmt in ("mieszkanie_yaml", "outglow_json"):
        imported = await client.ok("outglow/plan/import", format=fmt, text=text)
        assert [room["id"] for room in imported["plan"]["rooms"]] == ["living", "hall", "office"]
        assert imported["warnings"] == []
