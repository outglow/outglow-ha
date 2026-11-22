import base64
import binascii
import cmath
import hashlib
import json
import math
import re
import time
import zlib
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any, TypeGuard

import yaml  # type: ignore[import-untyped]

from . import valetudo
from .engine import CodecError, from_json, to_json
from .engine.defaults import K_MAX
from .engine.topology import HARD_WALLS, outlines_overlap, room_containing
from .engine.types import Background, Plan, PlanBulb, Point, Room
from .errors import OutglowError
from .store import PLAN_KEY, migrate_plan

COLOURS = ("#4e9af1", "#f28b30", "#42b883", "#c678dd", "#e5c07b", "#e06c75", "#56b6c2", "#98c379")
IEEE = re.compile(r"^0x[0-9a-f]{16}$")
BACKGROUND_FILE = re.compile(r"plan(-[0-9a-f]{16})?\.(png|jpg|webp|svg)")
TOP_KEYS = {"rooms", "adjacent", "bulbs", "skip", "excluded_directions"}
ROOM_KEYS = {"name", "outline", "area", "area_id", "entrance", "colour", "color"}
BULB_KEYS = {"id", "z2m", "ieee", "room", "at", "x", "y", "height"}
HEIGHTS = ("ceiling", "pendant", "lamp")
MAX_TEXT = 16 * 1024 * 1024
MAX_PLAN_TEXT = 512 * 1024
MAX_ROOMS = 40
MAX_VERTICES = 2_000
MAX_WALLS = 2_000
MAX_BULBS = 100
KEPT_ROOMS = 250
KEPT_VERTICES = 50_000
KEPT_WALLS = 50_000
KEPT_BULBS = 500
ENGINE_BUDGET_US = 2_000_000
STATE_US = 0.16
PAIR_US = 167.0
PAIR_STATE_US = 0.68
PAIR_CORNER_US = 1.31
PAIR_ROOM_US = 5.7
PAIR_WALL_US = 0.027
PAIR_HARD_WALL_US = 0.39
CORNER_PAIR_US = 0.2
CHECK_BUDGET_S = 2.0
BACKGROUND_OPACITY = 0.6
MIN_FIT_ROOMS = 3
MIN_MIRROR_ROOMS = 3
MIN_SPREAD_M = 0.5
MIRROR_GAIN = 2.0


@dataclass(frozen=True, slots=True)
class Imported:
    plan: Plan
    warnings: list[dict[str, Any]]
    source: str
    background: bytes | None = None
    kept: dict[str, Any] | None = None


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", value.strip().lower()).strip("_") or "room"


def _point(value: object) -> Point | None:
    if not isinstance(value, list | tuple) or len(value) != 2:
        return None
    if not all(isinstance(v, int | float) and not isinstance(v, bool) for v in value):
        return None
    try:
        x, y = float(value[0]), float(value[1])
    except OverflowError:
        return None
    return (x, y) if math.isfinite(x) and math.isfinite(y) else None


def room_of(point: Point, rooms: tuple[Room, ...]) -> str | None:
    return room_containing(rooms, point)


Box = tuple[float, float, float, float]


def _box(outline: tuple[Point, ...]) -> Box:
    xs, ys = [p[0] for p in outline], [p[1] for p in outline]
    return min(xs), min(ys), max(xs), max(ys)


def _holds(box: Box, point: Point) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


class _Clock:
    def __init__(self, seconds: float | None = None) -> None:
        self.deadline = time.thread_time() + (CHECK_BUDGET_S if seconds is None else seconds)

    def tick(self) -> None:
        if time.thread_time() > self.deadline:
            raise OutglowError("invalid_format", "The plan is too complex to check in time")


class _Rooms:
    def __init__(self, rooms: tuple[Room, ...], clock: _Clock) -> None:
        self.rooms = tuple(room for room in rooms if len(room.outline) >= 3)
        self.boxes = tuple(_box(room.outline) for room in self.rooms)
        self.clock = clock

    def at(self, point: Point) -> str | None:
        self.clock.tick()
        return room_of(
            point, tuple(room for room, box in zip(self.rooms, self.boxes, strict=True) if _holds(box, point))
        )


