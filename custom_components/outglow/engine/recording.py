import json
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass

from .codec import CodecError, from_json, to_json
from .defaults import RECORDING_FORMAT
from .types import (
    Context,
    Frame,
    Header,
    Json,
    Label,
    LabelActivity,
    LightEvent,
    LightState,
    LinkReading,
    Observation,
    Plan,
    Record,
    Settings,
    Source,
)

V1_ACTIVITY: dict[str, LabelActivity] = {"stand": "still", "sit": "still", "walk": "walk"}
SOURCES: dict[object, Source] = {"activity": "activity", "lines": "lines", "unknown": "unknown"}


class RecordingError(ValueError):
    pass


@dataclass(slots=True)
class _Tap:
    t: float
    room: str | None
    activity: LabelActivity
    empty: bool


def read(lines: Iterable[str], names: Mapping[str, str] | None = None) -> Iterator[Record]:
    rows = _rows(lines)
    first = next(rows, None)
    if first is None:
        return
    number, row = first
    if row.get("type") == "header":
        yield _header(number, row)
        yield from _read_v2(rows)
    else:
        yield Header(format=1)
        yield from _read_v1([(number, row)], rows, names or {})


def write(records: Iterable[Record], names: Mapping[str, str] | None = None) -> Iterator[str]:
    known = names or {}
    for record in records:
        yield json.dumps(encode(record, known), ensure_ascii=False, separators=(",", ":"))


def encode(record: Record, names: Mapping[str, str]) -> dict[str, Json]:
    match record:
        case Header():
            return {
                "type": "header",
                "format": record.format,
                "plan": to_json(record.plan),
                "settings": to_json(record.settings),
                "created": record.created,
                "generator": record.generator,
            }
        case Observation():
            return {
                "t": record.t,
                "type": "bulb",
                "name": names.get(record.rx, record.rx),
                "ieee": record.rx,
                "source": record.source,
                "links": [_encode_link(link) for link in record.links],
                "occupancy": record.occupancy,
                "light": to_json(record.light),
            }
        case LightEvent():
            return {"t": record.t, "type": "light", "ieee": record.ieee, "origin": record.origin, "on": record.on}
        case Context():
            return {
                "t": record.t,
                "type": "context",
                "persons_home": to_json(record.persons_home),
                "house_empty": record.house_empty,
                "offline": to_json(record.offline),
            }
        case Label():
            return {"t": record.t1, "type": "label", "label": to_json(record)}
        case Frame():
            return {"t": record.t, "type": "frame", "frame": to_json(record)}


def _encode_link(link: LinkReading) -> dict[str, Json]:
    activity = link.raw_activity
    if activity is None:
        activity = link.level if link.level is not None else link.window_sum
    return {
        "ieee_address": link.tx,
        "activity": activity,
        "motion": link.motion,
        "signal": link.signal_dbm,
        "noise": link.noise_db,
        "sensitivity": link.sensitivity,
        "calibrated_sensitivity": link.calibrated_sensitivity,
    }


def _rows(lines: Iterable[str]) -> Iterator[tuple[int, dict[str, object]]]:
    for number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except ValueError as err:
            raise RecordingError(f"line {number}: not JSON") from err
        if not isinstance(row, dict):
            raise RecordingError(f"line {number}: not an object")
        yield number, row


def _header(number: int, row: dict[str, object]) -> Header:
    if row.get("format") != RECORDING_FORMAT:
        raise RecordingError(f"line {number}: unsupported format {row.get('format')!r}")
    try:
        return Header(
            format=RECORDING_FORMAT,
            plan=from_json(Plan, row["plan"]) if row.get("plan") is not None else None,
            settings=from_json(Settings, row["settings"]) if row.get("settings") is not None else None,
            created=_float_or_none(row.get("created")),
            generator=str(row["generator"]) if row.get("generator") is not None else None,
        )
    except CodecError as err:
        raise RecordingError(f"line {number}: {err}") from err


def _read_v2(rows: Iterator[tuple[int, dict[str, object]]]) -> Iterator[Record]:
    for number, row in rows:
        try:
            record = _decode_v2(row)
        except (CodecError, KeyError, TypeError) as err:
            raise RecordingError(f"line {number}: {err}") from err
        if record is not None:
            yield record


