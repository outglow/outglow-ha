from collections.abc import Callable, Hashable, Iterable

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.util import slugify

from .const import DOMAIN, SIGNAL_PLAN, VERSION, VOLATILE_ATTRIBUTES_S
from .coordinator import OutglowCoordinator


def hub_device(coordinator: OutglowCoordinator) -> DeviceInfo:
    return DeviceInfo(
        identifiers={(DOMAIN, coordinator.entry.entry_id)},
        name="Outglow",
        manufacturer="Outglow",
        model="Motion from Outglow bulbs",
        sw_version=VERSION,
    )


def room_device(coordinator: OutglowCoordinator, room_id: str) -> DeviceInfo:
    room = next((r for r in coordinator.plan.rooms if r.id == room_id), None)
    name = room.name if room is not None else room_id
    return DeviceInfo(
        identifiers={(DOMAIN, f"{coordinator.entry.entry_id}_{room_id}")},
        name=f"{name} · Outglow",
        manufacturer="Outglow",
        model="Room",
    )


class OutglowEntity(Entity):
    _attr_has_entity_name = True
    _attr_should_poll = False
    _volatile_s = VOLATILE_ATTRIBUTES_S

    def __init__(self, coordinator: OutglowCoordinator, key: str, domain: str) -> None:
        self.coordinator = coordinator
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = hub_device(coordinator)
        self.entity_id = f"{domain}.outglow_{key}"
        self._written_key: Hashable = None
        self._written_volatile: Hashable = None
        self._written_at: float | None = None

    def _due(self, key: Hashable, volatile: Hashable = None) -> bool:
        now = self.coordinator.now()
        same = self._written_at is not None and key == self._written_key
        if same and (volatile == self._written_volatile or now - (self._written_at or now) < self._volatile_s):
            return False
        self._written_key, self._written_volatile, self._written_at = key, volatile, now
        return True

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(self.coordinator.async_add_listener(self._handle_update))
        self._refresh()

    def _refresh(self) -> bool:
        return True

    @callback
    def _handle_update(self) -> None:
        if self._refresh():
            self.async_write_ha_state()


class OutglowRoomEntity(OutglowEntity):
    def __init__(self, coordinator: OutglowCoordinator, room_id: str, key: str, domain: str) -> None:
        super().__init__(coordinator, key, domain)
        self.room_id = room_id
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{room_id}_{key}"
        self._attr_device_info = room_device(coordinator, room_id)
        self.entity_id = f"{domain}.outglow_room_{slugify(room_id)}_{key}"

    @property
    def room_present(self) -> bool:
        return any(room.id == self.room_id for room in self.coordinator.plan.rooms)


def setup_rooms(
    hass: HomeAssistant,
    entry: ConfigEntry,
    coordinator: OutglowCoordinator,
    add: AddConfigEntryEntitiesCallback,
    hub: Iterable[Entity],
    per_room: Callable[[str], Iterable[Entity]],
) -> None:
    added: set[str] = set()

    @callback
    def plan_changed() -> None:
        current = {room.id for room in coordinator.plan.rooms}
        added.intersection_update(current)
        fresh = [room.id for room in coordinator.plan.rooms if room.id not in added]
        entities = [entity for room in fresh for entity in per_room(room)]
        added.update(fresh)
        if entities:
            add(entities)

    hub_entities = list(hub)
    if hub_entities:
        add(hub_entities)
    plan_changed()
    entry.async_on_unload(async_dispatcher_connect(hass, f"{SIGNAL_PLAN}_{entry.entry_id}", plan_changed))
