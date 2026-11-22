export type BulbSetting = "sensing" | "sensitivity" | "probes" | "auto_calibration" | "self_tuning" | "calibrate";

export type BulbValue = number | boolean | string;

export type BulbEffect = {
  code: "overwrites_all_lines" | "clears_calibration" | "disables_auto_calibration" | "more_radio_traffic" | "stops_sensing" | "starts_calibration";
  params: Record<string, Scalar>;
};

export type BulbWritePreviewRequest = {
  ieee: Ieee;
  setting: BulbSetting;
  value: BulbValue;
};

export type BulbWritePreview = {
  confirm_token: string;
  expires: Timestamp;
  previous: BulbValue | null;
  effects: BulbEffect[];
};

export type BulbWriteRequest = {
  ieee: Ieee;
  setting: BulbSetting;
  value: BulbValue;
  confirm_token: string;
};

export type BulbWriteResult = {
  written: boolean;
  t: Timestamp;
};

export type BulbList = {
  bulbs: Bulb[];
};

export type BulbLine = {
  tx: Ieee;
  signal: number | null;
  frozen: boolean;
  weak: boolean;
};

export type Bulb = {
  ieee: Ieee;
  name: string;
  model: string;
  available: boolean;
  sensing: boolean;
  detector: "rule" | "cfar";
  probes: number | null;
  activity_rate: number | null;
  sensitivity: number | null;
  auto_calibration: boolean | null;
  light_entity: string | null;
  area_id: string | null;
  gate_duty_24h: Probability | null;
  lines: BulbLine[];
};

export type Ieee = string;

export type RoomId = string;

export type Timestamp = number;

export type Point = [number, number];

export type Probability = number;

export type Scalar = string | number | boolean | null;

export type Empty = Record<string, never>;

export type WsError = {
  code: ErrorCode;
  message: string;
};

export type ErrorCode = "rev_conflict" | "not_found" | "invalid_format" | "token_expired" | "token_mismatch" | "unauthorized" | "busy" | "unsupported" | "no_session" | "fetch_failed";

export type Frame = {
  t: Timestamp;
  status: Status;
  model_version: number;
  directions: DirectionFrame[];
  pairs: PairFrame[];
  rooms: Record<string, RoomFrame>;
  veto: Veto | null;
  gates: Record<string, Gate>;
  trail: TrailStep[];
  illustrative_xy: Record<string, Point>;
};

export type Status = "learning" | "ready" | "degraded" | "paused";

export type DirectionState = "quiet" | "exceed" | "quiet_censored" | "none";

export type DirectionFlag = "one_sided" | "single_direction" | "frozen" | "weak" | "excluded" | "asymmetric_noisy" | "blanked" | "vetoed";

export type Gate = "open" | "closed" | "offline";

export type Coverage = "good" | "weak" | "none";

export type PairObservation = 0 | 1 | 2;

export type TrailStep = [RoomId, Timestamp];

export type PairKey = [Ieee, Ieee];

export type DirectionFrame = {
  rx: Ieee;
  tx: Ieee;
  level: number | null;
  z: number | null;
  state: DirectionState;
  flags: DirectionFlag[];
};

export type PairFrame = {
  a: Ieee;
  b: Ieee;
  obs: PairObservation | null;
  weight: number;
};

export type RoomFrame = {
  p: Probability;
  motion: boolean;
  occupied: boolean;
  since: Timestamp | null;
  coverage: Coverage;
  top_pairs: PairKey[];
};

export type Veto = {
  kind: "common" | "receiver";
  rx: Ieee | null;
};

export type FrameDelta = {
  t: Timestamp;
  status?: Status;
  model_version?: number;
  directions?: DirectionFrame[];
  pairs?: PairFrame[];
  rooms?: Record<string, RoomFrame>;
  veto?: Veto | null;
  gates?: Record<string, Gate>;
  trail?: TrailStep[];
  illustrative_xy?: Record<string, Point>;
};

export type LiveMessage = {
  kind: "full";
  frame: Frame;
} | {
  kind: "delta";
  delta: FrameDelta;
};

export type LiveSubscribeRequest = {
  rate_hz: number;
};

