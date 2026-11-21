import argparse
import ast
import json
import re
import sys
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.types import GlobalSettings, Retention, RoomSettings
from tools.import_prototype import load_yaml

ROOT = Path(__file__).resolve().parent.parent
INTEGRATION = ROOT / "custom_components" / "outglow"
README = ROOT / "README.md"
IMAGES = ROOT / "docs" / "images"
HELP_TS = ROOT / "frontend" / "src" / "help.ts"
SCHEMAS = ROOT / "docs" / "schemas"
PLATFORMS = ("binary_sensor", "sensor", "switch", "select", "number", "button")
ROOM = "<room>"
MARKER = re.compile(r"<!-- generated:(?P<name>[a-z_]+) -->\n(?P<body>.*?)<!-- /generated:(?P=name) -->", re.S)
IMAGE_REF = re.compile(r"docs/images/[A-Za-z0-9_.\-/]+")
HELP_ANCHOR = re.compile(r'"#([a-z0-9\-]+)"')
CARD_INTERFACE = re.compile(r"export interface CardConfig \{(?P<body>.*?)\n\}", re.S)
CARD_FIELD = re.compile(r"^\s+(?P<name>\w+)(?P<optional>\??): (?P<type>[^;]+);", re.M)
CARD_DEFAULT = re.compile(r"(?P<name>\w+): config\.(?P=name) \?\? (?P<value>[^,\n]+),")

ENTITY_NOTES = {
    "occupancy": "On while the room has motion or is inside its hold time; unavailable when no pair covers the room.",
    "home_motion": "Motion in any room; turns off 10 s after the last motion.",
    "motion_room": "The room with the freshest, most certain motion, or `none`.",
    "status": "Whether the model is still learning, ready, degraded (bulbs missing) or paused.",
    "false_alarms_24h": "False alarms in the last 24 hours (from feedback and empty-home periods).",
    "sensing": "Pauses the whole pipeline; room entities become unavailable.",
    "learning": "Background learning; proposals still wait for Apply in the panel.",
    "false_alarm_budget": "False alarms per day the night calibration aims for.",
    "reaction": "How quickly a room turns on: about 1 s, 1.5-2 s or 3 s.",
    "hold_time": "How long a room stays occupied after the last motion.",
    "delete_motion_history": "Deletes the stored motion history (SQLite) at once.",
}

SETTING_NOTES = {
    "rooms.<room>.false_alarm_budget": "False alarms per day the night calibration aims for",
    "rooms.<room>.reaction": "How many ticks of motion turn a room on: about 1 s, 1.5-2 s or 3 s",
    "rooms.<room>.hold_time_s": "Seconds a room stays occupied after the last motion",
    "rooms.<room>.auto_light": "Reserved: switching lights is not done by this version",
    "rooms.<room>.light_off_delay_s": "Reserved for `auto_light`",
    "global.sensing": "Whole pipeline on; off makes the room entities unavailable",
    "global.learning": "Learn in the background; proposals wait for Apply",
    "global.mode": "`rules` (fixed rule per room) or `bayes` (learnt room model)",
    "global.tick_s": "Seconds between two engine ticks",
    "global.use_persons": "Use `person` entities to detect an empty home",
    "global.persons": "Which `person` entities count for the empty home",
    "global.others_may_be_home": "Pets or guests may be home while every person is away",
    "global.quiet_background": "Also learn the background from quiet periods while people are home",
    "global.firmware_channel": "Use the bulbs' own motion bits as an extra observation",
    "global.retention.raw_h": "Hours of raw bulb reports kept (replay in History)",
    "global.retention.empty_raw_d": "Days of raw reports from empty-home periods kept (calibration)",
    "global.retention.ticks_d": "Days of room timelines kept",
    "global.retention.events_d": "Days of events kept (motion, feedback, writes to bulbs)",
}