@dataclass(frozen=True, slots=True)
class Cost:
    rooms: int
    corners: int
    bulbs: int
    fixed_us: float
    pair_us: float

    @property
    def total_us(self) -> float:
        return self.fixed_us + self.pair_us * self.bulbs * (self.bulbs - 1) / 2

    def most_bulbs(self) -> int:
        pairs = (ENGINE_BUDGET_US - self.fixed_us) / self.pair_us
        return int((1 + math.sqrt(1 + 8 * pairs)) / 2) if pairs >= 1 else 1


def states(rooms: int) -> int:
    return sum(math.comb(rooms, k) for k in range(min(K_MAX, rooms) + 1))


def engine_cost(plan: Plan) -> Cost:
    ids = {room.id for room in plan.rooms}
    sizes = [len(room.outline) for room in plan.rooms]
    corners = sum(sizes)
    listed = any(a != b and a in ids and b in ids for a, b in plan.adjacent)
    touching = 0 if listed else corners * corners - sum(n * n for n in sizes)
    hard = sum(1 for wall in plan.walls if wall.kind in HARD_WALLS)
    count = states(len(plan.rooms))
    return Cost(
        rooms=len(plan.rooms),
        corners=corners,
        bulbs=len(plan.bulbs),
        fixed_us=count * STATE_US + touching * CORNER_PAIR_US,
        pair_us=PAIR_US
        + count * PAIR_STATE_US
        + corners * PAIR_CORNER_US
        + len(plan.rooms) * PAIR_ROOM_US
        + len(plan.walls) * PAIR_WALL_US
        + hard * PAIR_HARD_WALL_US,
    )


def _counted(plan: Plan, what: str, most: tuple[int, int, int, int]) -> str | None:
    counts = (
        ("rooms", len(plan.rooms)),
        ("room corners", sum(len(room.outline) for room in plan.rooms)),
        ("walls and doors", len(plan.walls) + len(plan.doors)),
        ("bulbs", len(plan.bulbs)),
    )
    return next(
        (
            f"{what} has too many {name}: {count}, at most {top}"
            for (name, count), top in zip(counts, most, strict=True)
            if count > top
        ),
        None,
    )


def excess(plan: Plan, what: str = "The plan") -> str | None:
    counted = _counted(plan, what, (MAX_ROOMS, MAX_VERTICES, MAX_WALLS, MAX_BULBS))
    if counted is not None:
        return counted
    cost = engine_cost(plan)
    if cost.total_us <= ENGINE_BUDGET_US:
        return None
    if cost.fixed_us > ENGINE_BUDGET_US:
        return (
            f"{what} is too detailed to sense in time: {cost.corners} room corners in rooms with no doors"
            " between them; add the doors or simplify the rooms"
        )
    return (
        f"{what} is too large to sense in time: {cost.bulbs} bulbs with {cost.rooms} rooms and"
        f" {cost.corners} room corners, at most {cost.most_bulbs()} bulbs with these rooms"
    )


def limit(plan: Plan, what: str = "The plan") -> None:
    problem = excess(plan, what)
    if problem is not None:
        raise OutglowError("invalid_format", problem)


def limit_kept(plan: Plan, what: str = "The current plan") -> None:
    problem = _counted(plan, what, (KEPT_ROOMS, KEPT_VERTICES, KEPT_WALLS, KEPT_BULBS))
    if problem is not None:
        raise OutglowError("invalid_format", problem)


def background_file(data: bytes, ext: str) -> str:
    return f"plan-{hashlib.sha256(data).hexdigest()[:16]}.{ext}"


class _Warnings:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []

    def add(self, code: str, **params: Any) -> None:
        self.items.append({"code": code, "params": params})


def parse(fmt: str, text: str, known: Mapping[str, str]) -> tuple[Plan, list[dict[str, Any]]]:
    imported = load(fmt, text, known)
    return imported.plan, imported.warnings