export type EventKind = "motion_on" | "motion_off" | "false_alarm" | "missed" | "correct" | "label" | "veto" | "bulb_write" | "model_apply" | "model_discard" | "model_rollback" | "model_reset" | "snapshot_delete" | "session_start" | "session_stop" | "house_empty" | "house_occupied";

export type HistoryEvent = {
  t: Timestamp;
  kind: EventKind;
  room: RoomId | null;
  data: Record<string, Scalar>;
};

export type RoomSample = [Timestamp, Probability, boolean];

export type PairSample = [Timestamp, PairObservation | null];

export type PairSeries = {
  a: Ieee;
  b: Ieee;
  samples: PairSample[];
};

export type HistoryRangeRequest = {
  start: Timestamp;
  end: Timestamp;
  step_s: number;
  pairs?: boolean;
};

export type HistoryRangeResponse = {
  rooms: Record<string, RoomSample[]>;
  events: HistoryEvent[];
  pairs: PairSeries[] | null;
};

export type HistoryFramesRequest = {
  start: Timestamp;
  end: Timestamp;
};

export type HistoryFramesResponse = {
  frames: Frame[];
  truncated: boolean;
};

export type FeedbackRequest = {
  room: RoomId;
  kind: "false_alarm" | "missed" | "correct";
  when?: Timestamp | null;
};

export type FeedbackResponse = {
  pending_id: string | null;
};

export type Info = {
  version: string;
  entry_id: string;
  status: Status;
  base_topic: string;
  units: "metric" | "imperial";
  capabilities: {
    has_persons: boolean;
    has_ble: boolean;
    z2m_version: string | null;
  };
};

export type ModelSummary = {
  model_version: number;
  updated: Timestamp | null;
  learning: boolean;
  empty_house_hours: number;
  labels: Record<string, number>;
  pending: PendingModel | null;
};

export type RoomChange = {
  room: RoomId;
  a_on_before: Probability;
  a_on_after: Probability;
  detection_before: Probability | null;
  detection_after: Probability | null;
  false_per_day_before: number | null;
  false_per_day_after: number | null;
};

export type PendingModel = {
  pending_id: string;
  created: Timestamp;
  labels: Record<string, number>;
  rooms: RoomChange[];
};

export type Snapshot = {
  snapshot_id: string;
  t: Timestamp;
  reason: "daily" | "before_session" | "before_apply" | "before_reset" | "before_rollback";
  model_version: number;
  mode?: Mode;
};

export type SnapshotList = {
  snapshots: Snapshot[];
};

export type PendingRequest = {
  pending_id: string;
};

export type ApplyRequest = {
  pending_id: string;
  mode?: Mode;
};

export type RollbackRequest = {
  snapshot_id: string;
};

export type SnapshotDeleteRequest = {
  snapshot_id?: string;
  all?: boolean;
};

export type ResetRequest = {
  room?: RoomId | null;
};

export type ModelChangeResponse = {
  model_version: number;
  snapshot_id: string | null;
};

export type Plan = {
  version: 1;
  rev: number;
  floor_id: string | null;
  north_deg: number;
  view_rotation_deg: number;
  background: Background | null;
  rooms: Room[];
  walls: Wall[];
  doors: Door[];
  adjacent: [RoomId, RoomId][];
  bulbs: PlanBulb[];
  excluded_directions: ExcludedDirection[];
  retired_rooms: RoomId[];
};

export type WallKind = "partition" | "brick" | "concrete" | "glass" | "none";

export type DoorKind = "door" | "opening";

export type BulbHeight = "ceiling" | "pendant" | "lamp";

export type Background = {
  file: string;
  x: number;
  y: number;
  m_per_px: number;
  opacity: Probability;
};

export type Room = {
  id: RoomId;
  name: string;
  outline: Point[];
  colour: string;
  area_id: string | null;
  entrance: boolean;
};

export type Wall = {
  a: Point;
  b: Point;
  kind: WallKind;
};

export type Door = {
  wall: number;
  at: Probability;
  width: number;
  kind: DoorKind;
};

export type PlanBulb = {
  ieee: Ieee;
  x: number;
  y: number;
  height: BulbHeight;
  room: RoomId | null;
};

