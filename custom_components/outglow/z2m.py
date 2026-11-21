import json
import re
import secrets
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant

from .const import OUTGLOW_MODELS, TOKEN_TTL_S
from .errors import OutglowError

IEEE = re.compile(r"^0x[0-9a-f]{16}$")
Setting = Literal["sensing", "sensitivity", "probes", "auto_calibration", "self_tuning", "calibrate"]
BulbValue = int | bool | str
SETTINGS: tuple[Setting, ...] = ("sensing", "sensitivity", "probes", "auto_calibration", "self_tuning", "calibrate")
Z2M_KEYS: dict[Setting, str] = {
    "sensing": "motion_sensing",
    "sensitivity": "motion_sensitivity",
    "probes": "motion_probes",
    "auto_calibration": "motion_auto_calibration",
    "self_tuning": "motion_self_tuning",
    "calibrate": "motion_calibrate",
}
RANGES: dict[Setting, tuple[int, int]] = {"sensitivity": (0, 100), "probes": (0, 10)}
CALIBRATION_S = 60
DEFAULT_PROBES = 5


@dataclass(slots=True)
class Device:
    ieee: str
    name: str
    model: str
    outglow: bool
    sensing_capable: bool
    available: bool = True
    state: dict[str, Any] = field(default_factory=dict)


def _has_property(node: object, name: str) -> bool:
    if isinstance(node, Mapping):
        if node.get("property") == name or node.get("name") == name:
            return True
        return any(_has_property(value, name) for value in node.values())
    if isinstance(node, list):
        return any(_has_property(item, name) for item in node)
    return False


def _mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def is_outglow_model(model: str) -> bool:
    return model.lower().startswith(OUTGLOW_MODELS)


class Z2MDevices:
    def __init__(self) -> None:
        self._by_ieee: dict[str, Device] = {}
        self._by_name: dict[str, str] = {}
        self.version: str | None = None
        self.output: str | None = None
        self.options: dict[str, dict[str, Any]] = {}
        self.bridge_online: bool | None = None
        self.devices_seen: float | None = None
        self.info_seen = False

    def update_devices(self, data: object, t: float) -> None:
        if not isinstance(data, list):
            return
        known = self._by_ieee
        fresh: dict[str, Device] = {}
        for item in data:
            device = self._device(item, known)
            if device is not None:
                fresh[device.ieee] = device
        self._by_ieee = fresh
        self._by_name = {device.name: device.ieee for device in fresh.values()}
        self.devices_seen = t

    def _device(self, item: object, known: Mapping[str, Device]) -> Device | None:
        if not isinstance(item, Mapping):
            return None
        ieee = str(item.get("ieee_address", "")).lower()
        name = item.get("friendly_name")
        if not IEEE.match(ieee) or not isinstance(name, str) or item.get("type") == "Coordinator":
            return None
        definition = _mapping(item.get("definition"))
        model = str(definition.get("model") or item.get("model_id") or "")
        old = known.get(ieee)
        return Device(
            ieee=ieee,
            name=name,
            model=model,
            outglow=is_outglow_model(model) or is_outglow_model(str(item.get("model_id") or "")),
            sensing_capable=_has_property(definition.get("exposes"), "motion_links"),
            available=old.available if old else True,
            state=old.state if old else {},
        )

    def update_info(self, data: object) -> None:
        if not isinstance(data, Mapping):
            return
        self.info_seen = True
        version = data.get("version")
        self.version = version if isinstance(version, str) else None
        config = _mapping(data.get("config"))
        advanced = _mapping(config.get("advanced"))
        output = advanced.get("output")
        self.output = output if isinstance(output, str) else None
        devices = _mapping(config.get("devices"))
        self.options = {str(key).lower(): dict(value) for key, value in devices.items() if isinstance(value, Mapping)}

    def by_name(self, name: str) -> Device | None:
        ieee = self._by_name.get(name)
        return self._by_ieee.get(ieee) if ieee else None

    def get(self, ieee: str) -> Device | None:
        return self._by_ieee.get(ieee)

    def bulbs(self) -> list[Device]:
        return sorted((d for d in self._by_ieee.values() if d.outglow), key=lambda d: d.ieee)

    def names(self) -> dict[str, str]:
        return {device.ieee: device.name for device in self._by_ieee.values()}

    def update_state(self, ieee: str, data: Mapping[str, Any]) -> None:
        device = self._by_ieee.get(ieee)
        if device is not None:
            device.state.update(data)

    def set_available(self, ieee: str, online: bool) -> None:
        device = self._by_ieee.get(ieee)
        if device is not None:
            device.available = online

    def offline(self) -> frozenset[str]:
        return frozenset(d.ieee for d in self._by_ieee.values() if d.outglow and not d.available)

    def activity_rate(self, ieee: str) -> float | None:
        value = self.options.get(ieee, {}).get("motion_activity_rate")
        if isinstance(value, bool) or not isinstance(value, int | float | str):
            return None
        try:
            return float(value)
        except ValueError:
            return None

    def sensing(self, device: Device) -> bool:
        value = device.state.get("motion_sensing")
        return value is True or (isinstance(value, str) and value.upper() == "ON")

    def current(self, device: Device, setting: Setting) -> BulbValue | None:
        state = device.state
        match setting:
            case "sensing":
                return self.sensing(device) if "motion_sensing" in state else None
            case "sensitivity" | "probes":
                value = state.get(Z2M_KEYS[setting])
                return value if isinstance(value, int) and not isinstance(value, bool) else None
            case "auto_calibration" | "self_tuning":
                value = state.get(Z2M_KEYS[setting])
                return value if isinstance(value, bool) else None
            case "calibrate":
                left = state.get("motion_calibration_left")
                if isinstance(left, int | float) and not isinstance(left, bool):
                    return "start" if left > 0 else "stop"
                return None

    def line_count(self, device: Device) -> int:
        links = device.state.get("motion_links")
        return len(links) if isinstance(links, list) else 0


