from tools import quick

PY = {
    "custom_components/outglow/__init__.py": "from .coordinator import OutglowCoordinator\n",
    "custom_components/outglow/coordinator.py": "from .engine.core import Engine\nfrom . import const\n",
    "custom_components/outglow/const.py": "X = 1\n",
    "custom_components/outglow/engine/__init__.py": "",
    "custom_components/outglow/engine/core.py": "from .rules import decide\n",
    "custom_components/outglow/engine/rules.py": "def decide() -> None: ...\n",
    "custom_components/outglow/engine/quality.py": "from engine.rules import decide\n",
    "tools/eval.py": "from engine.core import Engine\n",
    "tests/engine/helpers.py": "from engine import quality\n",
    "tests/engine/test_rules.py": "from engine.rules import decide\n",
    "tests/engine/test_quality.py": "from tests.engine.helpers import thing\n",
    "tests/engine/test_tools.py": "from tools import eval as evaluation\n",
    "tests/integration/conftest.py": "",
    "tests/integration/test_setup.py": "from custom_components.outglow import const\n",
}
TS = {
    "frontend/src/geometry.ts": "export const g = 1;\n",
    "frontend/src/editor/ops.ts": 'import { g } from "../geometry";\n',
    "frontend/src/views/plan-editor.ts": 'import { op } from "../editor/ops";\n',
    "frontend/src/views/live-view.ts": 'import { t } from "../theme";\n',
    "frontend/src/theme.ts": "export const t = 1;\n",
    "frontend/src/plan-view.ts": 'import { g } from "./geometry";\n',
}
SPECS = [
    "frontend/e2e/editor.spec.ts",
    "frontend/e2e/editor-corners.spec.ts",
    "frontend/e2e/live.spec.ts",
    "frontend/e2e/plan-focus.spec.ts",
    "frontend/e2e/screenshots.spec.ts",
    "frontend/e2e/brand-new.spec.ts",
]


def test_module_names_cover_the_package_and_the_engine_root() -> None:
    assert quick.module_names("custom_components/outglow/engine/core.py") == {
        "custom_components.outglow.engine.core",
        "engine.core",
    }
    assert quick.module_names("custom_components/outglow/__init__.py") == {"custom_components.outglow"}
    assert quick.module_names("tools/eval.py") == {"tools.eval"}


def test_relative_imports_resolve_from_modules_and_packages() -> None:
    graph = quick.python_graph(PY)
    assert graph["custom_components/outglow/coordinator.py"] == {
        "custom_components/outglow/engine/core.py",
        "custom_components/outglow/const.py",
        "custom_components/outglow/__init__.py",
    }
    assert graph["custom_components/outglow/__init__.py"] == {"custom_components/outglow/coordinator.py"}


def test_a_rule_change_runs_every_test_that_reaches_it() -> None:
    picked = quick.python_tests(["custom_components/outglow/engine/rules.py"], PY)
    assert picked == [
        "tests/engine/test_quality.py",
        "tests/engine/test_rules.py",
        "tests/engine/test_tools.py",
        "tests/integration/test_setup.py",
    ]


def test_a_leaf_change_runs_only_its_users() -> None:
    assert quick.python_tests(["custom_components/outglow/const.py"], PY) == ["tests/integration/test_setup.py"]
    assert quick.python_tests(["tests/engine/test_rules.py"], PY) == ["tests/engine/test_rules.py"]


def test_conftest_fixtures_and_package_data_widen_the_run() -> None:
    assert quick.python_tests(["tests/integration/conftest.py"], PY) == ["tests/integration/test_setup.py"]
    assert len(quick.python_tests(["tests/fixtures/valetudo/flat.json"], PY)) == 4
    assert quick.python_tests(["custom_components/outglow/translations/pl.json"], PY) == [
        "tests/integration/test_setup.py"
    ]
    assert quick.python_tests(["custom_components/outglow/frontend/outglow-panel.js"], PY) == []


def test_e2e_specs_follow_the_view_that_imports_the_change() -> None:
    assert quick.e2e_specs(["frontend/src/editor/ops.ts"], SPECS, TS) == [
        "frontend/e2e/brand-new.spec.ts",
        "frontend/e2e/editor-corners.spec.ts",
        "frontend/e2e/editor.spec.ts",
    ]
    assert quick.e2e_specs(["frontend/src/geometry.ts"], SPECS, TS) == [
        "frontend/e2e/brand-new.spec.ts",
        "frontend/e2e/editor-corners.spec.ts",
        "frontend/e2e/editor.spec.ts",
        "frontend/e2e/plan-focus.spec.ts",
    ]


def test_e2e_runs_everything_for_the_mock_and_a_spec_on_its_own() -> None:
    every = quick.e2e_specs(["frontend/mock/backend.ts"], SPECS, TS)
    assert "frontend/e2e/screenshots.spec.ts" not in every
    assert len(every) == 5
    assert quick.e2e_specs(["frontend/e2e/screenshots.spec.ts"], SPECS, TS) == ["frontend/e2e/screenshots.spec.ts"]
    assert quick.e2e_specs(["custom_components/outglow/coordinator.py"], SPECS, TS) == []


def test_the_plan_picks_steps_by_kind() -> None:
    p = quick.plan(["custom_components/outglow/const.py", "docs/api.md"], PY, TS, SPECS)
    assert p.lint == ["custom_components/outglow/const.py"]
    assert p.python
    assert p.contracts
    assert not p.typescript
    assert not p.vitest
    steps = quick.commands(p, "abc", "py", e2e=True, workers=2)
    assert ["py", "-m", "pytest", "-q", "tests/test_repo.py", "tests/integration/test_setup.py"] in steps
    front = quick.plan(["frontend/src/theme.ts"], PY, TS, SPECS)
    steps = quick.commands(front, "abc", "py", e2e=True, workers=2)
    assert steps[-1][-3:] == ["--workers=2", "e2e/brand-new.spec.ts", "e2e/live.spec.ts"]
    assert quick.commands(front, "abc", "py", e2e=False, workers=2)[-1] == [
        "npm",
        "--prefix",
        "frontend",
        "test",
        "--",
        "--changed",
        "abc",
    ]