export type ExcludedDirection = {
  rx: Ieee;
  tx: Ieee;
  reason: string;
};

export type PlanGetResponse = {
  rev: number;
  plan: Plan;
  reserved_rooms: RoomId[];
};

export type PlanSaveRequest = {
  rev: number;
  plan: Plan;
  background_image?: BackgroundUpload | null;
};

export type PlanSaveResponse = {
  rev: number;
  warnings: PlanWarning[];
  background: Background | null;
  retired_rooms: RoomId[];
};

export type BackgroundUpload = {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
  data_base64: string;
  deflated?: boolean;
};

export type PlanImportFormat = "auto" | "mieszkanie_yaml" | "outglow_json" | "valetudo_json";

export type PlanImportSource = "outglow_plan" | "prototype_layout" | "prototype_yaml" | "valetudo_map";

export type PlanImportRequest = {
  format: PlanImportFormat;
  text?: string;
  deflated_base64?: string;
  current?: Plan | null;
};

export type PlanWarning = {
  code: "unknown_bulb" | "bulb_outside_rooms" | "room_without_bulb" | "overlapping_rooms" | "dropped_field" | "unknown_room" | "dropped_segment" | "no_segments" | "no_doors" | "bulbs_not_aligned" | "room_simplified" | "background_dropped" | "bulb_pinned_elsewhere";
  params: Record<string, Scalar>;
};

export type KeptBulbs = {
  bulbs: number;
  rooms: number;
  aligned: boolean;
  rotation_deg: number;
  mirrored: boolean;
  rms_m: number | null;
};

export type PlanImportResponse = {
  plan: Plan;
  warnings: PlanWarning[];
  source: PlanImportSource;
  background_image: BackgroundImage | null;
  kept: KeptBulbs | null;
};

export type ValetudoRobot = {
  id: string;
  name: string;
  url: string | null;
};

export type ValetudoRobotsResponse = {
  url: string | null;
  robots: ValetudoRobot[];
};

export type ValetudoFetchRequest = {
  url?: string | null;
  robot?: string | null;
  current?: Plan | null;
};

export type BackgroundImage = {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";
  data_base64: string;
};

export type BackgroundGetResponse = {
  image: BackgroundImage | null;
  file: string | null;
};

export type BackgroundSetResponse = {
  file: string;
};

export type QualityReport = {
  t: Timestamp;
  days: number;
  empty_house_hours: number;
  network_frames_per_s: number;
  rooms: RoomQuality[];
  directions: DirectionQuality[];
  pairs: PairQuality[];
  recommendations: Recommendation[];
};

export type RoomQuality = {
  room: RoomId;
  false_alarms_per_day: number | null;
  entry_detection: Probability | null;
  latency_median_s: number | null;
  latency_p90_s: number | null;
  coverage: number;
  coverage_class: Coverage;
  vetoes: number;
};

export type DirectionQuality = {
  rx: Ieee;
  tx: Ieee;
  exceed_per_h: number;
  exceed_per_day: number;
  asymmetry: number | null;
  frozen_frac: Probability;
  signal_dbm: number | null;
  gate_open_frac: Probability;
  theta: Record<string, Probability>;
  flags: DirectionFlag[];
};

export type PairQuality = {
  a: Ieee;
  b: Ieee;
  information: Record<string, number>;
};

export type RecommendationKind = "skip_direction" | "raise_sensitivity" | "weak_coverage" | "more_empty_house" | "frozen_direction" | "no_bulbs" | "one_bulb";

export type RecommendationAction = "skip_direction" | "bulb_write" | "wizard" | "show_candidates" | "none";

export type Recommendation = {
  id: string;
  kind: RecommendationKind;
  severity: "info" | "warning";
  action: RecommendationAction;
  room: RoomId | null;
  rx: Ieee | null;
  tx: Ieee | null;
  bulb: Ieee | null;
  numbers: Record<string, number>;
  candidates: Point[];
};

export type QualityRequest = {
  days: number;
};

export type RecordingLine = HeaderRecord | BulbRecord | LightRecord | ContextRecord | LabelRecord | FrameRecord;

