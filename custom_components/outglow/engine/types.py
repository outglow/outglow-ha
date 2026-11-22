from dataclasses import dataclass, field
from typing import Literal

Point = tuple[float, float]
Json = None | bool | int | float | str | list["Json"] | dict[str, "Json"]

WallKind = Literal["partition", "brick", "concrete", "glass", "none"]
DoorKind = Literal["door", "opening"]
BulbHeight = Literal["ceiling", "pendant", "lamp"]
Reaction = Literal["fast", "normal", "calm"]
Mode = Literal["rules", "bayes"]
Source = Literal["activity", "lines", "unknown"]
HouseEmpty = Literal["yes", "soft", "no", "unknown"]
LightOrigin = Literal["ours", "user", "remote", "unknown"]
LabelKind = Literal["room", "empty", "transition"]
LabelActivity = Literal["walk", "still", "any"]
LabelSource = Literal["wizard", "recording", "service", "feedback", "empty_house", "manual_light"]
DirectionState = Literal["quiet", "exceed", "quiet_censored", "none"]
DirectionFlag = Literal[
    "one_sided", "single_direction", "frozen", "weak", "excluded", "asymmetric_noisy", "blanked", "vetoed"
]
PairObservation = Literal[0, 1, 2]
Gate = Literal["open", "closed", "offline"]
VetoKind = Literal["common", "receiver"]
Coverage = Literal["good", "weak", "none"]
Status = Literal["learning", "ready", "degraded", "paused"]
CalibrationStatus = Literal["ok", "uncertain", "unchanged"]
EventKind = Literal[
    "motion_on",
    "motion_off",
    "false_alarm",
    "missed",
    "correct",
    "label",
    "veto",
    "bulb_write",
    "model_apply",
    "model_discard",
    "model_rollback",
    "model_reset",
    "snapshot_delete",
    "session_start",
    "session_stop",
    "house_empty",
    "house_occupied",
]
RecommendationKind = Literal[
    "skip_direction",
    "raise_sensitivity",
    "weak_coverage",
    "more_empty_house",
    "frozen_direction",
    "no_bulbs",
    "one_bulb",
]
RecommendationAction = Literal["skip_direction", "bulb_write", "wizard", "show_candidates", "none"]
Severity = Literal["info", "warning"]
Scalar = None | bool | int | float | str


@dataclass(frozen=True, slots=True)
class Background:
    file: str
    x: float = 0.0
    y: float = 0.0
    m_per_px: float = 0.01
    opacity: float = 0.35


@dataclass(frozen=True, slots=True)
class Room:
    id: str
    name: str
    outline: tuple[Point, ...]
    colour: str = "#4e9af1"
    area_id: str | None = None
    entrance: bool = False


@dataclass(frozen=True, slots=True)
class Wall:
    a: Point
    b: Point
    kind: WallKind = "partition"


@dataclass(frozen=True, slots=True)
class Door:
    wall: int
    at: float = 0.5
    width: float = 0.9
    kind: DoorKind = "door"


@dataclass(frozen=True, slots=True)
class PlanBulb:
    ieee: str
    x: float
    y: float
    height: BulbHeight = "ceiling"
    room: str | None = None


@dataclass(frozen=True, slots=True)
class ExcludedDirection:
    rx: str
    tx: str
    reason: str = ""


@dataclass(frozen=True, slots=True)
class Plan:
    version: int = 1
    rev: int = 0
    floor_id: str | None = None
    north_deg: float = 0.0
    view_rotation_deg: float = 0.0
    background: Background | None = None
    rooms: tuple[Room, ...] = ()
    walls: tuple[Wall, ...] = ()
    doors: tuple[Door, ...] = ()
    adjacent: tuple[tuple[str, str], ...] = ()
    bulbs: tuple[PlanBulb, ...] = ()
    excluded_directions: tuple[ExcludedDirection, ...] = ()
    retired_rooms: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class RoomSettings:
    false_alarm_budget: float = 1.0
    reaction: Reaction = "normal"
    hold_time_s: int = 60
    auto_light: bool = False
    light_off_delay_s: int = 300


@dataclass(frozen=True, slots=True)
class Retention:
    raw_h: int = 48
    empty_raw_d: int = 7
    ticks_d: int = 14
    events_d: int = 365


@dataclass(frozen=True, slots=True)
class GlobalSettings:
    sensing: bool = True
    learning: bool = True
    mode: Mode = "rules"
    tick_s: float = 0.5
    use_persons: bool = False
    persons: tuple[str, ...] = ()
    others_may_be_home: bool = False
    quiet_background: bool = False
    firmware_channel: bool = False
    retention: Retention = field(default_factory=Retention)


@dataclass(frozen=True, slots=True)
class Settings:
    rooms: dict[str, RoomSettings] = field(default_factory=dict)
    global_: GlobalSettings = field(default_factory=GlobalSettings, metadata={"json": "global"})