CARD_NOTES = {
    "type": "`custom:outglow-map-card`",
    "title": 'Card title; `""` hides the header. Default: Outglow',
    "rooms": "Room ids to show; default: every room of the plan",
    "show_lines": "Draw the pairs of bulbs that see motion",
    "show_trail": "Draw the trail between rooms",
    "show_heat": "Draw the heat layer (an illustration, not a position)",
    "show_rooms": "Room chips with state under the plan",
    "height": "Maximum height of the plan in pixels (at least 80); default 420",
}


@dataclass(frozen=True)
class Entity:
    domain: str
    key: str
    per_room: bool
    kind: str
    category: str
    states: tuple[str, ...]
    attributes: tuple[str, ...]

    @property
    def entity_id(self) -> str:
        return f"{self.domain}.outglow_room_{ROOM}_{self.key}" if self.per_room else f"{self.domain}.outglow_{self.key}"


class DocsError(ValueError):
    pass


def _literal(node: ast.AST | None) -> Any:
    try:
        return ast.literal_eval(node) if node is not None else None
    except ValueError:
        return None


def _super_args(cls: ast.ClassDef) -> list[ast.expr]:
    for node in ast.walk(cls):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "__init__"
            and isinstance(node.func.value, ast.Call)
            and isinstance(node.func.value.func, ast.Name)
            and node.func.value.func.id == "super"
        ):
            return list(node.args)
    raise DocsError(f"{cls.name} does not call super().__init__")


def _class_attr(cls: ast.ClassDef, name: str) -> ast.expr | None:
    for node in cls.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return node.value
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.target.id == name:
            return node.value
    return None


def _enum_member(node: ast.expr | None) -> str:
    return node.attr.lower() if isinstance(node, ast.Attribute) else ""


def _attributes(cls: ast.ClassDef) -> tuple[str, ...]:
    refresh = next((n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == "_refresh"), None)
    if refresh is None:
        return ()
    keys: list[str] = []
    for node in ast.walk(refresh):
        if isinstance(node, ast.Dict):
            keys.extend(k.value for k in node.keys if isinstance(k, ast.Constant) and isinstance(k.value, str))
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.ctx, ast.Store)
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            keys.append(node.slice.value)
    return tuple(dict.fromkeys(keys))


def _number_states(cls: ast.ClassDef) -> tuple[str, ...]:
    low, high = (
        _literal(_class_attr(cls, "_attr_native_min_value")),
        _literal(_class_attr(cls, "_attr_native_max_value")),
    )
    unit = _class_attr(cls, "_attr_native_unit_of_measurement")
    if low is None or high is None:
        return ()
    suffix = {"seconds": " s", "minutes": " min"}.get(_enum_member(unit), "")
    return (f"{low}-{high}{suffix}",)


def _setup_calls(tree: ast.Module, classes: Mapping[str, ast.ClassDef]) -> Iterable[tuple[ast.Call, bool]]:
    setup = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_setup_entry")
    rooms: set[int] = set()
    for node in ast.walk(setup):
        if isinstance(node, ast.Lambda):
            rooms.update(id(n) for n in ast.walk(node.body))
    for node in ast.walk(setup):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in classes:
            yield node, id(node) in rooms


def platform_entities(path: Path, strings: Mapping[str, Any]) -> list[Entity]:
    tree = ast.parse(path.read_text())
    classes = {n.name: n for n in tree.body if isinstance(n, ast.ClassDef)}
    out: list[Entity] = []
    for call, per_room in _setup_calls(tree, classes):
        cls = classes[call.func.id] if isinstance(call.func, ast.Name) else None
        if cls is None:
            continue
        args = _super_args(cls)
        domain = _literal(args[-1])
        key = _literal(args[-2])
        if key is None:
            key = next((_literal(a) for a in call.args if isinstance(_literal(a), str)), None)
        if not isinstance(domain, str) or not isinstance(key, str):
            raise DocsError(f"{path.name}: cannot read the key of {cls.name}")
        translated = strings.get("entity", {}).get(domain, {}).get(key, {})
        states = tuple(translated.get("state", {}))
        if domain == "number":
            states = _number_states(cls)
        if domain == "select" and not states:
            states = tuple(_select_options(tree, cls))
        out.append(
            Entity(
                domain=domain,
                key=key,
                per_room=per_room,
                kind=_enum_member(_class_attr(cls, "_attr_device_class")),
                category=_enum_member(_class_attr(cls, "_attr_entity_category")),
                states=states,
                attributes=_attributes(cls),
            )
        )
    return out


