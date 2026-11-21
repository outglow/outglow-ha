import asyncio
from typing import Any

import probatio
from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers import selector

from .const import (
    BRIDGE_WAIT_S,
    CONF_BASE_TOPIC,
    CONF_LOG_LEVEL,
    DEFAULT_BASE_TOPIC,
    DEFAULT_LOG_LEVEL,
    DOMAIN,
    LOG_LEVELS,
    STATE_WAIT_S,
)
from .mqtt_source import loads_finite
from .z2m import Z2MDevices


class OutglowConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    def __init__(self) -> None:
        self._topic = DEFAULT_BASE_TOPIC
        self._found: dict[str, str] = {}

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OutglowOptionsFlow:
        return OutglowOptionsFlow()

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if not self.hass.config_entries.async_entries("mqtt"):
            return self.async_abort(reason="mqtt_missing")
        errors: dict[str, str] = {}
        if user_input is not None:
            topic = str(user_input[CONF_BASE_TOPIC]).strip().strip("/")
            if topic and "#" not in topic and "+" not in topic:
                await self.async_set_unique_id(topic)
                self._abort_if_unique_id_configured()
                self._topic = topic
                self._found = await self._async_probe(topic)
                return await self.async_step_summary()
            errors[CONF_BASE_TOPIC] = "invalid_topic"
        schema = probatio.Schema({probatio.Required(CONF_BASE_TOPIC, default=DEFAULT_BASE_TOPIC): str})
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)

    async def _async_probe(self, topic: str) -> dict[str, str]:
        devices = Z2MDevices()
        seen = asyncio.Event()
        info = asyncio.Event()
        done = asyncio.Event()
        states: dict[str, dict[str, Any]] = {}

        def check() -> None:
            if seen.is_set() and info.is_set() and all(d.name in states for d in devices.bulbs()):
                done.set()

        @callback
        def on_devices(msg: mqtt.ReceiveMessage) -> None:
            try:
                devices.update_devices(loads_finite(msg.payload), 0.0)
            except ValueError:
                return
            seen.set()
            check()

        @callback
        def on_info(msg: mqtt.ReceiveMessage) -> None:
            try:
                devices.update_info(loads_finite(msg.payload))
            except ValueError:
                return
            info.set()
            check()

        @callback
        def on_state(msg: mqtt.ReceiveMessage) -> None:
            try:
                data = loads_finite(msg.payload)
            except ValueError:
                return
            if isinstance(data, dict):
                states[msg.topic.removeprefix(f"{topic}/")] = data
                check()

        unsubs = [
            await mqtt.async_subscribe(self.hass, f"{topic}/bridge/info", on_info),
            await mqtt.async_subscribe(self.hass, f"{topic}/bridge/devices", on_devices),
            await mqtt.async_subscribe(self.hass, f"{topic}/#", on_state),
        ]
        try:
            async with asyncio.timeout(BRIDGE_WAIT_S):
                await seen.wait()
            async with asyncio.timeout(STATE_WAIT_S):
                await done.wait()
        except TimeoutError:
            pass
        finally:
            for unsub in unsubs:
                unsub()
        for name, data in states.items():
            device = devices.by_name(name)
            if device is not None:
                devices.update_state(device.ieee, data)
        bulbs = devices.bulbs()
        sensing = [d for d in bulbs if d.sensing_capable and devices.sensing(d)]
        reporting = [d for d in bulbs if (devices.activity_rate(d.ieee) or 0) > 0]
        return {
            "bridge": "yes" if seen.is_set() else "no",
            "bulbs": str(len(bulbs)),
            "sensing": str(len(sensing)),
            "reporting": str(len(reporting)),
            "version": devices.version or "?",
        }

    async def async_step_summary(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="Outglow", data={CONF_BASE_TOPIC: self._topic})
        return self.async_show_form(
            step_id="summary" if self._found.get("bridge") == "yes" else "no_bridge",
            data_schema=probatio.Schema({}),
            description_placeholders={**self._found, "topic": self._topic},
        )

    async def async_step_no_bridge(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        return await self.async_step_summary(user_input)


class OutglowOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = self.config_entry.options.get(CONF_LOG_LEVEL, DEFAULT_LOG_LEVEL)
        schema = probatio.Schema(
            {
                probatio.Required(CONF_LOG_LEVEL, default=current): selector.SelectSelector(
                    selector.SelectSelectorConfig(options=list(LOG_LEVELS), translation_key="log_level")
                )
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
