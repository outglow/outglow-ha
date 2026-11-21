import argparse
import ast
import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import importer, to_json
from engine.rules import RoomRule, RuleConfig
from engine.types import Plan

Node = object
NUMBER = re.compile(r"^-?\d+(\.\d+)?([eE][-+]?\d+)?$")


class YamlError(ValueError):
    pass


def _scalar(text: str) -> Node:
    text = text.strip()
    if text.startswith("[") and text.endswith("]"):
        return _flow(text)
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return text[1:-1]
    if NUMBER.match(text):
        return float(text) if any(c in text for c in ".eE") else int(text)
    return {"true": True, "false": False, "null": None, "~": None, "": None}.get(text, text)


def _flow(text: str) -> list[Node]:
    inner = text[1:-1].strip()
    items: list[Node] = []
    depth, start = 0, 0
    for i, c in enumerate(inner):
        depth += (c == "[") - (c == "]")
        if c == "," and depth == 0:
            items.append(_scalar(inner[start:i]))
            start = i + 1
    if inner[start:].strip():
        items.append(_scalar(inner[start:]))
    return items


def _strip(line: str) -> str:
    quote = None
    for i, c in enumerate(line):
        if c in "'\"":
            quote = None if quote == c else quote or c
        elif c == "#" and quote is None and (i == 0 or line[i - 1] in " \t"):
            return line[:i].rstrip()
    return line.rstrip()


def load_yaml(text: str) -> Node:
    lines = [(len(s) - len(s.lstrip(" ")), s.strip()) for s in (_strip(raw) for raw in text.splitlines()) if s.strip()]
    value, end = _block(lines, 0, lines[0][0] if lines else 0)
    if end != len(lines):
        raise YamlError(f"unexpected indentation at line {end + 1}")
    return value


def _block(lines: list[tuple[int, str]], i: int, indent: int) -> tuple[Node, int]:
    if i >= len(lines):
        return None, i
    if lines[i][1].startswith("- ") or lines[i][1] == "-":
        return _sequence(lines, i, indent)
    return _mapping(lines, i, indent)


def _mapping(lines: list[tuple[int, str]], i: int, indent: int) -> tuple[dict[str, Node], int]:
    out: dict[str, Node] = {}
    while i < len(lines) and lines[i][0] == indent and not lines[i][1].startswith("- "):
        key, sep, rest = lines[i][1].partition(":")
        if not sep:
            raise YamlError(f"expected key at line {i + 1}")
        key = str(_scalar(key))
        i += 1
        if rest.strip():
            out[key] = _scalar(rest)
        elif i < len(lines) and (lines[i][0] > indent or (lines[i][0] == indent and lines[i][1].startswith("- "))):
            out[key], i = _block(lines, i, lines[i][0])
        else:
            out[key] = None
    return out, i


def _sequence(lines: list[tuple[int, str]], i: int, indent: int) -> tuple[list[Node], int]:
    out: list[Node] = []
    while i < len(lines) and lines[i][0] == indent and (lines[i][1].startswith("- ") or lines[i][1] == "-"):
        rest = lines[i][1][2:].strip()
        inner = indent + 2
        if not rest:
            value, i = _block(lines, i + 1, lines[i + 1][0]) if i + 1 < len(lines) else (None, i + 1)
            out.append(value)
            continue
        if ":" in rest and not rest.startswith("[") and rest[0] not in "'\"":
            sub = [(inner, rest)]
            j = i + 1
            while j < len(lines) and lines[j][0] >= inner:
                sub.append(lines[j])
                j += 1
            value, _ = _mapping(sub, 0, inner)
            out.append(value)
            i = j
        else:
            out.append(_scalar(rest))
            i += 1
    return out, i


def zones_config(source: str, plan: Plan) -> tuple[tuple[str, ...], RuleConfig]:
    tree = ast.parse(source)
    values: dict[str, object] = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                values[node.targets[0].id] = ast.literal_eval(node.value)
            except ValueError:
                continue
    raw_skip = values.get("SKIP")
    skip = tuple(str(s) for s in raw_skip) if isinstance(raw_skip, list | tuple) else ()
    by_name = {_slug(r.name): r.id for r in plan.rooms} | {_slug(r.id): r.id for r in plan.rooms}
    rules: dict[str, RoomRule] = {}
    raw = values.get("ZONE_RULES")
    for key, spec in raw.items() if isinstance(raw, Mapping) else []:
        room = by_name.get(_slug(str(key)))
        if room is None or not isinstance(spec, Mapping):
            continue
        names = [str(a) for a in spec.get("areas", [])]
        weak = frozenset(str(w).lower() for w in spec.get("weak", []))
        areas = frozenset(by_name[_slug(a)] for a in names if _slug(a) in by_name)
        rules[room] = RoomRule(kind="pairs", areas=areas, weak=weak, both_directions=False)
    return skip, RuleConfig(rooms=rules, default=RoomRule(kind="receiver"))


def _slug(text: str) -> str:
    table = str.maketrans("łŁąćęńóśźżĄĆĘŃÓŚŹŻ", "lLacenoszzACENOSZZ")
    return re.sub(r"[^a-z0-9]+", "_", text.translate(table).lower()).strip("_")


def load(path: Path, fmt: str | None = None) -> importer.Imported:
    text = path.read_text()
    kind = fmt or ("outglow_json" if path.suffix == ".json" else "mieszkanie_yaml")
    data = json.loads(text) if kind == "outglow_json" else load_yaml(text)
    if not isinstance(data, dict):
        raise YamlError("top level must be a mapping")
    return importer.from_layout(data) if kind == "outglow_json" else importer.from_mieszkanie(data)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Import a prototype plan (mieszkanie.yaml or layout JSON) to a Plan")
    parser.add_argument("input", type=Path)
    parser.add_argument("--format", choices=["mieszkanie_yaml", "outglow_json"])
    parser.add_argument("--zones", type=Path, help="outglow_zones.py: SKIP becomes excluded_directions")
    args = parser.parse_args(argv)
    imported = load(args.input, args.format)
    plan = imported.plan
    if args.zones:
        skip, _ = zones_config(args.zones.read_text(), plan)
        plan = Plan(
            **{**{f: getattr(plan, f) for f in plan.__slots__}, "excluded_directions": importer.skip_directions(skip)}
        )
    out = {"plan": to_json(plan), "warnings": list(imported.warnings), "names": imported.names}
    sys.stdout.write(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
