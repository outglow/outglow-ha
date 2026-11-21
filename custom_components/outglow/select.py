from collections.abc import Callable
from dataclasses import replace

from homeassistant.components.select import SelectEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OutglowConfigEntry
from .coordinator import OutglowCoordinator
from .engine.types import Reaction, RoomSettings, Settings
from .entity import OutglowRoomEntity, setup_rooms

BUDGETS = {"0.1": 0.1, "0.3": 0.3, "1": 1.0, "3": 3.0, "10": 10.0}
REACTIONS = ["fast", "normal", "calm"]


async def async_setup_entry(
    hass: HomeAssistant, entry: OutglowConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    setup_rooms(
        hass,
        entry,
        coordinator,
        async_add_entities,
        [],
        lambda room: [BudgetSelect(coordinator, room), ReactionSelect(coordinator, room)],
    )


def update_room(settings: Settings, room: str, change: Callable[[RoomSettings], RoomSettings]) -> Settings:
    current = settings.rooms.get(room, RoomSettings())
    return replace(settings, rooms={**settings.rooms, room: change(current)})


def budget_option(value: float) -> str:
    return next((key for key, budget in BUDGETS.items() if abs(budget - value) < 1e-9), "1")


class BudgetSelect(OutglowRoomEntity, SelectEntity):
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: OutglowCoordinator, room_id: str) -> None:
        super().__init__(coordinator, room_id, "false_alarm_budget", "select")
        self._attr_options = list(BUDGETS)
        self._snapshot: str | None = None

    def _refresh(self) -> bool:
        value = budget_option(self.coordinator.settings.rooms.get(self.room_id, RoomSettings()).false_alarm_budget)
        if value == self._snapshot:
            return False
        self._snapshot = value
        self._attr_current_option = value
        return True

    async def async_select_option(self, option: str) -> None:
        budget = BUDGETS[option]
        await self.coordinator.async_update_settings(
            lambda s: update_room(s, self.room_id, lambda r: replace(r, false_alarm_budget=budget))
        )


class ReactionSelect(OutglowRoomEntity, SelectEntity):
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: OutglowCoordinator, room_id: str) -> None:
        super().__init__(coordinator, room_id, "reaction", "select")
        self._attr_options = list(REACTIONS)
        self._snapshot: str | None = None

    def _refresh(self) -> bool:
        value = self.coordinator.settings.rooms.get(self.room_id, RoomSettings()).reaction
        if value == self._snapshot:
            return False
        self._snapshot = value
        self._attr_current_option = value
        return True

    async def async_select_option(self, option: str) -> None:
        reaction: Reaction = "fast" if option == "fast" else "calm" if option == "calm" else "normal"
        await self.coordinator.async_update_settings(
            lambda s: update_room(s, self.room_id, lambda r: replace(r, reaction=reaction))
        )
