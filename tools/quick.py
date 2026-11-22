import argparse
import ast
import fnmatch
import re
import subprocess
import sys
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ("custom_components", "outglow")
BUILT = "custom_components/outglow/frontend/"
PYTHON_DIRS = ("custom_components/", "tools/", "tests/")
SRC = "frontend/src/"
E2E = "frontend/e2e/"
EVERY_SPEC = (
    "frontend/mock/",
    "frontend/e2e/helpers.ts",
    "frontend/playwright.config.ts",
    "frontend/vite.mock.config.ts",
)
EVERY_SPEC_SRC = ("outglow-panel.ts", "outglow-cards.ts")
ON_REQUEST = ("screenshots.spec.ts", "docs.spec.ts")
SPEC_ENTRIES: Mapping[str, tuple[str, ...]] = {
    "editor*.spec.ts": ("views/plan-editor.ts",),
    "plan-focus.spec.ts": ("plan-view.ts",),
    "live.spec.ts": ("views/live-view.ts",),
    "history.spec.ts": ("views/history-view.ts",),
    "quality-settings.spec.ts": ("views/quality-view.ts", "views/settings-view.ts"),
    "wizard.spec.ts": ("wizard.ts", "views/learn-view.ts"),
    "sheet-focus.spec.ts": ("components/og-sheet.ts",),
}
TS_IMPORT = re.compile(r"""(?:from|import)\s*\(?\s*["'](\.[^"']+)["']""")


@dataclass
class Plan:
    lint: list[str] = field(default_factory=list)
    python: bool = False
    contracts: bool = False
    pytest: list[str] = field(default_factory=list)
    typescript: bool = False
    vitest: bool = False
    e2e: list[str] = field(default_factory=list)


def module_names(rel: str) -> set[str]:
    parts = list(Path(rel).with_suffix("").parts)
    if parts[-1] == "__init__":
        parts.pop()
    names = {".".join(parts)} if parts else set()
    if tuple(parts[:2]) == PACKAGE and len(parts) > 2:
        names.add(".".join(parts[2:]))
    return names


def _package(rel: str) -> list[str]:
    parts = list(Path(rel).with_suffix("").parts)
    return parts[:-1]


def imported(rel: str, source: str) -> set[str]:
    out: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            out.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                base = _package(rel)[: len(_package(rel)) - node.level + 1]
                stem = ".".join([*base, *([node.module] if node.module else [])])
            else:
                stem = node.module or ""
            out.add(stem)
            out.update(f"{stem}.{alias.name}" if stem else alias.name for alias in node.names)
    return out


def _resolve(name: str, modules: Mapping[str, str]) -> str | None:
    parts = name.split(".")
    found = (modules.get(".".join(parts[:n])) for n in range(len(parts), 0, -1))
    return next((rel for rel in found if rel is not None), None)


def python_graph(sources: Mapping[str, str]) -> dict[str, set[str]]:
    modules = {name: rel for rel in sources for name in module_names(rel)}
    graph: dict[str, set[str]] = {}
    for rel, source in sources.items():
        targets = (_resolve(name, modules) for name in imported(rel, source))
        graph[rel] = {target for target in targets if target is not None and target != rel}
    return graph


def dependants(graph: Mapping[str, set[str]], changed: Iterable[str]) -> set[str]:
    reverse: dict[str, set[str]] = {}
    for rel, deps in graph.items():
        for dep in deps:
            reverse.setdefault(dep, set()).add(rel)
    seen = set(changed)
    todo = list(seen)
    while todo:
        for user in reverse.get(todo.pop(), set()) - seen:
            seen.add(user)
            todo.append(user)
    return seen


def _is_test(rel: str) -> bool:
    return rel.startswith("tests/") and Path(rel).name.startswith("test_") and rel.endswith(".py")


def python_tests(changed: Iterable[str], sources: Mapping[str, str]) -> list[str]:
    changed = set(changed)
    tests = {rel for rel in sources if _is_test(rel)}
    picked = {rel for rel in dependants(python_graph(sources), changed & set(sources)) if rel in tests}
    for rel in changed:
        if Path(rel).name == "conftest.py":
            picked.update(t for t in tests if t.startswith(str(Path(rel).parent) + "/"))
        elif rel.startswith("tests/fixtures/"):
            picked.update(tests)
        elif rel.startswith("custom_components/outglow/") and not rel.endswith(".py") and not rel.startswith(BUILT):
            picked.update(t for t in tests if t.startswith("tests/integration/"))
    return sorted(picked)


def _ts_target(rel: str, spec: str, files: set[str]) -> str | None:
    base = str((Path(rel).parent / spec).as_posix())
    parts: list[str] = []
    for part in base.split("/"):
        if part == "..":
            parts.pop()
        elif part != ".":
            parts.append(part)
    stem = "/".join(parts)
    found = (c for c in (stem, f"{stem}.ts", f"{stem}/index.ts") if c in files)
    return next(found, None)


