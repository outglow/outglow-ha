import json
import logging
import math
import re
from collections.abc import Callable, Mapping
from typing import Any, Protocol

from homeassistant.components import mqtt
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback

from .engine.source import SourceClassifier
from .engine.types import LightState, LinkReading, Observation
from .z2m import Z2MDevices

_LOGGER = logging.getLogger(__name__)
IEEE = re.compile(r"^0x[0-9a-f]{16}$")
SKIPPED_SUFFIXES = ("/set", "/get")


class ObservationSink(Protocol):
    def observe(self, obs: Observation) -> None: ...

    def bridge_changed(self) -> None: ...

    def availability_changed(self, ieee: str, online: bool) -> None: ...


def _not_finite(token: str) -> Any:
    raise ValueError(f"{token} is not a finite number")


def _finite(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError(f"{text} is not a finite number")
    return value


def loads_finite(text: str | bytes | bytearray) -> Any:
    return json.loads(text, parse_constant=_not_finite, parse_float=_finite)


def normalise_ieee(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    ieee = value.strip().lower()
    return ieee if IEEE.match(ieee) else None


def _int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return round(value)


def _float(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def parse_link(item: object) -> LinkReading | None:
    if not isinstance(item, Mapping):
        return None
    tx = normalise_ieee(item.get("ieee_address"))
    if tx is None:
        return None
    signal = _int(item.get("signal"))
    return LinkReading(
        tx=tx,
        motion=item.get("motion") is True,
        signal_dbm=signal if signal not in (None, 0) else None,
        noise_db=_float(item.get("noise")),
        sensitivity=_int(item.get("sensitivity")),
        calibrated_sensitivity=_int(item.get("calibrated_sensitivity")),
        raw_activity=_int(item.get("activity")),
    )


def parse_links(raw: object) -> tuple[LinkReading, ...]:
    if not isinstance(raw, list):
        return ()
    links = (parse_link(item) for item in raw)
    return tuple(link for link in links if link is not None)


def parse_light(payload: Mapping[str, Any]) -> LightState | None:
    state = payload.get("state")
    if not isinstance(state, str) or state.upper() not in ("ON", "OFF"):
        return None
    return LightState(
        on=state.upper() == "ON",
        brightness=_int(payload.get("brightness")),
        color_temp=_int(payload.get("color_temp")),
    )


def parse_observation(t: float, rx: str, payload: Mapping[str, Any]) -> Observation | None:
    has_links = isinstance(payload.get("motion_links"), list)
    light = parse_light(payload)
    if not has_links and light is None:
        return None
    occupancy = payload.get("occupancy")
    return Observation(
        t=t,
        rx=rx,
        links=parse_links(payload.get("motion_links")),
        occupancy=occupancy if isinstance(occupancy, bool) else None,
        light=light,
        source="unknown",
    )


def parse_online(payload: str) -> bool | None:
    text = payload.strip()
    try:
        data = loads_finite(text)
    except ValueError:
        data = text
    if isinstance(data, Mapping):
        data = data.get("state")
    if isinstance(data, str) and data.lower() in ("online", "offline"):
        return data.lower() == "online"
    return None


class MqttSource:
    def __init__(
        self,
        hass: HomeAssistant,
        base_topic: str,
        devices: Z2MDevices,
        sink: ObservationSink,
        clock: Callable[[], float],
    ) -> None:
        self._hass = hass
        self._base = base_topic
        self._devices = devices
        self._sink = sink
        self._clock = clock
        self._unsub: CALLBACK_TYPE | None = None
        self.classifier = SourceClassifier()
        self.messages = 0

    async def async_start(self) -> None:
        self._unsub = await mqtt.async_subscribe(self._hass, f"{self._base}/#", self._on_message, encoding=None)

    @callback
    def async_stop(self) -> None:
        if self._unsub is not None:
            self._unsub()
            self._unsub = None

    def flush(self, t: float) -> None:
        for obs in self.classifier.expire(t):
            self._sink.observe(obs)

    @callback
    def _on_message(self, msg: mqtt.ReceiveMessage) -> None:
        topic = msg.topic
        if not topic.startswith(f"{self._base}/"):
            return
        rest = topic[len(self._base) + 1 :]
        payload = msg.payload
        text = payload.decode("utf-8", "replace") if isinstance(payload, bytes) else str(payload)
        if rest.startswith("bridge/"):
            self._on_bridge(rest.removeprefix("bridge/"), text)
            return
        if rest.endswith(SKIPPED_SUFFIXES):
            return
        if rest.endswith("/availability") and self._devices.by_name(rest.removesuffix("/availability")):
            self._on_availability(rest.removesuffix("/availability"), text)
            return
        device = self._devices.by_name(rest)
        if device is None or not device.outglow:
            return
        try:
            data = loads_finite(text)
        except ValueError:
            return
        if not isinstance(data, dict):
            return
        self.messages += 1
        self._devices.update_state(device.ieee, data)
        obs = parse_observation(self._clock(), device.ieee, data)
        if obs is None:
            return
        for item in self.classifier.push(obs):
            self._sink.observe(item)

    def _on_bridge(self, kind: str, text: str) -> None:
        if kind == "state":
            self._devices.bridge_online = parse_online(text)
            self._sink.bridge_changed()
            return
        if kind not in ("devices", "info"):
            return
        try:
            data = loads_finite(text)
        except ValueError:
            _LOGGER.debug("Ignoring a bridge/%s message that is not JSON", kind)
            return
        if kind == "devices":
            self._devices.update_devices(data, self._clock())
        else:
            self._devices.update_info(data)
        self._sink.bridge_changed()

    def _on_availability(self, name: str, text: str) -> None:
        device = self._devices.by_name(name)
        online = parse_online(text)
        if device is None or online is None:
            return
        self._devices.set_available(device.ieee, online)
        self._sink.availability_changed(device.ieee, online)
