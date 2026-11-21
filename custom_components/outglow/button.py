from homeassistant.components.button import ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OutglowConfigEntry
from .coordinator import OutglowCoordinator
from .entity import OutglowEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: OutglowConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    async_add_entities([DeleteHistory(entry.runtime_data)])


class DeleteHistory(OutglowEntity, ButtonEntity):
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: OutglowCoordinator) -> None:
        super().__init__(coordinator, "delete_motion_history", "button")

    async def async_press(self) -> None:
        await self.coordinator.async_delete_history()
