import asyncio
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import aiohttp
from homeassistant.components import mqtt
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from . import plan_import, valetudo
from .engine.types import Plan
from .errors import OutglowError

MAP_PATH = "/api/v2/robot/state/map"
MANUFACTURER = "Valetudo"
FETCH_TIMEOUT_S = 15.0
MQTT_WAIT_S = 5.0
MAX_MAP_BYTES = plan_import.MAX_TEXT
CHUNK = 64 * 1024
ROBOT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def robots(hass: HomeAssistant) -> list[dict[str, Any]]:
    found = []
    for device in dr.async_get(hass).devices:
        if device.manufacturer != MANUFACTURER:
            continue
        robot = next((value for domain, value in sorted(device.identifiers) if domain == "mqtt"), None)
        if robot is None or not ROBOT_ID.match(robot):
            continue
        url = str(device.configuration_url) if device.configuration_url else None
        found.append(
            {
                "id": robot,
                "name": device.name_by_user or device.name or robot,
                "url": url if url and urlsplit(url).scheme in ("http", "https") else None,
            }
        )
    return sorted(found, key=lambda r: (r["name"], r["id"]))


def map_url(address: str) -> str:
    text = address.strip()
    parts = urlsplit(text if "://" in text else f"http://{text}")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise OutglowError("invalid_format", "The robot address must be an http or https address")
    if parts.username is not None or parts.password is not None:
        raise OutglowError("invalid_format", "Leave the user name and password out of the robot address")
    path = parts.path.rstrip("/")
    if not path.endswith(MAP_PATH):
        path += MAP_PATH
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


async def async_http_map(hass: HomeAssistant, address: str) -> bytes:
    url = map_url(address)
    session = async_get_clientsession(hass)
    try:
        async with session.get(
            url, timeout=aiohttp.ClientTimeout(total=FETCH_TIMEOUT_S), allow_redirects=False
        ) as response:
            if response.status != 200:
                raise OutglowError("fetch_failed", f"The robot answered {response.status}")
            data = bytearray()
            async for chunk in response.content.iter_chunked(CHUNK):
                data += chunk
                if len(data) > MAX_MAP_BYTES:
                    raise OutglowError("invalid_format", "The map is too large")
            return bytes(data)
    except (aiohttp.ClientError, TimeoutError, OSError, ValueError) as err:
        raise OutglowError("fetch_failed", f"Cannot reach the robot: {type(err).__name__}") from err


async def async_mqtt_map(hass: HomeAssistant, robot: str) -> bytes:
    if not ROBOT_ID.match(robot):
        raise OutglowError("invalid_format", "Unknown robot")
    got: asyncio.Future[bytes] = hass.loop.create_future()

    @callback
    def received(message: Any) -> None:
        if not got.done() and isinstance(message.payload, bytes) and message.payload:
            got.set_result(message.payload)

    unsubscribe = await mqtt.async_subscribe(hass, f"+/{robot}/MapData/map-data", received, encoding=None)
    try:
        async with asyncio.timeout(MQTT_WAIT_S):
            return await got
    except TimeoutError as err:
        raise OutglowError("not_found", "The robot has not published its map over MQTT") from err
    finally:
        unsubscribe()


def inflate(payload: bytes) -> bytes:
    if payload.lstrip()[:1] == b"{":
        if len(payload) > MAX_MAP_BYTES:
            raise OutglowError("invalid_format", "The map is too large")
        return payload
    return plan_import.inflate(payload, MAX_MAP_BYTES, "The map", "neither JSON nor deflated JSON")


def load(payload: bytes, known: Mapping[str, str], current: Plan | None) -> plan_import.Imported:
    data = plan_import.read_json(inflate(payload), "The robot did not send JSON")
    if not valetudo.is_map(data):
        raise OutglowError("invalid_format", "Not a Valetudo map")
    return plan_import.build("valetudo_map", data, known, current)
