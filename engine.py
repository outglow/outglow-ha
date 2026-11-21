import importlib.util
import sys
from pathlib import Path

_PACKAGE = Path(__file__).resolve().parent / "custom_components" / "outglow" / "engine"
_spec = importlib.util.spec_from_file_location(
    __name__, _PACKAGE / "__init__.py", submodule_search_locations=[str(_PACKAGE)]
)
if _spec is None or _spec.loader is None:
    raise ImportError(f"cannot load the engine from {_PACKAGE}")
_module = importlib.util.module_from_spec(_spec)
sys.modules[__name__] = _module
_spec.loader.exec_module(_module)
