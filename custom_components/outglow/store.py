import hashlib
import json
import logging
from collections.abc import Callable
from dataclasses import fields
from pathlib import Path
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import RATE_DEFAULT
from .engine import CodecError, from_json, to_json
from .engine.types import Json, Plan, Settings

_LOGGER = logging.getLogger(__name__)

PLAN_KEY = "outglow.plan"
SETTINGS_KEY = "outglow.settings"
MODEL_KEY = "outglow.model"
SNAPSHOTS_KEY = "outglow.model_snapshots"
RUNTIME_KEY = "outglow.runtime"
LEFTOVER_KEY = "outglow.leftover_rates"
VALETUDO_KEY = "outglow.valetudo"
COPIES_KEY = "outglow.plan_copies"
COPY_PREFIX = f"{PLAN_KEY}.corrupt-"
HA_COPY_PREFIX = f"{PLAN_KEY}.corrupt."
COPIES_KEPT = 3
PLAN_MINOR = 2
MODEL_MINOR = 3
SAVE_DELAY_S = 5.0


def _known(cls: type, data: dict[str, Any]) -> dict[str, Any]:
    names = {f.metadata.get("json", f.name) for f in fields(cls)}
    return {k: v for k, v in data.items() if k in names}


def _lower(value: object) -> object:
    return value.lower() if isinstance(value, str) else value


def migrate_plan(data: dict[str, Any]) -> dict[str, Any]:
    plan = _known(Plan, dict(data))
    bulbs = plan.get("bulbs", [])
    if isinstance(bulbs, list):
        plan["bulbs"] = [{**bulb, "ieee": _lower(bulb.get("ieee"))} for bulb in bulbs if isinstance(bulb, dict)]
    excluded = plan.get("excluded_directions", [])
    if isinstance(excluded, list):
        plan["excluded_directions"] = [
            {**item, "rx": _lower(item.get("rx")), "tx": _lower(item.get("tx"))}
            for item in excluded
            if isinstance(item, dict)
        ]
    return plan


def migrate_model(data: dict[str, Any]) -> dict[str, Any]:
    engine = data.get("engine")
    if not isinstance(engine, dict):
        version = int(data.get("version") or 0)
        engine = {"active": {"model_version": version}} if version else None
    return {"engine": engine, "seq": int(data.get("seq") or 0), "last_calibration": data.get("last_calibration")}


class _PlanStore(Store[dict[str, Any]]):
    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict[str, Any]
    ) -> dict[str, Any]:
        if old_major_version > 1:
            raise NotImplementedError
        try:
            return migrate_plan(old_data)
        except TypeError, ValueError, AttributeError:
            return old_data


class _ModelStore(Store[dict[str, Any]]):
    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict[str, Any]
    ) -> dict[str, Any]:
        if old_major_version > 1:
            raise NotImplementedError
        return migrate_model(old_data)


def decode_plan(data: object) -> Plan | None:
    if data is None:
        return Plan()
    if not isinstance(data, dict):
        _LOGGER.error("Stored plan is not an object; starting with an empty plan")
        return None
    try:
        return from_json(Plan, migrate_plan(data))
    except CodecError, TypeError, ValueError, AttributeError:
        _LOGGER.exception("Stored plan is invalid; starting with an empty plan")
        return None


def decode_settings(data: object) -> Settings:
    if not isinstance(data, dict):
        return Settings()
    try:
        return from_json(Settings, data)
    except CodecError:
        _LOGGER.exception("Stored settings are invalid; using the defaults")
        return Settings()