def ts_graph(sources: Mapping[str, str]) -> dict[str, set[str]]:
    files = set(sources)
    graph: dict[str, set[str]] = {}
    for rel, source in sources.items():
        targets = (_ts_target(rel, spec, files) for spec in TS_IMPORT.findall(source))
        graph[rel] = {target for target in targets if target is not None}
    return graph


def e2e_specs(changed: Iterable[str], specs: Iterable[str], sources: Mapping[str, str]) -> list[str]:
    changed = set(changed)
    specs = sorted(specs)
    regular = [s for s in specs if Path(s).name not in ON_REQUEST]
    if any(rel.startswith(EVERY_SPEC) for rel in changed) or any(SRC + name in changed for name in EVERY_SPEC_SRC):
        return sorted(set(regular) | (changed & set(specs)))
    touched = dependants(ts_graph(sources), changed & set(sources))
    picked = changed & set(specs)
    for spec in regular:
        entries = [
            SRC + e for pattern, es in SPEC_ENTRIES.items() if fnmatch.fnmatch(Path(spec).name, pattern) for e in es
        ]
        if not entries:
            if any(rel.startswith(SRC) for rel in changed):
                picked.add(spec)
        elif touched & set(entries):
            picked.add(spec)
    return sorted(picked)


def plan(changed: Iterable[str], python: Mapping[str, str], ts: Mapping[str, str], specs: Iterable[str]) -> Plan:
    changed = sorted(set(changed))
    py = [rel for rel in changed if rel.endswith(".py") and rel.startswith(PYTHON_DIRS)]
    front = [rel for rel in changed if rel.startswith("frontend/") and rel.endswith(".ts")]
    return Plan(
        lint=py,
        python=bool(py),
        contracts=any(rel.startswith(("docs/", "tools/contracts.py", SRC + "api/")) for rel in changed),
        pytest=python_tests(changed, python),
        typescript=bool(front),
        vitest=any(rel.startswith("frontend/") and not rel.startswith(E2E) for rel in changed),
        e2e=e2e_specs(changed, specs, ts),
    )


def _git(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout
    return [line for line in out.splitlines() if line]


def changed_files(base: str) -> list[str]:
    files = {*_git("diff", "--name-only", base), *_git("ls-files", "--others", "--exclude-standard")}
    return sorted(files)


def _read(rels: Iterable[str]) -> dict[str, str]:
    return {rel: (ROOT / rel).read_text() for rel in rels if (ROOT / rel).is_file()}


def _tracked(prefix: str, suffix: str) -> list[str]:
    files = {*_git("ls-files", prefix), *_git("ls-files", "--others", "--exclude-standard", prefix)}
    return sorted(rel for rel in files if rel.endswith(suffix) and not rel.startswith(BUILT))


def commands(p: Plan, base: str, py: str, e2e: bool, workers: int) -> list[list[str]]:
    out: list[list[str]] = []
    if p.lint:
        out.append([py, "-m", "ruff", "format", "--check", *p.lint])
        out.append([py, "-m", "ruff", "check", *p.lint])
    if p.python:
        out.append(["make", "types", f"PY={py}"])
    if p.contracts:
        out.append([py, "tools/contracts.py", "--check"])
    if p.pytest:
        out.append([py, "-m", "pytest", "-q", "tests/test_repo.py", *p.pytest])
    if p.typescript:
        out.append(["npm", "--prefix", "frontend", "run", "typecheck"])
    if p.vitest:
        out.append(["npm", "--prefix", "frontend", "test", "--", "--changed", base])
    if e2e and p.e2e:
        specs = [rel.removeprefix("frontend/") for rel in p.e2e]
        out.append(["npm", "--prefix", "frontend", "run", "e2e", "--", f"--workers={workers}", *specs])
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="quick")
    parser.add_argument("--base", default="main")
    parser.add_argument("--py", default=sys.executable)
    parser.add_argument("--no-e2e", action="store_true")
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    base = _git("merge-base", "HEAD", args.base)[0] if args.base != "HEAD" else "HEAD"
    changed = changed_files(base)
    python = _read(rel for d in PYTHON_DIRS for rel in _tracked(d, ".py"))
    ts = _read(_tracked(SRC, ".ts"))
    specs = _tracked(E2E, ".spec.ts")
    steps = commands(plan(changed, python, ts, specs), base, args.py, not args.no_e2e, args.workers)
    print(f"quick: {len(changed)} changed files since {base[:12]}, {len(steps)} steps")
    failed: list[str] = []
    for step in steps:
        print("+ " + " ".join(step), flush=True)
        if not args.dry_run and subprocess.run(step, cwd=ROOT).returncode != 0:
            failed.append(" ".join(step[:4]))
    print("quick: " + ("failed: " + "; ".join(failed) if failed else "ok"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
