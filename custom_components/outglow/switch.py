from dataclasses import replace
from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OutglowConfigEntry
from .coordinator import OutglowCoordinator
from .engine.types import Settings
from .entity import OutglowEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: OutglowConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    async_add_entities([GlobalSwitch(coordinator, "sensing"), GlobalSwitch(coordinator, "learning")])


class GlobalSwitch(OutglowEntity, SwitchEntity):
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, coordinator: OutglowCoordinator, field: str) -> None:
        super().__init__(coordinator, field, "switch")
        self._field = field
        self._snapshot: bool | None = None

    def _value(self) -> bool:
        return bool(getattr(self.coordinator.settings.global_, self._field))

    def _refresh(self) -> bool:
        value = self._value()
        if value == self._snapshot:
            return False
        self._snapshot = value
        self._attr_is_on = value
        return True

    async def _async_set(self, value: bool) -> None:
        def change(s: Settings) -> Settings:
            g = replace(s.global_, sensing=value) if self._field == "sensing" else replace(s.global_, learning=value)
            return replace(s, global_=g)

        await self.coordinator.async_update_settings(change)

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._async_set(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._async_set(False)
