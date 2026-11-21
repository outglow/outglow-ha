import ast
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[2] / "custom_components" / "outglow" / "engine"
ALLOWED_ROOTS = {
    "collections",
    "dataclasses",
    "functools",
    "heapq",
    "itertools",
    "json",
    "math",
    "operator",
    "statistics",
    "types",
    "typing",
    "bisect",
    "enum",
}


def _imports(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            names.add(node.module.split(".")[0])
    return names


def test_engine_imports_only_the_standard_library() -> None:
    used = set().union(*(_imports(p) for p in ENGINE.glob("*.py")))
    assert "homeassistant" not in used
    assert used <= ALLOWED_ROOTS


def test_engine_uses_no_clock_or_randomness() -> None:
    used = set().union(*(_imports(p) for p in ENGINE.glob("*.py")))
    assert not used & {"time", "datetime", "random", "uuid", "os", "secrets"}