def _select_options(tree: ast.Module, cls: ast.ClassDef) -> list[str]:
    for node in ast.walk(cls):
        if (
            isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Attribute) and t.attr == "_attr_options" for t in node.targets)
            and isinstance(node.value, ast.Call)
            and node.value.args
            and isinstance(node.value.args[0], ast.Name)
        ):
            name = node.value.args[0].id
            for top in tree.body:
                if isinstance(top, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in top.targets):
                    value = _literal(top.value)
                    return [str(v) for v in value]
    return []


def entities(root: Path = INTEGRATION) -> list[Entity]:
    strings = json.loads((root / "strings.json").read_text())
    found = [e for platform in PLATFORMS for e in platform_entities(root / f"{platform}.py", strings)]
    return sorted(found, key=lambda e: (e.per_room, PLATFORMS.index(e.domain), e.key))


def _name(strings: Mapping[str, Any], e: Entity) -> str:
    return str(strings.get("entity", {}).get(e.domain, {}).get(e.key, {}).get("name", e.key))


def render_entities(found: list[Entity], strings: Mapping[str, Any]) -> str:
    missing = sorted({e.key for e in found} - set(ENTITY_NOTES))
    stale = sorted(set(ENTITY_NOTES) - {e.key for e in found})
    if missing or stale:
        raise DocsError(f"ENTITY_NOTES in tools/docs.py: describe {missing}, drop {stale}")
    lines = [
        f"Room entities use the room id from the plan in place of `{ROOM}`.",
        "",
        "| Entity | Name | Scope | Type | States | Attributes | What it means |",
        "|---|---|---|---|---|---|---|",
    ]
    for e in found:
        kind = ", ".join(x for x in (e.kind, e.category) if x) or "—"
        states = ", ".join(f"`{s}`" for s in e.states) or "—"
        attributes = ", ".join(f"`{a}`" for a in e.attributes) or "—"
        scope = "per room" if e.per_room else "home"
        cells = [f"`{e.entity_id}`", _name(strings, e), scope, kind, states, attributes, ENTITY_NOTES[e.key]]
        lines.append(f"| {' | '.join(cells)} |")
    return "\n".join(lines) + "\n"


def _field_text(field: Mapping[str, Any]) -> str:
    selector = field.get("selector") or {}
    kind = next(iter(selector), "") if isinstance(selector, dict) else ""
    options = selector.get(kind) or {} if kind else {}
    parts = []
    if kind == "select" and isinstance(options, dict):
        parts.append(" / ".join(f"`{o}`" for o in options.get("options", [])))
    elif kind == "number" and isinstance(options, dict):
        unit = options.get("unit_of_measurement", "")
        parts.append(f"{options.get('min')}-{options.get('max')} {unit}".strip())
    elif kind:
        parts.append(kind)
    if field.get("required"):
        parts.append("required")
    if "default" in field:
        parts.append(f"default `{json.dumps(field['default'])}`")
    return ", ".join(parts)


def render_services(services: Mapping[str, Any], strings: Mapping[str, Any]) -> str:
    texts = strings.get("services", {})
    lines = ["| Action | What it does | Fields |", "|---|---|---|"]
    for name, spec in services.items():
        text = texts.get(name, {})
        fields_spec = (spec or {}).get("fields", {}) if isinstance(spec, dict) else {}
        described = text.get("fields", {})
        cells = [
            f"`{field}` ({_field_text(fields_spec[field])}): {described.get(field, {}).get('description', '')}".rstrip(
                ": "
            )
            for field in fields_spec
        ]
        lines.append(f"| `outglow.{name}` | {text.get('description', '')} | {'<br>'.join(cells) or '—'} |")
    return "\n".join(lines) + "\n"


