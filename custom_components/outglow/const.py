from pathlib import Path
from typing import Final

DOMAIN: Final = "outglow"
VERSION: Final = "0.1.0"

CONF_BASE_TOPIC: Final = "base_topic"
CONF_LOG_LEVEL: Final = "log_level"
DEFAULT_BASE_TOPIC: Final = "zigbee2mqtt"
LOG_LEVELS: Final = ("debug", "info", "warning")
DEFAULT_LOG_LEVEL: Final = "warning"

PANEL_URL_PATH: Final = "outglow"
PANEL_ELEMENT: Final = "outglow-panel"
PANEL_TITLE: Final = "Outglow"
PANEL_ICON: Final = "mdi:motion-sensor"

STATIC_URL: Final = "/outglow_static"
FRONTEND_DIR: Final = Path(__file__).parent / "frontend"
PANEL_FILE: Final = "outglow-panel.js"
CARDS_FILE: Final = "outglow-cards.js"

DATA_DIR: Final = "outglow"
HISTORY_FILE: Final = "history.db"
EXPORTS_DIR: Final = "exports"

OUTGLOW_MODELS: Final = ("outglow-", "open-eglo-")
WEAK_SIGNAL_DBM: Final = -88
DERIVE_TRIES: Final = 3

BRIDGE_WAIT_S: Final = 5.0
STATE_WAIT_S: Final = 3.0
SESSION_RATE: Final = 4
SESSION_RATE_MAX_S: Final = 1800.0
RATE_DEFAULT: Final = 0
RATE_RETRY_S: Final = 30.0
RATE_RETRY_MAX_S: Final = 1800.0
ISSUE_RATES_LEFT: Final = "rates_not_restored"
ISSUE_RATES_WAITING: Final = "rates_waiting"
ISSUE_SESSION_RATES: Final = "session_rates_waiting"
SESSION_RATES_REPAIR_S: Final = 600.0
STEP_MAX_S: Final = {"empty": 1800.0, "room": 600.0, "transition": 300.0}
SESSION_IDLE_S: Final = 1800.0
SUMMARY_LEAD_S: Final = 60.0
TOKEN_TTL_S: Final = 60.0
LIVE_MAX_HZ: Final = 4.0
FRAMES_MAX_S: Final = 300.0
HISTORY_FLUSH_S: Final = 2.0
TICK_STORE_P: Final = 0.05
CALIBRATION_HOUR: Final = 3
CALIBRATION_MINUTE: Final = 30
CALIBRATION_DAYS: Final = 7
SNAPSHOTS_KEPT: Final = 7
SNAPSHOTS_OTHER_KEPT: Final = 10
ACTIVITY_MISSING_S: Final = 86400.0
CONVERTER_GRACE_S: Final = 600.0
FALSE_ALARM_WINDOW_S: Final = 86400.0
TRAIL_LEN: Final = 10
VOLATILE_ATTRIBUTES_S: Final = 60.0
STATUS_VOLATILE_S: Final = 300.0
MOTION_OFF_DELAY_S: Final = 10.0
MOTION_ROOM_DWELL_S: Final = 10.0

LABEL_WEIGHTS: Final = {
    "walk": 1.0,
    "still": 0.5,
    "any": 1.0,
    "service": 0.8,
    "feedback": 0.7,
    "manual_light": 0.3,
}
MANUAL_LIGHT_BEFORE_S: Final = 20.0
MANUAL_LIGHT_AFTER_S: Final = 5.0
BRIDGE_SETTLE_S: Final = 60.0
FEEDBACK_ON_BEFORE_S: Final = 10.0
FEEDBACK_ON_AFTER_S: Final = 5.0
FEEDBACK_LOOKBACK_S: Final = 600.0
FEEDBACK_DEFAULT_S: Final = 30.0

SIGNAL_PLAN: Final = "outglow_plan_changed"
ROOM_KEYS: Final = ("occupancy", "false_alarms_24h", "false_alarm_budget", "reaction", "hold_time")
