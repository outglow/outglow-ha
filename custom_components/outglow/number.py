from dataclasses import replace

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.const import EntityCategory, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OutglowConfigEntry
from .coordinator import OutglowCoordinator
from .engine.types import RoomSettings
from .entity import OutglowRoomEntity, setup_rooms
from .select import update_room


async def async_setup_entry(
    hass: HomeAssistant, entry: OutglowConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    setup_rooms(hass, entry, coordinator, async_add_entities, [], lambda room: [HoldTime(coordinator, room)])


class HoldTime(OutglowRoomEntity, NumberEntity):
    _attr_entity_category = EntityCategory.CONFIG
    _attr_native_min_value = 10
    _attr_native_max_value = 3600
    _attr_native_step = 1
    _attr_mode = NumberMode.BOX
    _attr_native_unit_of_measurement = UnitOfTime.SECONDS

    def __init__(self, coordinator: OutglowCoordinator, room_id: str) -> None:
        super().__init__(coordinator, room_id, "hold_time", "number")
        self._snapshot: int | None = None

    def _refresh(self) -> bool:
        value = self.coordinator.settings.rooms.get(self.room_id, RoomSettings()).hold_time_s
        if value == self._snapshot:
            return False
        self._snapshot = value
        self._attr_native_value = value
        return True

    async def async_set_native_value(self, value: float) -> None:
        seconds = round(value)
        await self.coordinator.async_update_settings(
            lambda s: update_room(s, self.room_id, lambda r: replace(r, hold_time_s=seconds))
        )