def check_value(setting: str, value: object) -> tuple[Setting, BulbValue]:
    if setting not in SETTINGS:
        raise OutglowError("invalid_format", f"Unknown setting {setting}")
    typed = next(s for s in SETTINGS if s == setting)
    match typed:
        case "sensing" | "auto_calibration" | "self_tuning":
            if isinstance(value, bool):
                return typed, value
        case "sensitivity" | "probes":
            low, high = RANGES[typed]
            if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high:
                return typed, value
        case "calibrate":
            if value in ("start", "stop"):
                return typed, str(value)
    raise OutglowError("invalid_format", f"Invalid value for {setting}")


def effects(devices: Z2MDevices, device: Device, setting: Setting, value: BulbValue) -> list[dict[str, Any]]:
    lines = devices.line_count(device)
    previous = devices.current(device, setting)
    out: list[dict[str, Any]] = []
    match setting:
        case "sensitivity":
            out.append({"code": "overwrites_all_lines", "params": {"lines": lines}})
            out.append({"code": "clears_calibration", "params": {}})
            if devices.current(device, "auto_calibration") is not False:
                out.append({"code": "disables_auto_calibration", "params": {}})
        case "probes":
            if value == 0:
                out.append({"code": "stops_sensing", "params": {}})
            elif isinstance(value, int) and value > (previous if isinstance(previous, int) else 0):
                out.append({"code": "more_radio_traffic", "params": {"from": previous, "to": value}})
        case "sensing":
            if value is False:
                out.append({"code": "stops_sensing", "params": {}})
            else:
                probes = devices.current(device, "probes")
                rate = probes if isinstance(probes, int) and probes > 0 else DEFAULT_PROBES
                out.append({"code": "more_radio_traffic", "params": {"from": 0, "to": rate}})
        case "auto_calibration":
            if value is True:
                out.append({"code": "overwrites_all_lines", "params": {"lines": lines}})
        case "calibrate":
            if value == "start":
                out.append({"code": "starts_calibration", "params": {"seconds": CALIBRATION_S}})
                out.append({"code": "overwrites_all_lines", "params": {"lines": lines}})
        case "self_tuning":
            pass
    return out


def z2m_value(setting: Setting, value: BulbValue) -> BulbValue:
    if setting == "sensing":
        return "ON" if value is True else "OFF"
    return value


@dataclass(frozen=True, slots=True)
class _Token:
    ieee: str
    setting: Setting
    value: BulbValue
    expires: float


class BulbWriter:
    def __init__(
        self,
        hass: HomeAssistant,
        base_topic: str,
        devices: Z2MDevices,
        record: Callable[[str, dict[str, Any]], None],
    ) -> None:
        self._hass = hass
        self._base = base_topic
        self._devices = devices
        self._record = record
        self._tokens: dict[str, _Token] = {}

    def _device(self, ieee: str) -> Device:
        device = self._devices.get(ieee.lower())
        if device is None or not device.outglow:
            raise OutglowError("not_found", "No such Outglow bulb")
        return device

    def preview(self, ieee: str, setting: str, value: object, now: float) -> dict[str, Any]:
        device = self._device(ieee)
        typed, checked = check_value(setting, value)
        self._tokens = {k: v for k, v in self._tokens.items() if v.expires > now}
        token = f"c-{secrets.token_hex(8)}"
        expires = now + TOKEN_TTL_S
        self._tokens[token] = _Token(device.ieee, typed, checked, expires)
        return {
            "confirm_token": token,
            "expires": expires,
            "previous": self._devices.current(device, typed),
            "effects": effects(self._devices, device, typed, checked),
        }

    async def async_write(self, ieee: str, setting: str, value: object, token: str, now: float) -> dict[str, Any]:
        found = self._tokens.get(token)
        if found is None or found.expires <= now:
            self._tokens.pop(token, None)
            raise OutglowError("token_expired", "Confirm again")
        device = self._device(ieee)
        typed, checked = check_value(setting, value)
        if (found.ieee, found.setting, found.value) != (device.ieee, typed, checked) or type(found.value) is not type(
            checked
        ):
            raise OutglowError("token_mismatch", "The token was for another change")
        del self._tokens[token]
        previous = self._devices.current(device, typed)
        await self._publish(f"{self._base}/{device.name}/set", {Z2M_KEYS[typed]: z2m_value(typed, checked)})
        self._record(
            "bulb_write",
            {"ieee": device.ieee, "setting": typed, "value": checked, "previous": previous, "by": "user"},
        )
        return {"written": True, "t": now}

    async def async_set_activity_rate(self, ieee: str, rate: float, reason: str) -> None:
        await async_publish_activity_rate(self._hass, self._base, ieee, rate)
        previous = self._devices.activity_rate(ieee)
        self._devices.options.setdefault(ieee, {})["motion_activity_rate"] = rate
        self._record(
            "bulb_write",
            {"ieee": ieee, "setting": "activity_rate", "value": rate, "previous": previous, "by": reason},
        )

    async def _publish(self, topic: str, payload: Mapping[str, Any]) -> None:
        await mqtt.async_publish(self._hass, topic, json.dumps(payload, separators=(",", ":")))


async def async_publish_activity_rate(hass: HomeAssistant, base: str, ieee: str, rate: float) -> None:
    value = int(rate) if float(rate).is_integer() else rate
    payload = {"id": ieee, "options": {"motion_activity_rate": value}}
    await mqtt.async_publish(hass, f"{base}/bridge/request/device/options", json.dumps(payload, separators=(",", ":")))