class OutglowStore:
    def __init__(self, hass: HomeAssistant) -> None:
        self._hass = hass
        self._plan = _PlanStore(hass, 1, PLAN_KEY, minor_version=PLAN_MINOR)
        self._settings: Store[dict[str, Any]] = Store(hass, 1, SETTINGS_KEY)
        self._model = _ModelStore(hass, 1, MODEL_KEY, minor_version=MODEL_MINOR, serialize_in_event_loop=False)
        self._snapshots: Store[dict[str, Any]] = Store(hass, 1, SNAPSHOTS_KEY, serialize_in_event_loop=False)
        self._runtime: Store[dict[str, Any]] = Store(hass, 1, RUNTIME_KEY)
        self._leftover: Store[dict[str, Any]] = Store(hass, 1, LEFTOVER_KEY)
        self._valetudo: Store[dict[str, Any]] = Store(hass, 1, VALETUDO_KEY)
        self._copies: Store[dict[str, Any]] = Store(hass, 1, COPIES_KEY)
        self.copy_key: str | None = None

    def copy_path(self, key: str) -> str:
        return self._hass.config.path(".storage", key)

    async def async_load_plan(self) -> tuple[Plan, str | None]:
        data = await self._plan.async_load()
        plan = decode_plan(data)
        loaded = await self._load_copies()
        index = loaded
        if plan is None:
            index = await self._keep_copy(index, data)
        elif data is None:
            renamed = await self._hass.async_add_executor_job(self._ha_copies)
            index = {**index, "pending": renamed[-1]} if renamed else index
        pending = index.get("pending")
        self.copy_key = pending if isinstance(pending, str) else None
        if index != loaded:
            await self._copies.async_save(index)
        if self.copy_key is None:
            return plan or Plan(), None
        _LOGGER.error("The stored plan could not be read; it is kept as %s", self.copy_path(self.copy_key))
        return plan or Plan(), self.copy_path(self.copy_key)

    async def _load_copies(self) -> dict[str, Any]:
        data = await self._copies.async_load() or {}
        items = data.get("copies")
        copies = [c for c in items if isinstance(c, dict)] if isinstance(items, list) else []
        return {"copies": copies, "pending": data.get("pending")}

    async def _keep_copy(self, index: dict[str, Any], data: object) -> dict[str, Any]:
        digest = hashlib.sha256(json.dumps(data, sort_keys=True, default=str).encode()).hexdigest()
        copies: list[dict[str, Any]] = index["copies"]
        same = next((c["key"] for c in copies if c.get("hash") == digest), None)
        if same is not None:
            return {**index, "pending": same}
        key = f"{COPY_PREFIX}{dt_util.utcnow().strftime('%Y%m%dT%H%M%S%fZ')}"
        await Store[Any](self._hass, 1, key).async_save(data)
        kept = [*copies, {"key": key, "hash": digest}]
        for old in kept[:-COPIES_KEPT]:
            await Store[Any](self._hass, 1, str(old.get("key"))).async_remove()
        return {"copies": kept[-COPIES_KEPT:], "pending": key}

    def _ha_copies(self) -> list[str]:
        return sorted(p.name for p in Path(self.copy_path("")).glob(f"{HA_COPY_PREFIX}*") if p.is_file())

    async def async_load_copy(self) -> Plan | None:
        if self.copy_key is None:
            return None
        data = await _PlanStore(self._hass, 1, self.copy_key, minor_version=PLAN_MINOR).async_load()
        return decode_plan(data) if data is not None else None

    async def async_resolve_copy(self) -> None:
        if self.copy_key is not None:
            self.copy_key = None
            await self._copies.async_save({**(await self._load_copies()), "pending": None})

    async def async_load_settings(self) -> Settings:
        return decode_settings(await self._settings.async_load())

    async def async_load_model(self) -> dict[str, Any]:
        return migrate_model(await self._model.async_load() or {})

    async def async_load_snapshots(self) -> list[dict[str, Any]]:
        data = await self._snapshots.async_load() or {}
        items = data.get("snapshots")
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []

    async def async_load_runtime(self) -> dict[str, Any]:
        return await self._runtime.async_load() or {}

    async def async_save_plan(self, plan: Plan) -> None:
        await self._plan.async_save(_object(to_json(plan)))

    async def async_save_settings(self, settings: Settings) -> None:
        await self._settings.async_save(_object(to_json(settings)))

    def schedule_model(self, data: Callable[[], dict[str, Any]]) -> None:
        self._model.async_delay_save(data, SAVE_DELAY_S)

    async def async_save_model(self, data: dict[str, Any]) -> None:
        await self._model.async_save(data)

    async def async_save_snapshots(self, snapshots: list[dict[str, Any]]) -> None:
        await self._snapshots.async_save({"snapshots": list(snapshots)})

    async def async_save_runtime(self, data: dict[str, Any]) -> None:
        await self._runtime.async_save(data)

    async def async_load_leftover(self) -> dict[str, dict[str, float]]:
        data = await self._leftover.async_load() or {}
        rates = data.get("rates")
        return {
            str(base): {str(ieee): _rate(rate) for ieee, rate in items.items()}
            for base, items in (rates.items() if isinstance(rates, dict) else ())
            if isinstance(items, dict)
        }

    async def async_save_leftover(self, rates: dict[str, dict[str, float]]) -> None:
        if any(rates.values()):
            await self._leftover.async_save({"rates": rates})
        else:
            await self._leftover.async_remove()

    async def async_load_valetudo_url(self) -> str | None:
        url = (await self._valetudo.async_load() or {}).get("url")
        return url if isinstance(url, str) and url else None

    async def async_save_valetudo_url(self, url: str) -> None:
        await self._valetudo.async_save({"url": url})

    async def async_remove(self) -> None:
        for item in (await self._load_copies())["copies"]:
            await Store[Any](self._hass, 1, str(item.get("key"))).async_remove()
        for store in (
            self._plan,
            self._settings,
            self._model,
            self._snapshots,
            self._runtime,
            self._valetudo,
            self._copies,
        ):
            await store.async_remove()
        for name in await self._hass.async_add_executor_job(self._ha_copies):
            await self._hass.async_add_executor_job(Path(self.copy_path(name)).unlink, True)


def _rate(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else float(RATE_DEFAULT)


def _object(value: Json) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError("expected an object")
    return value