export type HeaderRecord = {
  type: "header";
  format: 2;
  plan: Plan | null;
  settings: Settings | null;
  created: Timestamp | null;
  generator: string | null;
};

export type RecordingLink = {
  ieee_address: Ieee;
  activity: number | null;
  motion: boolean;
  signal: number | null;
  noise: number | null;
  sensitivity?: number | null;
  calibrated_sensitivity?: number | null;
};

export type LightStateRecord = {
  on: boolean;
  brightness: number | null;
  color_temp: number | null;
};

export type BulbRecord = {
  t: Timestamp;
  type: "bulb";
  name: string;
  ieee: Ieee;
  source: "activity" | "lines" | "unknown";
  links: RecordingLink[];
  occupancy: boolean | null;
  room_occupancy?: boolean | null;
  light: LightStateRecord | null;
};

export type LightRecord = {
  t: Timestamp;
  type: "light";
  ieee: Ieee;
  origin: "ours" | "user" | "remote" | "unknown";
  on: boolean | null;
};

export type ContextRecord = {
  t: Timestamp;
  type: "context";
  persons_home: string[];
  house_empty: "yes" | "soft" | "no" | "unknown";
  offline: Ieee[];
  cfar?: Ieee[];
};

export type Label = {
  t0: Timestamp;
  t1: Timestamp;
  kind: "room" | "empty" | "transition";
  room: RoomId | null;
  activity: "walk" | "still" | "any";
  source: "wizard" | "recording" | "service" | "feedback" | "empty_house" | "manual_light";
  weight: number;
};

export type LabelRecord = {
  t: Timestamp;
  type: "label";
  label: Label;
};

export type FrameRecord = {
  t: Timestamp;
  type: "frame";
  frame: Frame;
};

export type Session = {
  session_id: string;
  name: string;
  started: Timestamp;
  state: "running" | "stopped";
  raised_rate: boolean;
  steps: SessionStep[];
  live_feedback: LiveFeedback;
  summary: SessionSummary | null;
};

export type SessionStep = {
  index: number;
  kind: "room" | "empty" | "transition";
  room: RoomId | null;
  activity: "walk" | "still" | "any";
  t0: Timestamp;
  t1: Timestamp | null;
};

export type LiveFeedback = {
  pairs_reacting: number;
  veto: boolean;
};

export type SessionSummary = {
  rooms: RoomId[];
  matrix_before: number[][];
  matrix_after: number[][];
  accuracy_before: Probability | null;
  accuracy_after: Probability | null;
  weak_rooms: RoomId[];
  pending_id: string | null;
  mode?: Mode;
  bayes?: SessionScore | null;
  suggest_mode?: Mode | null;
  rooms_without_bulbs?: RoomId[];
  empty_house_hours?: number;
  empty_setup?: "none" | "persons" | "learning" | "both";
  empty_needed_h?: number;
};

export type SessionScore = {
  matrix_before: number[][];
  matrix_after: number[][];
  accuracy_before: Probability | null;
  accuracy_after: Probability | null;
};

export type SessionStartRequest = {
  name: string;
  raise_rate?: boolean;
};

export type SessionLabelRequest = {
  kind: "room" | "empty" | "transition";
  room?: RoomId;
  activity: "walk" | "still" | "any";
  ts?: number;
};

export type SessionGetResponse = {
  session: Session | null;
};

export type Settings = {
  rooms: Record<string, RoomSettings>;
  global: GlobalSettings;
};

export type Reaction = "fast" | "normal" | "calm";

export type Mode = "rules" | "bayes";

export type RoomSettings = {
  false_alarm_budget: 0.1 | 0.3 | 1 | 3 | 10;
  reaction: Reaction;
  hold_time_s: number;
  auto_light: boolean;
  light_off_delay_s: number;
};

export type Retention = {
  raw_h: number;
  empty_raw_d: number;
  ticks_d: number;
  events_d: number;
};

export type GlobalSettings = {
  sensing: boolean;
  learning: boolean;
  mode: Mode;
  tick_s: 0.25 | 0.5 | 1;
  use_persons: boolean;
  persons: string[];
  others_may_be_home: boolean;
  quiet_background: boolean;
  firmware_channel: boolean;
  retention: Retention;
};

