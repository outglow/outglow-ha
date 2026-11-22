import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from functools import partial
from typing import Any

from homeassistant.components import mqtt
from homeassistant.core import CALLBACK_TYPE, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.event import async_call_later

from .const import DOMAIN, ISSUE_RATES_LEFT, ISSUE_RATES_WAITING, RATE_RETRY_MAX_S, RATE_RETRY_S
from .mqtt_source import loads_finite, parse_online
from .store import OutglowStore
from .z2m import Z2MDevices, async_publish_activity_rate, async_restore_raised, follow_reconnect

_LOGGER = logging.getLogger(__name__)
DATA = f"{DOMAIN}_leftover_rates"

Rates = dict[str, dict[str, float]]


@dataclass(slots=True)
class _Watch:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    unsubs: list[CALLBACK_TYPE] = field(default_factory=list)
    topics: dict[str, CALLBACK_TYPE] = field(default_factory=dict)
    devices: dict[str, Z2MDevices] = field(default_factory=dict)
    sent: dict[str, set[str]] = field(default_factory=dict)
    delay: float = RATE_RETRY_S


def _watch(hass: HomeAssistant) -> _Watch:
    found: _Watch | None = hass.data.get(DATA)
    if found is None:
        found = hass.data[DATA] = _Watch()
    return found


async def async_keep(hass: HomeAssistant, base: str, rates: dict[str, float]) -> bool:
    async with _watch(hass).lock:
        store = OutglowStore(hass)
        leftover = await store.async_load_leftover()
        leftover[base] = {**rates, **leftover.get(base, {})}
        await store.async_save_leftover(leftover)
    return await async_retry(hass)


async def async_peek(hass: HomeAssistant, base: str) -> dict[str, float]:
    async with _watch(hass).lock:
        return (await OutglowStore(hass).async_load_leftover()).get(base, {})


async def async_forget(hass: HomeAssistant, base: str, others: bool = False) -> None:
    async with _watch(hass).lock:
        store = OutglowStore(hass)
        leftover = await store.async_load_leftover()
        gone = sorted(b for b in leftover if (b != base) == others)
        if not gone:
            return
        for item in gone:
            if item != base:
                _LOGGER.warning(
                    "Dropping the activity rates left for base topic %s (%s); Outglow now runs on %s",
                    item,
                    ", ".join(sorted(leftover[item])),
                    base,
                )
            del leftover[item]
        await store.async_save_leftover(leftover)
        await _follow(hass, leftover, None)


async def async_retry(hass: HomeAssistant) -> bool:
    watch = _watch(hass)
    async with watch.lock:
        store = OutglowStore(hass)
        leftover = await store.async_load_leftover()
        failed = False
        for base, rates in sorted(leftover.items()):
            devices = watch.devices.setdefault(base, Z2MDevices())
            sent = watch.sent.setdefault(base, set())
            if not await async_restore_raised(devices, rates, sent, partial(async_publish_activity_rate, hass, base)):
                failed = True
        left = {base: rates for base, rates in leftover.items() if rates}
        await store.async_save_leftover(left)
        retry = await _follow(hass, left, watch.delay if failed else None)
        watch.delay = min(watch.delay * 2, RATE_RETRY_MAX_S) if retry is not None else RATE_RETRY_S
        return not left


async def _follow(hass: HomeAssistant, leftover: Rates, retry: float | None) -> float | None:
    watch = _watch(hass)
    for unsub in watch.unsubs:
        unsub()
    watch.unsubs.clear()
    for base in [b for b in watch.topics if b not in leftover]:
        watch.topics.pop(base)()
        watch.devices.pop(base, None)
        watch.sent.pop(base, None)
    for base in sorted(set(leftover) - set(watch.topics)):
        try:
            watch.topics[base] = await mqtt.async_subscribe(hass, f"{base}/bridge/+", _on_bridge(hass, base))
        except HomeAssistantError as err:
            _LOGGER.warning("Could not follow %s/bridge (%s); trying again", base, err)
            retry = watch.delay
    bulbs = sorted(ieee for rates in leftover.values() for ieee in rates)
    if not bulbs:
        ir.async_delete_issue(hass, DOMAIN, ISSUE_RATES_LEFT)
        return None
    placeholders = {"count": str(len(bulbs)), "bulbs": ", ".join(bulbs)}
    if retry is not None:
        placeholders["retry"] = f"{retry / 60:g}"
    ir.async_create_issue(
        hass,
        DOMAIN,
        ISSUE_RATES_LEFT,
        is_fixable=False,
        is_persistent=True,
        severity=ir.IssueSeverity.WARNING,
        translation_key=ISSUE_RATES_LEFT if retry is not None else ISSUE_RATES_WAITING,
        translation_placeholders=placeholders,
    )

    @callback
    def due(_now: Any = None) -> None:
        hass.async_create_task(async_retry(hass))

    watch.unsubs.append(follow_reconnect(hass, watch.sent.values, due))
    if retry is not None:
        watch.unsubs.append(async_call_later(hass, retry, due))
    return retry


def _on_bridge(hass: HomeAssistant, base: str) -> Callable[[mqtt.ReceiveMessage], None]:
    @callback
    def received(msg: mqtt.ReceiveMessage) -> None:
        watch = _watch(hass)
        devices = watch.devices.setdefault(base, Z2MDevices())
        payload = msg.payload if isinstance(msg.payload, str) else msg.payload.decode("utf-8", "replace")
        if msg.topic == f"{base}/bridge/state":
            devices.bridge_online = parse_online(payload)
            if devices.bridge_online is not True:
                watch.sent.setdefault(base, set()).clear()
        elif msg.topic == f"{base}/bridge/info":
            try:
                data = loads_finite(payload)
            except ValueError:
                return
            if not isinstance(data, dict):
                return
            devices.update_info(data)
        else:
            return
        hass.async_create_task(async_retry(hass))

    return received