def _schema_values(node: Mapping[str, Any], defs: Mapping[str, Any]) -> str:
    if "$ref" in node:
        ref = str(node["$ref"])
        if ref.startswith("#/$defs/"):
            return _schema_values(defs[ref.removeprefix("#/$defs/")], defs)
        return "room id" if ref.endswith("RoomId") else ref
    if "enum" in node:
        return " / ".join(f"`{json.dumps(v)}`" for v in node["enum"])
    kind = node.get("type")
    if kind == "integer" and "minimum" in node and "maximum" in node:
        return f"integer {node['minimum']}-{node['maximum']}"
    if kind == "integer" and "minimum" in node:
        return f"integer ≥ {node['minimum']}"
    if kind == "array":
        return "list of " + _schema_values(node.get("items", {}), defs).replace("string", "entity ids")
    return str(kind or "object")


def _default(value: object) -> str:
    if isinstance(value, tuple):
        value = list(value)
    return f"`{json.dumps(value)}`"


def setting_rows(schema: Mapping[str, Any]) -> list[tuple[str, str, str, str]]:
    defs = schema["$defs"]
    sources: list[tuple[str, str, Any]] = [
        ("rooms.<room>", "RoomSettings", RoomSettings()),
        ("global", "GlobalSettings", GlobalSettings()),
        ("global.retention", "Retention", Retention()),
    ]
    rows: list[tuple[str, str, str, str]] = []
    for prefix, name, instance in sources:
        props = defs[name]["properties"]
        attrs = {f.name.rstrip("_"): f.name for f in fields(instance)}
        for key, node in props.items():
            if node.get("$ref") == "#/$defs/Retention":
                continue
            path = f"{prefix}.{key}"
            if key not in attrs:
                raise DocsError(f"{path} is in settings.json but not in engine/types.py")
            default = getattr(instance, attrs[key])
            rows.append((path, _schema_values(node, defs), _default(default), SETTING_NOTES.get(path, "")))
    return rows


def render_settings(schema: Mapping[str, Any]) -> str:
    rows = setting_rows(schema)
    paths = {r[0] for r in rows}
    missing = sorted(paths - set(SETTING_NOTES))
    stale = sorted(set(SETTING_NOTES) - paths)
    if missing or stale:
        raise DocsError(f"SETTING_NOTES in tools/docs.py: describe {missing}, drop {stale}")
    lines = ["| Setting | Values | Default | Meaning |", "|---|---|---|---|"]
    lines.extend(f"| `{path}` | {values} | {default} | {note} |" for path, values, default, note in rows)
    return "\n".join(lines) + "\n"


def render_commands(commands: Mapping[str, Any]) -> str:
    names = list(commands["commands"])
    admin = sum(1 for spec in commands["commands"].values() if spec.get("admin"))
    who = "all for administrators only" if admin == len(names) else f"{admin} of them for administrators only"
    groups: dict[str, list[str]] = {}
    for name in names:
        group = name.removeprefix("outglow/").split("/")[0]
        groups.setdefault(group, []).append(name)
    lines = [
        f"{len(names)} commands, {who}. Requests, responses and events: [docs/api.md](docs/api.md).",
        "",
        "| Area | Commands |",
        "|---|---|",
    ]
    lines.extend(f"| {group} | {', '.join(f'`{n}`' for n in items)} |" for group, items in groups.items())
    return "\n".join(lines) + "\n"


