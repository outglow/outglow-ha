import ast
import fnmatch
import io
import os
import re
import subprocess
import sys
import tokenize
from functools import cache
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PYTHON_DIRS = ("custom_components", "tools", "tests")
SKIP_DIRS = {".git", ".venv", "node_modules", "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache", "dist"}
BUILT = ROOT / "custom_components" / "outglow" / "frontend"
PRAGMA = re.compile(r"^#\s*(type: ignore\[[a-z-, ]+\]|noqa: [A-Z0-9, ]+|pragma: no cover)$")
VENDOR_ADDRESS = re.compile(rb"(?i)a4c138[0-9a-f]{10}|a4[:-]c1[:-]38(?:[:-][0-9a-f]{2}){3}")
MAX_JSONL = 100 * 1024
PRIVATE_IP = re.compile(rb"(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?![\d.])")
EXAMPLE_ADDRESSES = {".".join(("192", "168", "1", "50")).encode()}
LOCAL_PATH = re.compile(
    re.escape(b"/" + b"Users/")
    + rb"|"
    + re.escape(b"/private" + b"/tmp")
    + rb"|"
    + re.escape(b"/" + b"home/")
    + rb"[a-z]"
)
HOME_DIR = re.compile(rb"(?<![\w$])~" + rb"/")
PRIVATE_WORDS = Path(os.environ.get("OUTGLOW_PRIVATE_WORDS", Path.home() / ".config" / "outglow" / "private-words.txt"))


@cache
def _files() -> list[Path]:
    out: list[Path] = []
    for folder, dirs, names in os.walk(ROOT):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and Path(folder, d) != BUILT)
        out.extend(Path(folder, name) for name in sorted(names))
    return out


@cache
def _published() -> list[Path]:
    listed = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=ROOT,
        capture_output=True,
        check=False,
    )
    if listed.returncode != 0:
        return _files()
    names = sorted({name for name in listed.stdout.decode().split("\0") if name})
    return [ROOT / name for name in names if (ROOT / name).is_file()]


@cache
def _private_list() -> tuple[tuple[str, ...], tuple[str, ...]]:
    if not PRIVATE_WORDS.is_file():
        return (), ()
    lines = [line.strip() for line in PRIVATE_WORDS.read_text().splitlines()]
    lines = [line for line in lines if line and not line.startswith("#")]
    exempt = tuple(line[1:].strip() for line in lines if line.startswith("!"))
    words = tuple(line for line in lines if not line.startswith("!"))
    return words, exempt


def _checked() -> list[tuple[str, bytes]]:
    _, exempt = _private_list()
    out = []
    for path in _published():
        name = path.relative_to(ROOT).as_posix()
        if not any(fnmatch.fnmatch(name, pattern) for pattern in exempt):
            out.append((name, path.read_bytes()))
    return out


def _is_text(data: bytes) -> bool:
    try:
        data.decode()
    except UnicodeDecodeError:
        return False
    return True


def _python_files() -> list[Path]:
    return [p for p in _files() if p.suffix == ".py" and p.relative_to(ROOT).parts[0] in PYTHON_DIRS]


@pytest.mark.parametrize("path", _python_files(), ids=lambda p: str(p.relative_to(ROOT)))
def test_python_has_no_comments(path: Path) -> None:
    tokens = tokenize.generate_tokens(io.StringIO(path.read_text()).readline)
    comments = [(t.start[0], t.string) for t in tokens if t.type == tokenize.COMMENT and not PRAGMA.match(t.string)]
    assert comments == []


@pytest.mark.parametrize("path", _python_files(), ids=lambda p: str(p.relative_to(ROOT)))
def test_python_has_no_docstrings(path: Path) -> None:
    tree = ast.parse(path.read_text())
    nodes = [tree, *(n for n in ast.walk(tree) if isinstance(n, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef))]
    found = [getattr(n, "name", "<module>") for n in nodes if ast.get_docstring(n, clean=False) is not None]
    assert found == []


def test_no_vendor_addresses_in_repo() -> None:
    hits = [str(p.relative_to(ROOT)) for p in _files() if VENDOR_ADDRESS.search(p.read_bytes())]
    assert hits == []


def test_vendor_pattern_catches_both_forms() -> None:
    assert VENDOR_ADDRESS.search(("0x" + "A4C138" + "0123456789").encode())
    assert VENDOR_ADDRESS.search(("a4:c1:38" + ":01:02:03").encode())
    assert not VENDOR_ADDRESS.search(b"0x00000000000000a4")


def test_no_private_network_addresses() -> None:
    hits = [
        f"{name}: {m.group().decode()}"
        for name, data in _checked()
        for m in PRIVATE_IP.finditer(data)
        if m.group() not in EXAMPLE_ADDRESSES
    ]
    assert hits == []


def test_no_local_paths() -> None:
    hits = [f"{name}: {m.group().decode()}" for name, data in _checked() for m in LOCAL_PATH.finditer(data)]
    hits += [f"{name}: home directory" for name, data in _checked() if _is_text(data) and HOME_DIR.search(data)]
    assert hits == []


def test_no_words_from_the_private_list() -> None:
    words, _ = _private_list()
    if not words:
        pytest.skip(f"no private word list at {PRIVATE_WORDS}")
    pattern = re.compile(r"(?<!\w)(?:" + "|".join(re.escape(w) for w in words) + r")(?!\w)", re.IGNORECASE)
    hits = sorted(
        {f"{name}: {m.group()}" for name, data in _checked() for m in pattern.finditer(data.decode(errors="replace"))}
    )
    assert hits == []


def test_private_patterns_catch_what_they_should() -> None:
    def dotted(*parts: int) -> bytes:
        return ".".join(map(str, parts)).encode()

    assert PRIVATE_IP.search(b"host " + dotted(192, 168, 1, 20) + b":1883")
    assert PRIVATE_IP.search(dotted(10, 0, 0, 1))
    assert PRIVATE_IP.search(dotted(172, 20, 3, 4))
    assert not PRIVATE_IP.search(dotted(192, 0, 2, 10) + b" " + dotted(172, 32, 0, 1) + b" " + dotted(1, 10, 0, 12, 3))
    assert LOCAL_PATH.search(("/" + "Users/someone").encode())
    assert LOCAL_PATH.search(("/private" + "/tmp/x").encode())
    assert not LOCAL_PATH.search(b"/config/outglow")
    assert HOME_DIR.search(("~" + "/recordings").encode())
    assert not HOME_DIR.search(b"a~b")


def test_no_large_recordings_in_repo() -> None:
    big = [str(p.relative_to(ROOT)) for p in _files() if p.suffix == ".jsonl" and p.stat().st_size > MAX_JSONL]
    assert big == []


def test_no_path_entry_shadows_the_standard_library() -> None:
    shadowing = [entry for entry in sys.path if (Path(entry or ".") / "select.py").is_file()]
    assert shadowing == []


@pytest.mark.parametrize("tool", sorted((ROOT / "tools").glob("*.py")), ids=lambda p: p.name)
def test_tools_do_not_put_the_integration_on_the_path(tool: Path) -> None:
    script = f"import runpy, sys; runpy.run_path({str(tool)!r}, run_name='tool'); print(sys.path)"
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, cwd=ROOT, check=True)
    paths = ast.literal_eval(result.stdout.strip().splitlines()[-1])
    assert [p for p in paths if (Path(p or ".") / "select.py").is_file()] == []
    assert "select" not in result.stderr
