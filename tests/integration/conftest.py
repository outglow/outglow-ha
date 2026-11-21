from pathlib import Path

import pytest
from homeassistant.core import HomeAssistant

from custom_components.outglow import coordinator as coordinator_module
from tests.integration.common import Clock


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    return None


@pytest.fixture
def expected_lingering_timers() -> bool:
    return True


@pytest.fixture(autouse=True)
def config_dir(hass: HomeAssistant, tmp_path: Path) -> Path:
    hass.config.config_dir = str(tmp_path)
    return tmp_path


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(coordinator_module, "CLOCK", fake)
    return fake
