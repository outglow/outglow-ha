import hashlib
import logging
import sqlite3
from pathlib import Path

from homeassistant.components import frontend, mqtt, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import leftover, repairs
from .const import (
    CARDS_FILE,
    CONF_BASE_TOPIC,
    CONF_LOG_LEVEL,
    DATA_DIR,
    DEFAULT_LOG_LEVEL,
    DOMAIN,
    FRONTEND_DIR,
    HISTORY_FILE,
    PANEL_ELEMENT,
    PANEL_FILE,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
    STATIC_URL,
    VERSION,
)
from .coordinator import OutglowCoordinator
from .services import async_register_services
from .session import stored_rate
from .store import OutglowStore
from .websocket import async_register_commands

type OutglowConfigEntry = ConfigEntry[OutglowCoordinator]

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
DATA_STATIC = f"{DOMAIN}_static_registered"
DATA_PANEL_TAG = f"{DOMAIN}_panel_tag"
DATA_KEPT = f"{DOMAIN}_kept_sessions"
PLATFORMS = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.NUMBER,
    Platform.SELECT,
    Platform.SENSOR,
    Platform.SWITCH,
]
LEVELS = {"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING}


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    async_register_commands(hass)
    async_register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: OutglowConfigEntry) -> bool:
    logging.getLogger(__package__).setLevel(LEVELS.get(entry.options.get(CONF_LOG_LEVEL, DEFAULT_LOG_LEVEL), 30))
    if not await mqtt.async_wait_for_mqtt_client(hass):
        raise ConfigEntryNotReady("MQTT is not available yet")
    coordinator = OutglowCoordinator(hass, entry)
    forwarded = False
    try:
        await _async_register_frontend(hass)
        coordinator.panel_registered = await _async_register_panel(hass)
        coordinator.panel_conflict = not coordinator.panel_registered
        await coordinator.async_setup(entry.entry_id in hass.data.get(DATA_KEPT, set()))
        entry.runtime_data = coordinator
        forwarded = True
        await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    except (HomeAssistantError, OSError, sqlite3.Error) as err:
        await _async_abort_setup(hass, entry, coordinator, forwarded)
        if isinstance(err, ConfigEntryNotReady):
            raise
        raise ConfigEntryNotReady(str(err) or type(err).__name__) from err
    except BaseException:
        await _async_abort_setup(hass, entry, coordinator, forwarded)
        raise
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    coordinator.tick()
    return True


async def _async_abort_setup(
    hass: HomeAssistant, entry: OutglowConfigEntry, coordinator: OutglowCoordinator, forwarded: bool
) -> None:
    if coordinator.panel_registered:
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
        coordinator.panel_registered = False
    if forwarded:
        try:
            await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
        except ValueError:
            _LOGGER.debug("Some Outglow platforms were not set up before the failure")
    await coordinator.async_unload()


async def async_unload_entry(hass: HomeAssistant, entry: OutglowConfigEntry) -> bool:
    coordinator = entry.runtime_data
    if coordinator.panel_registered:
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
        coordinator.panel_registered = False
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    await coordinator.async_unload(entry.entry_id in hass.data.get(DATA_KEPT, set()))
    repairs.clear(hass)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: OutglowConfigEntry) -> None:
    store = OutglowStore(hass)
    restore = (await store.async_load_runtime()).get("rate_restore")
    rates = {str(ieee): stored_rate(rate) for ieee, rate in (restore.items() if isinstance(restore, dict) else ())}
    if rates and not await leftover.async_keep(hass, entry.data[CONF_BASE_TOPIC], rates):
        _LOGGER.warning("Outglow was removed before every activity rate was restored; it keeps trying")
    await store.async_remove()
    await hass.async_add_executor_job(_remove_history, Path(hass.config.path(DATA_DIR)))


async def _async_options_updated(hass: HomeAssistant, entry: OutglowConfigEntry) -> None:
    kept: set[str] = hass.data.setdefault(DATA_KEPT, set())
    kept.add(entry.entry_id)
    try:
        await hass.config_entries.async_reload(entry.entry_id)
    finally:
        kept.discard(entry.entry_id)


def _build_tag(path: Path) -> str | None:
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


async def _async_register_frontend(hass: HomeAssistant) -> None:
    if hass.data.get(DATA_STATIC):
        return
    panel = await hass.async_add_executor_job(_build_tag, FRONTEND_DIR / PANEL_FILE)
    if panel is None:
        _LOGGER.warning("Outglow frontend is not built: run npm --prefix frontend run build")
        return
    await hass.http.async_register_static_paths([StaticPathConfig(STATIC_URL, str(FRONTEND_DIR), cache_headers=False)])
    cards = await hass.async_add_executor_job(_build_tag, FRONTEND_DIR / CARDS_FILE)
    if cards is not None:
        frontend.add_extra_js_url(hass, f"{STATIC_URL}/{CARDS_FILE}?v={cards}")
    hass.data[DATA_STATIC] = True
    hass.data[DATA_PANEL_TAG] = panel


def _panel_is_ours(panel: frontend.Panel) -> bool:
    custom = (panel.config or {}).get("_panel_custom")
    return panel.component_name == "custom" and isinstance(custom, dict) and custom.get("name") == PANEL_ELEMENT


async def _async_register_panel(hass: HomeAssistant) -> bool:
    existing = hass.data.get(frontend.DATA_PANELS, {}).get(PANEL_URL_PATH)
    if existing is not None and not _panel_is_ours(existing):
        _LOGGER.warning(
            "The sidebar path /%s is taken by another panel; Outglow runs without its panel", PANEL_URL_PATH
        )
        return False
    if existing is not None:
        frontend.async_remove_panel(hass, PANEL_URL_PATH, warn_if_unknown=False)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/{PANEL_FILE}?v={hass.data.get(DATA_PANEL_TAG, VERSION)}",
        require_admin=True,
        config={},
    )
    return True


def _remove_history(folder: Path) -> None:
    for suffix in ("", "-wal", "-shm"):
        (folder / f"{HISTORY_FILE}{suffix}").unlink(missing_ok=True)
