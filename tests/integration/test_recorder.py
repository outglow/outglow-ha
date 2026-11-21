from pathlib import Path

import pytest
from homeassistant.components.recorder import Recorder, get_instance
from homeassistant.components.recorder.db_schema import States, StatesMeta
from homeassistant.components.recorder.util import session_scope
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.components.recorder.common import async_wait_recording_done
from pytest_homeassistant_custom_component.typing import MqttMockHAClient

from custom_components.outglow.engine.types import Frame, Gate, RoomFrame
from tests.integration.common import BULBS, Clock, bridge, setup_outglow, with_plan

WATCHED = (
    "binary_sensor.outglow_room_living_occupancy",
    "binary_sensor.outglow_room_hall_occupancy",
    "binary_sensor.outglow_home_motion",
    "sensor.outglow_motion_room",
    "sensor.outglow_status",
)
IEEES = sorted(BULBS)


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(recorder_db_url: str, enable_custom_integrations: None) -> None:
    return None


@pytest.fixture(autouse=True)
def config_dir(recorder_db_url: str, hass: HomeAssistant, tmp_path: Path) -> Path:
    hass.config.config_dir = str(tmp_path)
    return tmp_path


def _rows(hass: HomeAssistant) -> dict[str, int]:
    with session_scope(hass=hass, read_only=True) as session:
        found = (
            session.query(StatesMeta.entity_id, States.state_id)
            .join(States, States.metadata_id == StatesMeta.metadata_id)
            .filter(StatesMeta.entity_id.in_(WATCHED))
            .all()
        )
    counts = dict.fromkeys(WATCHED, 0)
    for entity_id, _state in found:
        counts[entity_id] += 1
    return counts


def _moving(t: float, i: int) -> Frame:
    pairs = ((IEEES[0], IEEES[1]), (IEEES[1], IEEES[2]))
    gates: dict[str, Gate] = {ieee: "open" if (i + n) % 3 else "closed" for n, ieee in enumerate(IEEES)}
    starts = tuple(("living" if k % 2 else "hall", t - (i - k) * 0.5) for k in range(i) if k % 3 == 1)
    return Frame(
        t=t,
        status="ready",
        model_version=1,
        rooms={
            "living": RoomFrame(
                p=0.9 + 0.01 * (i % 10),
                motion=i % 3 != 0,
                occupied=True,
                since=t - i * 0.5,
                coverage="good",
                top_pairs=pairs if i % 2 else pairs[::-1],
            ),
            "hall": RoomFrame(p=0.6 + 0.02 * (i % 7), motion=i % 4 == 0, occupied=True, since=t - 1.0, coverage="good"),
            "office": RoomFrame(p=0.01 * (i % 5), coverage="weak"),
        },
        gates=gates,
        trail=starts[-10:],
    )


async def test_continuous_motion_writes_few_states(
    recorder_mock: Recorder, hass: HomeAssistant, mqtt_mock: MqttMockHAClient, clock: Clock
) -> None:
    _entry, coordinator = await setup_outglow(hass)
    await bridge(hass)
    await with_plan(hass, coordinator)
    await async_wait_recording_done(hass)
    before = await get_instance(hass).async_add_executor_job(_rows, hass)
    start = clock()
    for i in range(600):
        coordinator.set_frame(_moving(clock.advance(0.5), i))
    await hass.async_block_till_done()
    await async_wait_recording_done(hass)
    after = await get_instance(hass).async_add_executor_job(_rows, hass)
    written = {entity: after[entity] - before[entity] for entity in WATCHED}
    minutes = (clock() - start) / 60
    assert written["binary_sensor.outglow_room_living_occupancy"] <= minutes + 2
    assert written["binary_sensor.outglow_room_hall_occupancy"] <= minutes + 2
    assert written["binary_sensor.outglow_home_motion"] <= 2
    assert written["sensor.outglow_motion_room"] <= minutes + 3
    assert written["sensor.outglow_status"] <= 3
    state = hass.states.get("binary_sensor.outglow_room_living_occupancy")
    assert state is not None
    assert start < state.attributes["last_motion"] <= clock()