def _decode_v2(row: dict[str, object]) -> Record | None:
    match row.get("type"):
        case "bulb":
            source = SOURCES[row["source"]]
            return Observation(
                t=_time(row.get("t")),
                rx=str(row["ieee"]),
                links=_links(row["links"], source),
                occupancy=_bool_or_none(row.get("occupancy")),
                light=from_json(LightState, row["light"]) if row.get("light") is not None else None,
                source=source,
            )
        case "light":
            return from_json(LightEvent, {k: v for k, v in row.items() if k != "type"})
        case "context":
            return from_json(Context, {k: v for k, v in row.items() if k != "type"})
        case "label":
            return from_json(Label, row["label"])
        case "frame":
            return from_json(Frame, row["frame"])
        case _:
            return None


def _links(raw: object, source: Source) -> tuple[LinkReading, ...]:
    if not isinstance(raw, list):
        raise CodecError("links: expected list")
    readings = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("ieee_address"), str):
            continue
        activity = _int_or_none(item.get("activity"))
        readings.append(
            LinkReading(
                tx=item["ieee_address"],
                level=activity if source == "activity" else None,
                window_sum=activity if source == "lines" else None,
                motion=bool(item.get("motion")),
                signal_dbm=_int_or_none(item.get("signal")),
                noise_db=_float_or_none(item.get("noise")),
                sensitivity=_int_or_none(item.get("sensitivity")),
                calibrated_sensitivity=_int_or_none(item.get("calibrated_sensitivity")),
                raw_activity=activity,
            )
        )
    return tuple(readings)


def _read_v1(
    head: list[tuple[int, dict[str, object]]], rows: Iterator[tuple[int, dict[str, object]]], known: Mapping[str, str]
) -> Iterator[Record]:
    names: dict[str, str] = dict(known)
    tap: _Tap | None = None
    last_t = 0.0
    for number, row in [*head, *rows]:
        try:
            t = _time(row.get("t"))
        except CodecError as err:
            raise RecordingError(f"line {number}: {err}") from err
        last_t = max(last_t, t)
        match row.get("type"):
            case "layout":
                names.update(_v1_names(row.get("layout")))
            case "bulb":
                rx = names.get(str(row.get("name")))
                if rx is not None:
                    yield Observation(
                        t=t,
                        rx=rx,
                        links=_links(row.get("links") or [], "unknown"),
                        occupancy=_bool_or_none(row.get("occupancy")),
                    )
            case "truth":
                closed = _close(tap, t)
                if closed is not None:
                    yield closed
                tap = _v1_tap(row, t)
            case _:
                pass
    closed = _close(tap, last_t)
    if closed is not None:
        yield closed


def _v1_names(layout: object) -> dict[str, str]:
    bulbs = layout.get("bulbs") if isinstance(layout, dict) else None
    names = {}
    for bulb in bulbs if isinstance(bulbs, list) else []:
        if isinstance(bulb, dict) and isinstance(bulb.get("z2m"), str) and isinstance(bulb.get("ieee"), str):
            names[bulb["z2m"]] = bulb["ieee"]
    return names


def _v1_tap(row: dict[str, object], t: float) -> _Tap | None:
    kind = row.get("kind")
    room = row.get("room") if isinstance(row.get("room"), str) else None
    if kind == "empty":
        return _Tap(t=t, room=None, activity="any", empty=True)
    if room is None:
        return None
    return _Tap(t=t, room=str(room), activity=V1_ACTIVITY.get(str(kind), "any"), empty=False)


def _close(tap: _Tap | None, t: float) -> Label | None:
    if tap is None or t <= tap.t:
        return None
    return Label(
        t0=tap.t,
        t1=t,
        kind="empty" if tap.empty else "room",
        room=tap.room,
        activity=tap.activity,
        source="recording",
        weight=1.0,
    )


def _time(value: object) -> float:
    t = _float_or_none(value)
    if t is None:
        raise CodecError("no time")
    return t


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return round(value)


def _float_or_none(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value)


def _bool_or_none(value: object) -> bool | None:
    return value if isinstance(value, bool) else None
