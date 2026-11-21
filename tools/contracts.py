import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS = ROOT / "docs" / "schemas"
TYPES_TS = ROOT / "frontend" / "src" / "api" / "types.ts"
API_MD = ROOT / "docs" / "api.md"
COMMANDS = "commands.json"
IDENT = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")
INDENT = "  "


class ContractError(ValueError):
    pass


@dataclass(frozen=True)
class Named:
    name: str
    file: str
    pointer: str
    schema: dict[str, Any]


def load(schemas: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    files = {p.name: json.loads(p.read_text()) for p in sorted(schemas.glob("*.json")) if p.name != COMMANDS}
    commands = json.loads((schemas / COMMANDS).read_text())
    return files, commands


def named_types(files: dict[str, dict[str, Any]]) -> list[Named]:
    out: list[Named] = []
    seen: dict[str, str] = {}
    for file, schema in files.items():
        entries = []
        if _is_type(schema):
            entries.append((schema["title"], ""))
        entries.extend((name, f"/$defs/{name}") for name in schema.get("$defs", {}))
        for name, pointer in entries:
            if name in seen:
                raise ContractError(f"type {name} defined in {seen[name]} and {file}")
            seen[name] = file
            node = schema if not pointer else schema["$defs"][name]
            out.append(Named(name, file, pointer, node))
    return out


def _is_type(schema: dict[str, Any]) -> bool:
    return any(k in schema for k in ("type", "properties", "oneOf", "anyOf", "enum", "const", "$ref"))


class Namer:
    def __init__(self, files: dict[str, dict[str, Any]], types: list[Named]) -> None:
        self.files = files
        self.by_location = {(t.file, t.pointer): t.name for t in types}

    def ref(self, ref: str, current: str) -> str:
        file, _, pointer = ref.partition("#")
        location = (file or current, pointer)
        if location not in self.by_location:
            raise ContractError(f"unresolved $ref {ref} in {current}")
        return self.by_location[location]


def ts_expr(schema: dict[str, Any], namer: Namer, file: str, depth: int) -> str:
    if "$ref" in schema:
        return namer.ref(schema["$ref"], file)
    if "const" in schema:
        return json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(json.dumps(v) for v in schema["enum"])
    for key in ("oneOf", "anyOf"):
        if key in schema:
            return " | ".join(ts_member(s, namer, file, depth) for s in schema[key])
    kind = schema.get("type")
    if isinstance(kind, list):
        return " | ".join(ts_expr({**schema, "type": k}, namer, file, depth) for k in kind)
    if kind == "object":
        return _ts_object(schema, namer, file, depth)
    if kind == "array":
        return _ts_array(schema, namer, file, depth)
    if kind in ("integer", "number"):
        return "number"
    if kind in ("string", "boolean", "null"):
        return str(kind)
    return "unknown"


def ts_member(schema: dict[str, Any], namer: Namer, file: str, depth: int) -> str:
    expr = ts_expr(schema, namer, file, depth)
    union = any(k in schema for k in ("oneOf", "anyOf")) or len(schema.get("enum", [])) > 1
    return f"({expr})" if union or isinstance(schema.get("type"), list) else expr


def _ts_object(schema: dict[str, Any], namer: Namer, file: str, depth: int) -> str:
    props = schema.get("properties", {})
    extra = schema.get("additionalProperties", True)
    if not props:
        if isinstance(extra, dict):
            return f"Record<string, {ts_expr(extra, namer, file, depth)}>"
        return "Record<string, never>" if extra is False else "Record<string, unknown>"
    required = set(schema.get("required", []))
    pad = INDENT * (depth + 1)
    lines = ["{"]
    for key, prop in props.items():
        name = key if IDENT.match(key) else json.dumps(key)
        optional = "" if key in required else "?"
        lines.append(f"{pad}{name}{optional}: {ts_expr(prop, namer, file, depth + 1)};")
    lines.append(f"{INDENT * depth}}}")
    return "\n".join(lines)


def _ts_array(schema: dict[str, Any], namer: Namer, file: str, depth: int) -> str:
    if "prefixItems" in schema:
        return "[" + ", ".join(ts_expr(s, namer, file, depth) for s in schema["prefixItems"]) + "]"
    return f"{ts_member(schema.get('items', {}), namer, file, depth)}[]"


def render_ts(files: dict[str, dict[str, Any]], commands: dict[str, Any]) -> str:
    types = named_types(files)
    namer = Namer(files, types)
    parts = []
    for t in types:
        parts.append(f"export type {t.name} = {ts_expr(t.schema, namer, t.file, 0)};")
    parts.append(_ts_commands(commands, namer))
    return "\n\n".join(parts) + "\n"


def _command_type(ref: str, namer: Namer) -> str:
    return "null" if ref == "null" else namer.ref(ref, "")


def _ts_commands(commands: dict[str, Any], namer: Namer) -> str:
    lines = ["export interface OutglowCommands {"]
    for name, spec in commands["commands"].items():
        lines.append(f"{INDENT}{json.dumps(name)}: {{")
        lines.append(f"{INDENT * 2}request: {_command_type(spec['request'], namer)};")
        lines.append(f"{INDENT * 2}response: {_command_type(spec['response'], namer)};")
        lines.append(f"{INDENT * 2}event: {_command_type(spec.get('event', 'null'), namer)};")
        lines.append(f"{INDENT * 2}admin: {json.dumps(spec['admin'])};")
        lines.append(f"{INDENT}}};")
    lines.append("}")
    lines.append("")
    lines.append("export type OutglowCommand = keyof OutglowCommands;")
    lines.append("")
    subscriptions = [name for name, spec in commands["commands"].items() if "event" in spec]
    lines.append("export const SUBSCRIPTIONS = " + json.dumps(subscriptions) + " as const;")
    return "\n".join(lines)


def render_md(files: dict[str, dict[str, Any]], commands: dict[str, Any]) -> str:
    types = named_types(files)
    namer = Namer(files, types)
    out = [
        "# Outglow websocket API",
        "",
        "Generated by `tools/contracts.py` from `docs/schemas/*.json`; do not edit by hand.",
        "",
        commands["description"],
        "",
        "## Commands",
        "",
        "| Command | Request | Response | Event | Admin |",
        "|---|---|---|---|---|",
    ]
    for name, spec in commands["commands"].items():
        cells = [_md_link(_command_type(spec[k], namer)) for k in ("request", "response")]
        event = _md_link(_command_type(spec.get("event", "null"), namer))
        out.append(f"| `{name}` | {cells[0]} | {cells[1]} | {event} | {'yes' if spec['admin'] else 'no'} |")
    out += ["", "## Types", ""]
    for t in types:
        out.append(f"### {t.name}")
        out.append("")
        out.append(f"`{t.file}{'#' + t.pointer if t.pointer else ''}`")
        out.append("")
        if "description" in t.schema:
            out.append(t.schema["description"])
            out.append("")
        props = t.schema.get("properties")
        if props:
            required = set(t.schema.get("required", []))
            out.append("| Field | Type | Required | Description |")
            out.append("|---|---|---|---|")
            for key, prop in props.items():
                expr = ts_expr(prop, namer, t.file, 0).replace("\n", " ").replace("|", "\\|")
                expr = re.sub(r"\s+", " ", expr)
                desc = prop.get("description", "").replace("|", "\\|")
                out.append(f"| `{key}` | `{expr}` | {'yes' if key in required else 'no'} | {desc} |")
        else:
            expr = re.sub(r"\s+", " ", ts_expr(t.schema, namer, t.file, 0))
            out.append(f"`{expr}`")
        out.append("")
    return "\n".join(out)


def _md_link(name: str) -> str:
    return "—" if name == "null" else f"[{name}](#{name.lower()})"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate types.ts and api.md from the JSON schemas")
    parser.add_argument("--check", action="store_true", help="fail if the generated files are out of date")
    args = parser.parse_args(argv)
    files, commands = load(SCHEMAS)
    outputs = {TYPES_TS: render_ts(files, commands), API_MD: render_md(files, commands)}
    stale = [path for path, text in outputs.items() if not path.exists() or path.read_text() != text]
    if args.check:
        for path in stale:
            print(f"out of date: {path.relative_to(ROOT)} (run tools/contracts.py)", file=sys.stderr)
        return 1 if stale else 0
    for path in stale:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(outputs[path])
        print(f"wrote {path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
