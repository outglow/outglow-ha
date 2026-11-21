import logging
from dataclasses import fields
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

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
    plan["bulbs"] = [
        {**bulb, "ieee": _lower(bulb.get("ieee"))} for bulb in plan.get("bulbs", []) if isinstance(bulb, dict)
    ]
    plan["excluded_directions"] = [
        {**item, "rx": _lower(item.get("rx")), "tx": _lower(item.get("tx"))}
        for item in plan.get("excluded_directions", [])
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
        return migrate_plan(old_data)


class _ModelStore(Store[dict[str, Any]]):
    async def _async_migrate_func(
        self, old_major_version: int, old_minor_version: int, old_data: dict[str, Any]
    ) -> dict[str, Any]:
        if old_major_version > 1:
            raise NotImplementedError
        return migrate_model(old_data)


def decode_plan(data: object) -> Plan:
    if not isinstance(data, dict):
        return Plan()
    try:
        return from_json(Plan, migrate_plan(data))
    except CodecError:
        _LOGGER.exception("Stored plan is invalid; starting with an empty plan")
        return Plan()


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
        self._plan = _PlanStore(hass, 1, PLAN_KEY, minor_version=PLAN_MINOR)
        self._settings: Store[dict[str, Any]] = Store(hass, 1, SETTINGS_KEY)
        self._model = _ModelStore(hass, 1, MODEL_KEY, minor_version=MODEL_MINOR)
        self._snapshots: Store[dict[str, Any]] = Store(hass, 1, SNAPSHOTS_KEY)
        self._runtime: Store[dict[str, Any]] = Store(hass, 1, RUNTIME_KEY)
        self._leftover: Store[dict[str, Any]] = Store(hass, 1, LEFTOVER_KEY)
        self._valetudo: Store[dict[str, Any]] = Store(hass, 1, VALETUDO_KEY)

    async def async_load_plan(self) -> Plan:
        return decode_plan(await self._plan.async_load())

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

    def schedule_model(self, data: dict[str, Any]) -> None:
        self._model.async_delay_save(lambda: data, SAVE_DELAY_S)

    async def async_save_model(self, data: dict[str, Any]) -> None:
        await self._model.async_save(data)

    async def async_save_snapshots(self, snapshots: list[dict[str, Any]]) -> None:
        await self._snapshots.async_save({"snapshots": snapshots})

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
        for store in (self._plan, self._settings, self._model, self._snapshots, self._runtime, self._valetudo):
            await store.async_remove()


def _rate(value: object) -> float:
    return float(value) if isinstance(value, int | float) and not isinstance(value, bool) else float(RATE_DEFAULT)


def _object(value: Json) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError("expected an object")
    return value
