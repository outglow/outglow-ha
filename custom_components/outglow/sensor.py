import math
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorStateClass
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import OutglowConfigEntry
from .const import MOTION_ROOM_DWELL_S, STATUS_VOLATILE_S, TRAIL_LEN
from .coordinator import OutglowCoordinator
from .entity import OutglowEntity, OutglowRoomEntity, setup_rooms

STATUSES = ["learning", "ready", "degraded", "paused", "plan_too_large"]
NONE = "none"


async def async_setup_entry(
    hass: HomeAssistant, entry: OutglowConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
) -> None:
    coordinator = entry.runtime_data
    setup_rooms(
        hass,
        entry,
        coordinator,
        async_add_entities,
        [MotionRoom(coordinator), Status(coordinator)],
        lambda room: [FalseAlarms(coordinator, room)],
    )


def motion_room(coordinator: OutglowCoordinator, shown: str = NONE) -> str:
    frame = coordinator.frame
    if frame is None:
        return NONE
    moving = [(rf.p, room == shown, rf.since or 0.0, room) for room, rf in frame.rooms.items() if rf.motion]
    if moving:
        return max(moving)[3]
    held = [(rf.since or 0.0, rf.p, room) for room, rf in frame.rooms.items() if rf.occupied]
    return max(held)[2] if held else NONE


class MotionRoom(OutglowEntity, SensorEntity):
    _attr_device_class = SensorDeviceClass.ENUM
    _unrecorded_attributes = frozenset({"rooms"})

    def __init__(self, coordinator: OutglowCoordinator) -> None:
        super().__init__(coordinator, "motion_room", "sensor")
        self._shown = NONE
        self._candidate = NONE
        self._candidate_since = 0.0
        self._moved: dict[str, float] = {}

    def _settle(self) -> str:
        c = self.coordinator
        frame = c.frame
        best = motion_room(c, self._shown)
        if frame is not None:
            self._moved.update((room, frame.t) for room, rf in frame.rooms.items() if rf.motion)
        if frame is None or best == self._shown:
            self._candidate = best
            return self._shown
        if best != self._candidate:
            self._candidate, self._candidate_since = best, frame.t
        shown = frame.rooms.get(self._shown)
        candidate = frame.rooms.get(best)
        gone = shown is None or not shown.occupied
        active = frame.t - self._moved.get(self._shown, -math.inf) < MOTION_ROOM_DWELL_S
        fresh = candidate is not None and candidate.motion and not active
        if gone or fresh or frame.t - self._candidate_since >= MOTION_ROOM_DWELL_S:
            self._shown = best
        return self._shown

    def _refresh(self) -> bool:
        c = self.coordinator
        frame = c.frame
        options = [*(room.id for room in c.plan.rooms), NONE]
        state = self._settle()
        rooms = {room: round(rf.p, 2) for room, rf in frame.rooms.items()} if frame else {}
        trail = tuple((room, t) for room, t in frame.trail[-TRAIL_LEN:]) if frame else ()
        g = c.settings.global_
        person = next(iter(c.house.persons_home)) if g.use_persons and len(c.house.persons_home) == 1 else None
        available = g.sensing and frame is not None and c.plan_problem is None
        if not self._due((available, state, person, tuple(options)), (trail, tuple(sorted(rooms.items())))):
            return False
        attrs: dict[str, Any] = {"rooms": rooms, "trail": [list(item) for item in trail]}
        if person is not None:
            attrs["likely_person"] = person
        self._attr_options = options
        self._attr_available = available
        self._attr_native_value = state
        self._attr_extra_state_attributes = attrs
        return True


class Status(OutglowEntity, SensorEntity):
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_options = STATUSES
    _unrecorded_attributes = frozenset({"bulbs_active", "bulbs_quiet", "empty_house_hours"})
    _volatile_s = STATUS_VOLATILE_S

    def __init__(self, coordinator: OutglowCoordinator) -> None:
        super().__init__(coordinator, "status", "sensor")

    def _refresh(self) -> bool:
        c = self.coordinator
        frame = c.frame
        status: str = frame.status if frame is not None else ("learning" if c.settings.global_.sensing else "paused")
        if c.plan_problem is not None and status != "paused":
            status = "plan_too_large"
        gates = frame.gates if frame is not None else {}
        summary = c.model_summary()
        steady = {
            "bulbs_offline": sum(1 for g in gates.values() if g == "offline"),
            "last_calibration": c.model.book.get("last_calibration"),
            "model_version": summary["model_version"],
            "pending": summary["pending"] is not None,
        }
        volatile = {
            "bulbs_active": sum(1 for g in gates.values() if g == "open"),
            "bulbs_quiet": sum(1 for g in gates.values() if g == "closed"),
            "empty_house_hours": round(float(summary["empty_house_hours"] or 0.0), 1),
        }
        if not self._due((status, str(steady)), str(volatile)):
            return False
        self._attr_native_value = status
        self._attr_extra_state_attributes = {**volatile, **steady}
        return True


class FalseAlarms(OutglowRoomEntity, SensorEntity):
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, coordinator: OutglowCoordinator, room_id: str) -> None:
        super().__init__(coordinator, room_id, "false_alarms_24h", "sensor")
        self._snapshot: tuple[bool, int] | None = None

    def _refresh(self) -> bool:
        value = self.coordinator.false_alarms_24h(self.room_id)
        snapshot = (self.room_present, value)
        if snapshot == self._snapshot:
            return False
        self._snapshot = snapshot
        self._attr_available = self.room_present
        self._attr_native_value = value
        return True