def _sized(text: str, most: int) -> None:
    if len(text) > most:
        raise OutglowError(
            "invalid_format", f"The file is too large: {len(text) // 1024} KB, at most {most // 1024} KB"
        )


def load(fmt: str, text: str, known: Mapping[str, str], current: Plan | None = None) -> Imported:
    _sized(text, MAX_TEXT)
    match fmt:
        case "auto":
            source, data = _detect(text)
        case "mieszkanie_yaml":
            _sized(text, MAX_PLAN_TEXT)
            data = _yaml(text)
            source = "outglow_plan" if _stored(data) else "prototype_yaml"
        case "outglow_json":
            _sized(text, MAX_PLAN_TEXT)
            data = _json(text)
            source = "outglow_plan" if _is_plan(data) else "prototype_layout"
        case "valetudo_json":
            source, data = "valetudo_map", _json(text)
        case _:
            raise OutglowError("invalid_format", "Unknown format")
    return build(source, data, known, current)


def build(source: str, data: object, known: Mapping[str, str], current: Plan | None = None) -> Imported:
    warnings = _Warnings()
    background = None
    match source:
        case "valetudo_map":
            plan, background = _from_valetudo(data, warnings)
        case "prototype_yaml":
            plan = _from_mapping(data, known, warnings)
        case _:
            plan = _from_json(data, known, warnings)
    limit(plan)
    clock = _Clock()
    kept = None
    if current is not None and current.bulbs and source != "outglow_plan":
        limit_kept(current)
        plan, kept = _keep(plan, current, warnings, carry_rooms=source == "valetudo_map", clock=clock)
    check(plan, known, warnings, clock)
    return Imported(plan=plan, warnings=warnings.items, source=source, background=background, kept=kept)


class _NotFinite(ValueError):
    pass


def _constant(text: str) -> float:
    raise _NotFinite(text)