export interface OutglowCommands {
  "outglow/info": {
    request: Empty;
    response: Info;
    event: null;
    admin: true;
  };
  "outglow/bulbs": {
    request: Empty;
    response: BulbList;
    event: null;
    admin: true;
  };
  "outglow/plan/get": {
    request: Empty;
    response: PlanGetResponse;
    event: null;
    admin: true;
  };
  "outglow/plan/save": {
    request: PlanSaveRequest;
    response: PlanSaveResponse;
    event: null;
    admin: true;
  };
  "outglow/plan/import": {
    request: PlanImportRequest;
    response: PlanImportResponse;
    event: null;
    admin: true;
  };
  "outglow/plan/valetudo/robots": {
    request: Empty;
    response: ValetudoRobotsResponse;
    event: null;
    admin: true;
  };
  "outglow/plan/valetudo/fetch": {
    request: ValetudoFetchRequest;
    response: PlanImportResponse;
    event: null;
    admin: true;
  };
  "outglow/plan/background/get": {
    request: Empty;
    response: BackgroundGetResponse;
    event: null;
    admin: true;
  };
  "outglow/plan/background/set": {
    request: BackgroundImage;
    response: BackgroundSetResponse;
    event: null;
    admin: true;
  };
  "outglow/live/subscribe": {
    request: LiveSubscribeRequest;
    response: null;
    event: LiveMessage;
    admin: true;
  };
  "outglow/history/range": {
    request: HistoryRangeRequest;
    response: HistoryRangeResponse;
    event: null;
    admin: true;
  };
  "outglow/history/frames": {
    request: HistoryFramesRequest;
    response: HistoryFramesResponse;
    event: null;
    admin: true;
  };
  "outglow/feedback": {
    request: FeedbackRequest;
    response: FeedbackResponse;
    event: null;
    admin: true;
  };
  "outglow/session/start": {
    request: SessionStartRequest;
    response: Session;
    event: null;
    admin: true;
  };
  "outglow/session/label": {
    request: SessionLabelRequest;
    response: Session;
    event: null;
    admin: true;
  };
  "outglow/session/stop": {
    request: Empty;
    response: Session;
    event: null;
    admin: true;
  };
  "outglow/session/get": {
    request: Empty;
    response: SessionGetResponse;
    event: null;
    admin: true;
  };
  "outglow/quality": {
    request: QualityRequest;
    response: QualityReport;
    event: null;
    admin: true;
  };
  "outglow/settings/get": {
    request: Empty;
    response: Settings;
    event: null;
    admin: true;
  };
  "outglow/settings/set": {
    request: Settings;
    response: Settings;
    event: null;
    admin: true;
  };
  "outglow/model/get": {
    request: Empty;
    response: ModelSummary;
    event: null;
    admin: true;
  };
  "outglow/model/snapshots": {
    request: Empty;
    response: SnapshotList;
    event: null;
    admin: true;
  };
  "outglow/model/apply": {
    request: ApplyRequest;
    response: ModelChangeResponse;
    event: null;
    admin: true;
  };
  "outglow/model/discard": {
    request: PendingRequest;
    response: ModelChangeResponse;
    event: null;
    admin: true;
  };
  "outglow/model/rollback": {
    request: RollbackRequest;
    response: ModelChangeResponse;
    event: null;
    admin: true;
  };
  "outglow/model/snapshot/delete": {
    request: SnapshotDeleteRequest;
    response: SnapshotList;
    event: null;
    admin: true;
  };
  "outglow/model/reset": {
    request: ResetRequest;
    response: ModelChangeResponse;
    event: null;
    admin: true;
  };
  "outglow/bulb/write_preview": {
    request: BulbWritePreviewRequest;
    response: BulbWritePreview;
    event: null;
    admin: true;
  };
  "outglow/bulb/write": {
    request: BulbWriteRequest;
    response: BulbWriteResult;
    event: null;
    admin: true;
  };
}

export type OutglowCommand = keyof OutglowCommands;

export const SUBSCRIPTIONS = ["outglow/live/subscribe"] as const;
