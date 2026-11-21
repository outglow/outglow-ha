from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import TypeGuard

from .topology import centroid, point_in_polygon
from .types import ExcludedDirection, Json, Plan, PlanBulb, Point, Room

PALETTE = ("#4e9af1", "#f28b30", "#42b883", "#b56cf0", "#e8c547", "#ef5b6c", "#3fc1c9", "#8d6e63")
MIESZKANIE_KEYS = frozenset({"rooms", "adjacent", "bulbs"})
LAYOUT_KEYS = frozenset({"bulbs", "view_rotation", "version"})


@dataclass(frozen=True, slots=True)
class Imported:
    plan: Plan
    warnings: tuple[dict[str, Json], ...] = ()
    names: dict[str, str] = field(default_factory=dict)


def warning(code: str, **params: str | float | int | None) -> dict[str, Json]:
    return {"code": code, "params": dict(params)}


def _point(value: object) -> Point | None:
    if isinstance(value, list | tuple) and len(value) == 2 and all(_is_num(v) for v in value):
        return float(value[0]), float(value[1])
    return None


def _is_num(value: object) -> TypeGuard[int | float]:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _outline(value: object) -> tuple[Point, ...]:
    points = [_point(p) for p in value] if isinstance(value, list) else []
    return tuple(p for p in points if p is not None)


def from_mieszkanie(data: Mapping[str, object]) -> Imported:
    warnings = [warning("dropped_field", field=k) for k in sorted(set(data) - MIESZKANIE_KEYS)]
    raw_rooms = data.get("rooms")
    rooms = []
    for i, (rid, spec) in enumerate(raw_rooms.items() if isinstance(raw_rooms, dict) else []):
        info = spec if isinstance(spec, dict) else {}
        outline = _outline(info.get("outline"))
        if len(outline) < 3:
            warnings.append(warning("dropped_field", field=f"rooms.{rid}.outline"))
            continue
        name = info.get("name")
        rooms.append(
            Room(
                id=str(rid),
                name=str(name) if name is not None else str(rid),
                outline=outline,
                colour=PALETTE[i % len(PALETTE)],
                entrance=bool(info.get("entrance", False)),
            )
        )
    known = {r.id for r in rooms}
    raw_adjacent = data.get("adjacent")
    adjacent = []
    for item in raw_adjacent if isinstance(raw_adjacent, list) else []:
        if isinstance(item, list) and len(item) == 2 and {str(x) for x in item} <= known:
            adjacent.append((str(item[0]), str(item[1])))
        else:
            warnings.append(warning("unknown_room", room=str(item)))
    bulbs, names = _bulbs(data.get("bulbs"), "at", known, rooms, warnings)
    plan = Plan(rooms=tuple(rooms), adjacent=tuple(adjacent), bulbs=tuple(bulbs))
    return Imported(plan=plan, warnings=tuple(warnings + _checks(plan)), names=names)


def from_layout(data: Mapping[str, object]) -> Imported:
    warnings = [warning("dropped_field", field=k) for k in sorted(set(data) - LAYOUT_KEYS)]
    bulbs, names = _bulbs(data.get("bulbs"), None, set(), [], warnings)
    rotation = data.get("view_rotation")
    plan = Plan(bulbs=tuple(bulbs), view_rotation_deg=float(rotation) if _is_num(rotation) else 0.0)
    return Imported(plan=plan, warnings=tuple(warnings + _checks(plan)), names=names)


def _bulbs(
    raw: object, at: str | None, known: set[str], rooms: list[Room], warnings: list[dict[str, Json]]
) -> tuple[list[PlanBulb], dict[str, str]]:
    bulbs = []
    names = {}
    for item in raw if isinstance(raw, list) else []:
        info = item if isinstance(item, dict) else {}
        ieee = info.get("ieee")
        label = str(info.get("z2m") or info.get("id") or "")
        xy = _point(info.get(at)) if at is not None else _point([info.get("x"), info.get("y")])
        if not isinstance(ieee, str) or xy is None:
            warnings.append(warning("unknown_bulb", name=label))
            continue
        room = info.get("room")
        if room is not None and str(room) not in known:
            warnings.append(warning("unknown_room", room=str(room), bulb=ieee))
            room = None
        bulbs.append(PlanBulb(ieee=ieee.lower(), x=xy[0], y=xy[1], room=str(room) if room is not None else None))
        if label:
            names[label] = ieee.lower()
    return bulbs, names


def _checks(plan: Plan) -> list[dict[str, Json]]:
    out = []
    for bulb in plan.bulbs:
        if bulb.room is None and not any(point_in_polygon((bulb.x, bulb.y), r.outline) for r in plan.rooms):
            out.append(warning("bulb_outside_rooms", bulb=bulb.ieee))
    for room in plan.rooms:
        inside = [b for b in plan.bulbs if b.room == room.id or point_in_polygon((b.x, b.y), room.outline)]
        if not inside:
            out.append(warning("room_without_bulb", room=room.id))
    for i, a in enumerate(plan.rooms):
        for b in plan.rooms[i + 1 :]:
            if point_in_polygon(centroid(a.outline), b.outline) or point_in_polygon(centroid(b.outline), a.outline):
                out.append(warning("overlapping_rooms", a=a.id, b=b.id))
    return out


def skip_directions(entries: Iterable[str], reason: str = "imported") -> tuple[ExcludedDirection, ...]:
    out = []
    for entry in entries:
        rx, sep, tx = entry.partition(">")
        if sep and rx and tx:
            out.append(ExcludedDirection(rx=rx.strip().lower(), tx=tx.strip().lower(), reason=reason))
    return tuple(out)