@dataclass(frozen=True, slots=True)
class LinkReading:
    tx: str
    level: int | None = None
    window_sum: int | None = None
    motion: bool = False
    signal_dbm: int | None = None
    noise_db: float | None = None
    sensitivity: int | None = None
    calibrated_sensitivity: int | None = None
    raw_activity: int | None = None


@dataclass(frozen=True, slots=True)
class LightState:
    on: bool
    brightness: int | None = None
    color_temp: int | None = None


@dataclass(frozen=True, slots=True)
class Observation:
    t: float
    rx: str
    links: tuple[LinkReading, ...] = ()
    occupancy: bool | None = None
    light: LightState | None = None
    source: Source = "unknown"


@dataclass(frozen=True, slots=True)
class LightEvent:
    t: float
    ieee: str
    origin: LightOrigin = "unknown"
    on: bool | None = None


@dataclass(frozen=True, slots=True)
class Context:
    t: float
    persons_home: frozenset[str] = frozenset()
    house_empty: HouseEmpty = "unknown"
    light_events: tuple[LightEvent, ...] = ()
    offline: frozenset[str] = frozenset()
    cfar: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class Label:
    t0: float
    t1: float
    kind: LabelKind
    room: str | None = None
    activity: LabelActivity = "any"
    source: LabelSource = "wizard"
    weight: float = 1.0


@dataclass(frozen=True, slots=True)
class DirectionFrame:
    rx: str
    tx: str
    level: int | None = None
    z: float | None = None
    state: DirectionState = "none"
    flags: tuple[DirectionFlag, ...] = ()


@dataclass(frozen=True, slots=True)
class PairFrame:
    a: str
    b: str
    obs: PairObservation | None = None
    weight: float = 0.0


@dataclass(frozen=True, slots=True)
class RoomFrame:
    p: float = 0.0
    motion: bool = False
    occupied: bool = False
    since: float | None = None
    coverage: Coverage = "none"
    top_pairs: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True, slots=True)
class Veto:
    kind: VetoKind
    rx: str | None = None


@dataclass(frozen=True, slots=True)
class Frame:
    t: float
    status: Status = "learning"
    model_version: int = 0
    directions: tuple[DirectionFrame, ...] = ()
    pairs: tuple[PairFrame, ...] = ()
    rooms: dict[str, RoomFrame] = field(default_factory=dict)
    veto: Veto | None = None
    gates: dict[str, Gate] = field(default_factory=dict)
    trail: tuple[tuple[str, float], ...] = ()
    illustrative_xy: dict[str, Point] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class HistoryEvent:
    t: float
    kind: EventKind
    room: str | None = None
    data: dict[str, Scalar] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class QualityInputs:
    t0: float
    t1: float
    labels: tuple[Label, ...] = ()
    events: tuple[HistoryEvent, ...] = ()
    empty_intervals: tuple[tuple[float, float], ...] = ()


@dataclass(frozen=True, slots=True)
class RoomCalibration:
    a_on: float
    previous_a_on: float
    false_per_day: float | None = None
    detection: float | None = None
    empty_hours: float = 0.0
    status: CalibrationStatus = "uncertain"


@dataclass(frozen=True, slots=True)
class CalibrationResult:
    t: float
    rooms: dict[str, RoomCalibration] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DirectionQuality:
    rx: str
    tx: str
    exceed_per_h: float = 0.0
    exceed_per_day: float = 0.0
    asymmetry: float | None = None
    frozen_frac: float = 0.0
    signal_dbm: int | None = None
    gate_open_frac: float = 0.0
    theta: dict[str, float] = field(default_factory=dict)
    flags: tuple[DirectionFlag, ...] = ()


@dataclass(frozen=True, slots=True)
class PairQuality:
    a: str
    b: str
    information: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RoomQuality:
    room: str
    false_alarms_per_day: float | None = None
    entry_detection: float | None = None
    latency_median_s: float | None = None
    latency_p90_s: float | None = None
    coverage: float = 0.0
    coverage_class: Coverage = "none"
    vetoes: int = 0


@dataclass(frozen=True, slots=True)
class Recommendation:
    id: str
    kind: RecommendationKind
    severity: Severity = "info"
    action: RecommendationAction = "none"
    room: str | None = None
    rx: str | None = None
    tx: str | None = None
    bulb: str | None = None
    numbers: dict[str, float] = field(default_factory=dict)
    candidates: tuple[Point, ...] = ()


@dataclass(frozen=True, slots=True)
class QualityReport:
    t: float
    days: int
    empty_house_hours: float = 0.0
    network_frames_per_s: float = 0.0
    rooms: tuple[RoomQuality, ...] = ()
    directions: tuple[DirectionQuality, ...] = ()
    pairs: tuple[PairQuality, ...] = ()
    recommendations: tuple[Recommendation, ...] = ()


@dataclass(frozen=True, slots=True)
class Header:
    format: int = 2
    plan: Plan | None = None
    settings: Settings | None = None
    created: float | None = None
    generator: str | None = None


Record = Header | Observation | LightEvent | Context | Label | Frame