def _finite(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise _NotFinite(text)
    return value


def read_json(text: str | bytes, what: str = "Not valid JSON") -> object:
    try:
        return json.loads(text, parse_constant=_constant, parse_float=_finite)
    except _NotFinite as err:
        raise OutglowError("invalid_format", "Numbers must be finite, not NaN or Infinity") from err
    except (ValueError, RecursionError) as err:
        raise OutglowError("invalid_format", what) from err


def inflate(data: bytes, most: int, what: str, unpacked: str = "not deflated") -> bytes:
    stream = zlib.decompressobj()
    try:
        out = stream.decompress(data, most + 1)
    except zlib.error as err:
        raise OutglowError("invalid_format", f"{what} is {unpacked}") from err
    if len(out) > most:
        raise OutglowError("invalid_format", f"{what} is too large")
    if not stream.eof or stream.unused_data:
        raise OutglowError("invalid_format", f"{what} is cut short or has more data after it")
    return out


def inflate_text(encoded: str) -> str:
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as err:
        raise OutglowError("invalid_format", "Not base64") from err
    text = inflate(data, MAX_TEXT, "The file")
    try:
        return text.decode()
    except UnicodeDecodeError as err:
        raise OutglowError("invalid_format", "The text is not UTF-8") from err


def _json(text: str) -> object:
    return read_json(text)


def _yaml(text: str) -> object:
    try:
        return yaml.load(text, Loader=yaml.SafeLoader)
    except yaml.YAMLError as err:
        raise OutglowError("invalid_format", "Not valid YAML") from err


def _detect(text: str) -> tuple[str, object]:
    if text.lstrip()[:1] in ("{", "["):
        if '"layers"' not in text:
            _sized(text, MAX_PLAN_TEXT)
        data = _json(text)
        if valetudo.is_map(data):
            return "valetudo_map", data
        _sized(text, MAX_PLAN_TEXT)
        return ("outglow_plan" if _is_plan(data) else "prototype_layout"), data
    _sized(text, MAX_PLAN_TEXT)
    data = _yaml(text)
    if not isinstance(data, Mapping):
        raise OutglowError("invalid_format", "Not a plan, a Valetudo map or a prototype layout")
    return "prototype_yaml", data


def _is_plan(data: object) -> bool:
    if _stored(data):
        data = data["data"]
    if isinstance(data, Mapping) and isinstance(data.get("plan"), Mapping):
        data = data["plan"]
    return isinstance(data, Mapping) and isinstance(data.get("rooms"), list)


def _from_valetudo(data: object, warnings: _Warnings) -> tuple[Plan, bytes | None]:
    try:
        parsed = valetudo.parse(valetudo.decode(data))
    except valetudo.MapError as err:
        raise OutglowError("invalid_format", str(err)) from err
    warnings.items.extend(parsed.warnings)
    if not parsed.rooms:
        warnings.add("no_segments")
    elif len(parsed.rooms) > 1 and not parsed.doors:
        warnings.add("no_doors")
    backdrop = parsed.backdrop
    plan = Plan(
        background=Background(
            file=background_file(backdrop.svg, "svg"),
            x=backdrop.x,
            y=backdrop.y,
            m_per_px=backdrop.m_per_px,
            opacity=BACKGROUND_OPACITY,
        )
        if backdrop.svg is not None
        else None,
        rooms=tuple(parsed.rooms),
        walls=tuple(parsed.walls),
        doors=tuple(parsed.doors),
        adjacent=tuple(parsed.adjacent),
    )
    return plan, backdrop.svg


def _centre(outline: tuple[Point, ...]) -> complex:
    n = len(outline)
    area = sx = sy = 0.0
    for i in range(n):
        (x1, y1), (x2, y2) = outline[i], outline[(i + 1) % n]
        cross = x1 * y2 - x2 * y1
        area += cross
        sx += (x1 + x2) * cross
        sy += (y1 + y2) * cross
    if abs(area) < 1e-12:
        return complex(sum(p[0] for p in outline) / n, sum(p[1] for p in outline) / n)
    return complex(sx / (3 * area), sy / (3 * area))


def _spread(points: list[complex]) -> float:
    mean = sum(points) / len(points)
    xx = sum((p - mean).real ** 2 for p in points) / len(points)
    yy = sum((p - mean).imag ** 2 for p in points) / len(points)
    xy = sum((p - mean).real * (p - mean).imag for p in points) / len(points)
    half = (xx + yy) / 2
    return math.sqrt(max(0.0, half - math.sqrt(max(0.0, half * half - (xx * yy - xy * xy)))))


def _rigid(src: list[complex], dst: list[complex]) -> tuple[complex, complex, float]:
    n = len(src)
    ms, md = sum(src) / n, sum(dst) / n
    turn = sum((w - md) * (z - ms).conjugate() for z, w in zip(src, dst, strict=True))
    spin = turn / abs(turn) if abs(turn) > 1e-9 else complex(1)
    shift = md - spin * ms
    rms = math.sqrt(sum(abs(spin * z + shift - w) ** 2 for z, w in zip(src, dst, strict=True)) / n)
    return spin, shift, rms


def _fit(pairs: list[tuple[complex, complex]]) -> tuple[complex, complex, bool, float] | None:
    if len(pairs) < MIN_FIT_ROOMS:
        return None
    src, dst = [a for a, _ in pairs], [b for _, b in pairs]
    spin, shift, rms = _rigid(src, dst)
    if len(pairs) >= MIN_MIRROR_ROOMS and min(_spread(src), _spread(dst)) >= MIN_SPREAD_M:
        flipped = _rigid([z.conjugate() for z in src], dst)
        if flipped[2] * MIRROR_GAIN <= rms:
            return flipped[0], flipped[1], True, flipped[2]
    return spin, shift, False, rms


def _turned(angle: float, by: float, mirrored: bool = False) -> float:
    return round(((180.0 - angle if mirrored else angle) + by) % 360.0, 1) % 360.0


def _keep(
    plan: Plan, current: Plan, warnings: _Warnings, carry_rooms: bool, clock: _Clock | None = None
) -> tuple[Plan, dict[str, Any]]:
    clock = clock or _Clock()
    by_id = {room.id: room for room in current.rooms if len(room.outline) >= 3}
    by_name = {room.name.casefold(): room for room in by_id.values()}
    used: set[str] = set()
    pairs: list[tuple[Room, Room]] = []
    for room in plan.rooms:
        old = by_id.get(room.id) or by_name.get(room.name.casefold())
        if old is not None and old.id not in used and len(room.outline) >= 3:
            used.add(old.id)
            pairs.append((room, old))
    matched = {id(new): old for new, old in pairs}
    ids: dict[str, str] = {}
    taken = set(used)
    rooms = []
    for room in plan.rooms:
        old = matched.get(id(room))
        if old is not None:
            ids[room.id] = old.id
            carried = (
                replace(room, id=old.id, name=old.name, colour=old.colour, area_id=old.area_id, entrance=old.entrance)
                if carry_rooms
                else replace(room, id=old.id)
            )
            rooms.append(carried)
            continue
        new_id, n = room.id, 2
        while new_id in taken:
            new_id, n = f"{room.id}_{n}", n + 1
        taken.add(new_id)
        ids[room.id] = new_id
        rooms.append(replace(room, id=new_id))
    fit = _fit([(_centre(old.outline), _centre(new.outline)) for new, old in pairs])
    new_rooms = tuple(rooms)
    now, before = _Rooms(new_rooms, clock), _Rooms(current.rooms, clock)
    imported = {bulb.ieee for bulb in plan.bulbs}
    bulbs = [replace(b, room=ids.get(b.room, b.room) if b.room is not None else None) for b in plan.bulbs]
    moved = 0
    for bulb in current.bulbs:
        if bulb.ieee in imported:
            continue
        z = complex(bulb.x, bulb.y)
        if fit is not None:
            spin, shift, mirror, _ = fit
            z = spin * (z.conjugate() if mirror else z) + shift
        point = (round(z.real, 3), round(z.imag, 3))
        here = now.at(point)
        was = before.at((bulb.x, bulb.y))
        assigned = bulb.room if bulb.room in ids.values() and (here is None or bulb.room != was) else None
        if here is None and assigned is not None:
            warnings.add("bulb_outside_rooms", ieee=bulb.ieee)
        bulbs.append(replace(bulb, x=point[0], y=point[1], room=assigned))
        moved += 1
    excluded = list(plan.excluded_directions)
    seen = {(e.rx, e.tx) for e in excluded}
    excluded += [e for e in current.excluded_directions if (e.rx, e.tx) not in seen]
    if fit is None:
        warnings.add("bulbs_not_aligned", rooms=len(pairs))
    rotation = math.degrees(cmath.phase(fit[0])) if fit else 0.0
    mirrored = bool(fit and fit[2])
    turn = rotation if fit and not mirrored else 0.0
    kept = {
        "bulbs": moved,
        "rooms": len(pairs),
        "aligned": fit is not None,
        "rotation_deg": round(rotation, 1),
        "mirrored": mirrored,
        "rms_m": round(fit[3], 2) if fit else None,
    }
    merged = replace(
        plan,
        floor_id=current.floor_id,
        north_deg=_turned(current.north_deg, rotation if mirrored else turn, mirrored),
        view_rotation_deg=_turned(current.view_rotation_deg, -turn),
        rooms=new_rooms,
        adjacent=tuple((ids.get(a, a), ids.get(b, b)) for a, b in plan.adjacent),
        bulbs=tuple(bulbs),
        excluded_directions=tuple(excluded),
    )
    return merged, kept


def _stored(data: object) -> TypeGuard[Mapping[str, Any]]:
    return isinstance(data, Mapping) and str(data.get("key", "")).startswith(PLAN_KEY) and "data" in data


def _from_json(data: object, known: Mapping[str, str], warnings: _Warnings) -> Plan:
    if _stored(data):
        data = data["data"]
    if isinstance(data, Mapping) and isinstance(data.get("layout"), Mapping):
        data = data["layout"]
    if isinstance(data, Mapping) and isinstance(data.get("plan"), Mapping):
        data = data["plan"]
    if isinstance(data, Mapping) and isinstance(data.get("rooms"), list):
        try:
            return from_json(Plan, {**migrate_plan(dict(data)), "rev": 0})
        except CodecError as err:
            raise OutglowError("invalid_format", str(err)) from err
        except OverflowError as err:
            raise OutglowError("invalid_format", "A number is too large") from err
    for key in sorted(set(data) - TOP_KEYS) if isinstance(data, Mapping) else []:
        warnings.add("dropped_field", field=str(key))
    return _from_mapping(
        {k: v for k, v in data.items() if k in TOP_KEYS} if isinstance(data, Mapping) else data, known, warnings
    )


def _from_mapping(data: object, known: Mapping[str, str], warnings: _Warnings) -> Plan:
    if not isinstance(data, Mapping):
        raise OutglowError("invalid_format", "Expected a mapping at the top")
    for key in sorted(set(data) - TOP_KEYS):
        warnings.add("dropped_field", field=str(key))
    rooms = _rooms(data.get("rooms"), warnings)
    ids = {room.id for room in rooms}
    adjacent = tuple(
        (str(a), str(b))
        for a, b in (pair for pair in data.get("adjacent") or [] if isinstance(pair, list | tuple) and len(pair) == 2)
        if str(a) in ids and str(b) in ids
    )
    by_name = {name: ieee for ieee, name in known.items()}
    bulbs = _bulbs(data.get("bulbs"), ids, by_name, warnings)
    excluded = _excluded(data.get("skip") or data.get("excluded_directions"), by_name)
    return from_json(
        Plan,
        {
            "rooms": [to_json(room) for room in rooms],
            "adjacent": [list(pair) for pair in adjacent],
            "bulbs": [to_json(bulb) for bulb in bulbs],
            "excluded_directions": excluded,
        },
    )


def _rooms(raw: object, warnings: _Warnings) -> tuple[Room, ...]:
    items = raw.items() if isinstance(raw, Mapping) else []
    rooms: list[Room] = []
    for index, (key, body) in enumerate(items):
        if not isinstance(body, Mapping):
            continue
        for field in sorted(set(body) - ROOM_KEYS):
            warnings.add("dropped_field", field=f"rooms.{key}.{field}")
        outline = tuple(p for p in (_point(v) for v in body.get("outline") or []) if p is not None)
        area = body.get("area_id", body.get("area"))
        rooms.append(
            Room(
                id=_slug(str(key)),
                name=str(body.get("name") or str(key).replace("_", " ").capitalize()),
                outline=outline,
                colour=str(body.get("colour") or body.get("color") or COLOURS[index % len(COLOURS)]),
                area_id=str(area) if area else None,
                entrance=body.get("entrance") is True,
            )
        )
    return tuple(rooms)


def _bulbs(raw: object, rooms: set[str], by_name: Mapping[str, str], warnings: _Warnings) -> tuple[PlanBulb, ...]:
    items: list[Any] = list(raw.values()) if isinstance(raw, Mapping) else list(raw) if isinstance(raw, list) else []
    bulbs: list[PlanBulb] = []
    for body in items:
        if not isinstance(body, Mapping):
            continue
        ieee = str(body.get("ieee") or by_name.get(str(body.get("z2m")), "")).lower()
        point = _point(body.get("at")) or _point([body.get("x"), body.get("y")])
        if not IEEE.match(ieee) or point is None:
            warnings.add("unknown_bulb", name=str(body.get("z2m") or body.get("id") or ""), ieee=ieee or None)
            continue
        room = body.get("room")
        if room is not None and _slug(str(room)) not in rooms:
            warnings.add("unknown_room", ieee=ieee, room=str(room))
            room = None
        height = body.get("height")
        bulbs.append(
            PlanBulb(
                ieee=ieee,
                x=point[0],
                y=point[1],
                height=height if height in HEIGHTS else "ceiling",
                room=_slug(str(room)) if room is not None else None,
            )
        )
    return tuple(bulbs)


def _excluded(raw: object, by_name: Mapping[str, str]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for item in raw if isinstance(raw, list) else []:
        pair = [item.get("rx"), item.get("tx")] if isinstance(item, Mapping) else item
        if not isinstance(pair, list | tuple) or len(pair) != 2:
            continue
        rx, tx = (str(by_name.get(str(v), v)).lower() for v in pair)
        if IEEE.match(rx) and IEEE.match(tx):
            reason = item.get("reason", "") if isinstance(item, Mapping) else "imported"
            out.append({"rx": rx, "tx": tx, "reason": str(reason)})
    return out


def _pinned(plan: Plan, found: Mapping[str, str | None], warnings: _Warnings) -> None:
    for bulb in plan.bulbs:
        at = found[bulb.ieee]
        if bulb.room is not None and at != bulb.room:
            warnings.add("bulb_pinned_elsewhere", ieee=bulb.ieee, room=bulb.room, at=at)


def pinned_elsewhere(plan: Plan) -> list[dict[str, Any]]:
    warnings = _Warnings()
    _pinned(plan, positions(plan, _Rooms(plan.rooms, _Clock())), warnings)
    return warnings.items


def positions(plan: Plan, rooms: _Rooms) -> dict[str, str | None]:
    return {bulb.ieee: rooms.at((bulb.x, bulb.y)) for bulb in plan.bulbs}


def check(plan: Plan, known: Mapping[str, str], warnings: _Warnings, clock: _Clock | None = None) -> None:
    rooms = _Rooms(plan.rooms, clock or _Clock())
    found = positions(plan, rooms)
    with_bulbs = set()
    for bulb in plan.bulbs:
        if known and bulb.ieee not in known:
            warnings.add("unknown_bulb", ieee=bulb.ieee, name=None)
        at = bulb.room if bulb.room is not None else found[bulb.ieee]
        if at is None:
            warnings.add("bulb_outside_rooms", ieee=bulb.ieee)
        with_bulbs.add(at)
    _pinned(plan, found, warnings)
    for room in plan.rooms:
        if room.id not in with_bulbs:
            warnings.add("room_without_bulb", room=room.id)
    _overlaps(rooms, warnings)


def _meet(a: Box, b: Box) -> bool:
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def _overlaps(rooms: _Rooms, warnings: _Warnings) -> None:
    for i, (a, box_a) in enumerate(zip(rooms.rooms, rooms.boxes, strict=True)):
        for b, box_b in zip(rooms.rooms[i + 1 :], rooms.boxes[i + 1 :], strict=True):
            if not _meet(box_a, box_b):
                continue
            rooms.clock.tick()
            if outlines_overlap(a.outline, b.outline):
                warnings.add("overlapping_rooms", a=a.id, b=b.id)


def bulb_room(bulb: PlanBulb, rooms: tuple[Room, ...]) -> str | None:
    return bulb.room if bulb.room is not None else room_of((bulb.x, bulb.y), rooms)


def check_plan(plan: Plan) -> None:
    ids = [room.id for room in plan.rooms]
    if len(set(ids)) != len(ids) or any(not room_id for room_id in ids):
        raise OutglowError("invalid_format", "Room ids must be unique and not empty")
    if set(ids) & set(plan.retired_rooms):
        raise OutglowError("invalid_format", "A room id is listed as retired")
    for bulb in plan.bulbs:
        if not IEEE.match(bulb.ieee):
            raise OutglowError("invalid_format", f"Bad IEEE address {bulb.ieee}")
        if bulb.room is not None and bulb.room not in ids:
            raise OutglowError("invalid_format", f"Unknown room {bulb.room}")
    if len({bulb.ieee for bulb in plan.bulbs}) != len(plan.bulbs):
        raise OutglowError("invalid_format", "A bulb is placed twice")
    if any(not 0 <= door.wall < len(plan.walls) for door in plan.doors):
        raise OutglowError("invalid_format", "A door points at a missing wall")
    if any(a not in ids or b not in ids for a, b in plan.adjacent):
        raise OutglowError("invalid_format", "Adjacent rooms must exist")
    if plan.background is not None and not BACKGROUND_FILE.fullmatch(plan.background.file):
        raise OutglowError("invalid_format", "Background file must be plan.<ext> or plan-<hash>.<ext>")
