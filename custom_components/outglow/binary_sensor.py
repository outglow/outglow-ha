from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OutglowConfigEntry
from .const import MOTION_OFF_DELAY_S
from .coordinator import OutglowCoordinator
from .entity import OutglowEntity, OutglowRoomEntity, setup_rooms


async def async_setup_entry(
    hass: HomeAssistant, entry: OutglowConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    setup_rooms(
        hass,
        entry,
        coordinator,
        async_add_entities,
        [HomeMotion(coordinator)],
        lambda room: [RoomOccupancy(coordinator, room)],
    )


class RoomOccupancy(OutglowRoomEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.OCCUPANCY
    _unrecorded_attributes = frozenset({"probability", "top_pairs"})

    def __init__(self, coordinator: OutglowCoordinator, room_id: str) -> None:
        super().__init__(coordinator, room_id, "occupancy", "binary_sensor")
        self._last_motion: float | None = None
        self._motion: bool | None = None

    def _refresh(self) -> bool:
        c = self.coordinator
        frame = c.frame
        rf = frame.rooms.get(self.room_id) if frame is not None else None
        motion = rf.motion if rf is not None else False
        if frame is not None and rf is not None and motion != self._motion:
            if motion or self._motion is not None:
                self._last_motion = frame.t
            self._motion = motion
        available = self.room_present and c.settings.global_.sensing and rf is not None and rf.coverage != "none"
        on = rf.occupied if rf is not None else False
        coverage = rf.coverage if rf is not None else "none"
        version = frame.model_version if frame is not None else c.model_version
        probability = round(rf.p, 2) if rf is not None else 0.0
        top = tuple(rf.top_pairs) if rf is not None else ()
        key = (available, on, coverage, version)
        if not self._due(key, (motion, self._last_motion, probability, top)):
            return False
        names = c.devices.names()
        self._attr_available = available
        self._attr_is_on = on
        self._attr_extra_state_attributes = {
            "motion": motion,
            "probability": probability,
            "last_motion": self._last_motion,
            "top_pairs": [f"{names.get(a, a)} - {names.get(b, b)}" for a, b in top],
            "coverage": coverage,
            "model_version": version,
        }
        return True


class HomeMotion(OutglowEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.MOTION

    def __init__(self, coordinator: OutglowCoordinator) -> None:
        super().__init__(coordinator, "home_motion", "binary_sensor")
        self._moved: float | None = None

    def _refresh(self) -> bool:
        c = self.coordinator
        frame = c.frame
        available = c.settings.global_.sensing and frame is not None and c.plan_problem is None
        if frame is not None and any(rf.motion for rf in frame.rooms.values()):
            self._moved = frame.t
        on = frame is not None and self._moved is not None and frame.t - self._moved < MOTION_OFF_DELAY_S
        if not self._due((available, on)):
            return False
        self._attr_available = available
        self._attr_is_on = on
        return True