def render_card(source: str) -> str:
    found = CARD_INTERFACE.search(source)
    if found is None:
        raise DocsError("CardConfig not found in frontend/src/outglow-cards.ts")
    options = [(m["name"], m["optional"] == "", m["type"].strip()) for m in CARD_FIELD.finditer(found["body"])]
    defaults = {m["name"]: m["value"].strip() for m in CARD_DEFAULT.finditer(source)}
    names = {name for name, _, _ in options}
    missing = sorted(names - set(CARD_NOTES))
    stale = sorted(set(CARD_NOTES) - names)
    if missing or stale:
        raise DocsError(f"CARD_NOTES in tools/docs.py: describe {missing}, drop {stale}")
    lines = ["| Option | Type | Default | Meaning |", "|---|---|---|---|"]
    for name, required, kind in options:
        default = "required" if required else f"`{defaults[name]}`" if name in defaults else "—"
        lines.append(f"| `{name}` | `{kind}` | {default} | {CARD_NOTES[name]} |")
    return "\n".join(lines) + "\n"


def sections(root: Path = ROOT) -> dict[str, Callable[[], str]]:
    integration = root / "custom_components" / "outglow"
    strings = json.loads((integration / "strings.json").read_text())
    schemas = root / "docs" / "schemas"

    def services() -> str:
        loaded = load_yaml((integration / "services.yaml").read_text())
        if not isinstance(loaded, dict):
            raise DocsError("services.yaml is not a mapping")
        return render_services(loaded, strings)

    return {
        "entities": lambda: render_entities(entities(integration), strings),
        "services": services,
        "settings": lambda: render_settings(json.loads((schemas / "settings.json").read_text())),
        "commands": lambda: render_commands(json.loads((schemas / "commands.json").read_text())),
        "card": lambda: render_card((root / "frontend" / "src" / "outglow-cards.ts").read_text()),
    }


def render(text: str, generated: Mapping[str, Callable[[], str]]) -> str:
    seen = {m.group("name") for m in MARKER.finditer(text)}
    missing = sorted(set(generated) - seen)
    unknown = sorted(seen - set(generated))
    if missing or unknown:
        raise DocsError(f"README markers: missing {missing}, unknown {unknown}")
    return MARKER.sub(
        lambda m: (
            f"<!-- generated:{m.group('name')} -->\n{generated[m.group('name')]()}<!-- /generated:{m.group('name')} -->"
        ),
        text,
    )


def _slug(heading: str) -> str:
    text = re.sub(r"[^\w\- ]", "", heading.strip().lower())
    return text.replace(" ", "-")


def anchors(text: str) -> set[str]:
    return {_slug(m.group(1)) for m in re.finditer(r"^#{1,6} (.+)$", text, re.M)}


def problems(text: str, root: Path = ROOT) -> list[str]:
    out: list[str] = []
    images = root / "docs" / "images"
    referenced = set(IMAGE_REF.findall(text))
    out.extend(f"README points to a missing image: {ref}" for ref in sorted(referenced) if not (root / ref).is_file())
    present = {f"docs/images/{p.name}" for p in images.iterdir() if p.is_file()} if images.is_dir() else set()
    out.extend(f"image not used by the README: {ref}" for ref in sorted(present - referenced))
    help_ts = root / "frontend" / "src" / "help.ts"
    if help_ts.is_file():
        known = anchors(text)
        wanted = HELP_ANCHOR.findall(help_ts.read_text())
        out.extend(f"panel help points to a missing README section: #{a}" for a in wanted if a not in known)
        if not wanted:
            out.append("frontend/src/help.ts links to no README section")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate the README sections from the integration's code")
    parser.add_argument("--check", action="store_true", help="fail if the README is out of date")
    args = parser.parse_args(argv)
    current = README.read_text()
    try:
        fresh = render(current, sections())
    except DocsError as error:
        print(f"docs: {error}", file=sys.stderr)
        return 1
    issues = problems(fresh)
    for issue in issues:
        print(f"docs: {issue}", file=sys.stderr)
    if args.check:
        if fresh != current:
            print("docs: README.md is out of date (run tools/docs.py)", file=sys.stderr)
            return 1
        return 1 if issues else 0
    if fresh != current:
        README.write_text(fresh)
        print("wrote README.md")
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
