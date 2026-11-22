import json
import sqlite3
import threading
import zlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from .engine import from_json, to_json
from .engine.types import Context, HistoryEvent, Label, LightEvent, Observation, Retention

RawRecord = Observation | LightEvent | Context
RawTable = Literal["raw", "empty_raw"]
LabelStatus = Literal["pending", "applied", "discarded"]
HOUR = 3600.0
DAY = 86400.0
CHUNK = 2000

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS raw (t REAL NOT NULL, kind TEXT NOT NULL, rx TEXT, data BLOB NOT NULL)",
    "CREATE INDEX IF NOT EXISTS raw_t ON raw (t)",
    "CREATE TABLE IF NOT EXISTS empty_raw (t REAL NOT NULL, kind TEXT NOT NULL, rx TEXT, data BLOB NOT NULL)",
    "CREATE INDEX IF NOT EXISTS empty_raw_t ON empty_raw (t)",
    "CREATE TABLE IF NOT EXISTS empty_spans (t0 REAL NOT NULL, t1 REAL NOT NULL)",
    "CREATE TABLE IF NOT EXISTS ticks (t REAL NOT NULL, rooms BLOB NOT NULL, pairs BLOB NOT NULL)",
    "CREATE INDEX IF NOT EXISTS ticks_t ON ticks (t)",
    "CREATE TABLE IF NOT EXISTS events (t REAL NOT NULL, kind TEXT NOT NULL, room TEXT, data TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS events_t ON events (t)",
    "CREATE TABLE IF NOT EXISTS labels (id INTEGER PRIMARY KEY, t0 REAL NOT NULL, t1 REAL NOT NULL, "
    "kind TEXT NOT NULL, room TEXT, activity TEXT NOT NULL, source TEXT NOT NULL, weight REAL NOT NULL, "
    "status TEXT NOT NULL, pending_id TEXT)",
)
ROOMS_QUERY = "SELECT room FROM events WHERE room IS NOT NULL UNION SELECT room FROM labels WHERE room IS NOT NULL"
KINDS: dict[type, str] = {Observation: "bulb", LightEvent: "light", Context: "context"}
TYPES: dict[str, type[RawRecord]] = {"bulb": Observation, "light": LightEvent, "context": Context}


def _pack(value: object) -> bytes:
    return zlib.compress(json.dumps(value, separators=(",", ":")).encode())


def _unpack(blob: bytes) -> Any:
    return json.loads(zlib.decompress(blob))


def _record_t(record: RawRecord) -> float:
    return record.t


def _record_rx(record: RawRecord) -> str | None:
    match record:
        case Observation():
            return record.rx
        case LightEvent():
            return record.ieee
        case Context():
            return None


@dataclass(slots=True)
class _Batch:
    raw: list[tuple[float, str, str | None, bytes]] = field(default_factory=list)
    ticks: list[tuple[float, bytes, bytes]] = field(default_factory=list)
    events: list[tuple[float, str, str | None, str]] = field(default_factory=list)


class History:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._db: sqlite3.Connection | None = None
        self._batch = _Batch()

    def open(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, check_same_thread=False)
        db.execute("PRAGMA journal_mode=WAL")
        for statement in SCHEMA:
            db.execute(statement)
        db.commit()
        self._db = db

    def close(self) -> None:
        if self._db is not None:
            self.flush()
        self._batch = _Batch()
        with self._lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def _conn(self) -> sqlite3.Connection:
        if self._db is None:
            raise RuntimeError("history is closed")
        return self._db

    def add_record(self, record: RawRecord) -> None:
        kind = KINDS[type(record)]
        self._batch.raw.append((_record_t(record), kind, _record_rx(record), _pack(to_json(record))))

    def add_tick(self, t: float, rooms: dict[str, list[Any]], pairs: list[list[Any]]) -> None:
        self._batch.ticks.append((t, _pack(rooms), _pack(pairs)))

    def add_event(self, event: HistoryEvent) -> None:
        self._batch.events.append((event.t, event.kind, event.room, json.dumps(event.data)))

    def pending_writes(self) -> bool:
        batch = self._batch
        return bool(batch.raw or batch.ticks or batch.events)

    def flush(self) -> None:
        self.write_batch(self.take_batch())

    def take_batch(self) -> _Batch:
        batch, self._batch = self._batch, _Batch()
        return batch

    def write_batch(self, batch: _Batch) -> None:
        if not (batch.raw or batch.ticks or batch.events):
            return
        with self._lock:
            db = self._conn()
            db.executemany("INSERT INTO raw VALUES (?, ?, ?, ?)", batch.raw)
            db.executemany("INSERT INTO ticks VALUES (?, ?, ?)", batch.ticks)
            db.executemany("INSERT INTO events VALUES (?, ?, ?, ?)", batch.events)
            db.commit()

    def purge(self, retention: Retention, now: float) -> None:
        with self._lock:
            db = self._conn()
            db.execute("DELETE FROM raw WHERE t < ?", (now - retention.raw_h * HOUR,))
            db.execute("DELETE FROM empty_raw WHERE t < ?", (now - retention.empty_raw_d * DAY,))
            db.execute("DELETE FROM empty_spans WHERE t1 < ?", (now - retention.empty_raw_d * DAY,))
            db.execute("DELETE FROM ticks WHERE t < ?", (now - retention.ticks_d * DAY,))
            db.execute("DELETE FROM events WHERE t < ?", (now - retention.events_d * DAY,))
            db.commit()

    def clear_motion(self) -> None:
        with self._lock:
            db = self._conn()
            for table in ("raw", "empty_raw", "empty_spans", "ticks", "events"):
                db.execute(f"DELETE FROM {table}")
            db.commit()

    def copy_to_empty(self, t0: float, t1: float) -> int:
        with self._lock:
            db = self._conn()
            db.execute("DELETE FROM empty_raw WHERE t >= ? AND t <= ?", (t0, t1))
            cursor = db.execute(
                "INSERT INTO empty_raw SELECT t, kind, rx, data FROM raw WHERE t >= ? AND t <= ? AND kind = 'bulb'",
                (t0, t1),
            )
            db.execute("INSERT INTO empty_spans VALUES (?, ?)", (t0, t1))
            db.commit()
            return cursor.rowcount

    def empty_spans(self, t0: float, t1: float) -> list[tuple[float, float]]:
        with self._lock:
            rows = self._conn().execute(
                "SELECT t0, t1 FROM empty_spans WHERE t1 >= ? AND t0 <= ? ORDER BY t0", (t0, t1)
            )
            spans = [(max(float(a), t0), min(float(b), t1)) for a, b in rows]
        merged: list[tuple[float, float]] = []
        for a, b in spans:
            if merged and a <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], b))
            else:
                merged.append((a, b))
        return merged

    def records(self, t0: float, t1: float, table: RawTable = "raw") -> list[RawRecord]:
        with self._lock:
            rows = self._conn().execute(
                f"SELECT kind, data FROM {table} WHERE t >= ? AND t <= ? ORDER BY t, rowid",
                (t0, t1),
            )
            return [from_json(TYPES[kind], _unpack(data)) for kind, data in rows]

    def iter_records(self, t0: float, t1: float, table: RawTable = "raw", chunk: int = CHUNK) -> Iterator[RawRecord]:
        after_t, after_row = t0, -1
        while True:
            with self._lock:
                rows = (
                    self._conn()
                    .execute(
                        f"SELECT t, rowid, kind, data FROM {table} WHERE t >= ? AND t <= ? "
                        "AND (t > ? OR (t = ? AND rowid > ?)) ORDER BY t, rowid LIMIT ?",
                        (after_t, t1, after_t, after_t, after_row, chunk),
                    )
                    .fetchall()
                )
            for _t, _row, kind, data in rows:
                yield from_json(TYPES[kind], _unpack(data))
            if len(rows) < chunk:
                return
            after_t, after_row = float(rows[-1][0]), int(rows[-1][1])

    def iter_observations(self, t0: float, t1: float, table: RawTable = "raw") -> Iterator[Observation]:
        return (r for r in self.iter_records(t0, t1, table) if isinstance(r, Observation))

    def oldest_raw(self) -> float | None:
        with self._lock:
            row = self._conn().execute("SELECT MIN(t) FROM raw").fetchone()
        value = row[0] if row else None
        return float(value) if value is not None else None

    def events(self, t0: float, t1: float, kinds: Iterable[str] | None = None) -> list[HistoryEvent]:
        query = "SELECT t, kind, room, data FROM events WHERE t >= ? AND t <= ?"
        params: list[Any] = [t0, t1]
        wanted = list(kinds) if kinds is not None else None
        if wanted is not None:
            query += f" AND kind IN ({', '.join('?' for _ in wanted)})"
            params.extend(wanted)
        with self._lock:
            rows = self._conn().execute(query + " ORDER BY t, rowid", params).fetchall()
        return [
            from_json(HistoryEvent, {"t": t, "kind": kind, "room": room, "data": json.loads(data)})
            for t, kind, room, data in rows
        ]

    def ticks(self, t0: float, t1: float) -> Iterator[tuple[float, dict[str, list[Any]], list[list[Any]]]]:
        with self._lock:
            rows = (
                self._conn()
                .execute("SELECT t, rooms, pairs FROM ticks WHERE t >= ? AND t <= ? ORDER BY t", (t0, t1))
                .fetchall()
            )
        for t, rooms, pairs in rows:
            yield float(t), _unpack(rooms), _unpack(pairs)

    def add_labels(self, labels: Iterable[Label], status: LabelStatus, pending_id: str | None) -> None:
        rows = [
            (lb.t0, lb.t1, lb.kind, lb.room, lb.activity, lb.source, lb.weight, status, pending_id) for lb in labels
        ]
        with self._lock:
            db = self._conn()
            db.executemany(
                "INSERT INTO labels (t0, t1, kind, room, activity, source, weight, status, pending_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                rows,
            )
            db.commit()

    def set_label_status(self, pending_id: str, status: LabelStatus) -> None:
        with self._lock:
            db = self._conn()
            db.execute("UPDATE labels SET status = ? WHERE pending_id = ? AND status = 'pending'", (status, pending_id))
            db.commit()

    def move_pending(self, old: str, new: str) -> None:
        with self._lock:
            db = self._conn()
            db.execute("UPDATE labels SET pending_id = ? WHERE pending_id = ? AND status = 'pending'", (new, old))
            db.commit()

    def discard_rooms(self, rooms: list[str]) -> None:
        marks = ",".join("?" * len(rooms))
        with self._lock:
            db = self._conn()
            db.execute(f"UPDATE labels SET status = 'discarded' WHERE status = 'pending' AND room IN ({marks})", rooms)
            db.commit()

    def rooms(self) -> set[str]:
        with self._lock:
            rows = self._conn().execute(ROOMS_QUERY).fetchall()
        return {str(room) for (room,) in rows}

    def labels(self, t0: float, t1: float, status: LabelStatus | None = None) -> list[Label]:
        query = "SELECT t0, t1, kind, room, activity, source, weight FROM labels WHERE t1 >= ? AND t0 <= ?"
        params: list[Any] = [t0, t1]
        if status is not None:
            query += " AND status = ?"
            params.append(status)
        with self._lock:
            rows = self._conn().execute(query + " ORDER BY t0, id", params).fetchall()
        return [
            Label(t0=a, t1=b, kind=kind, room=room, activity=activity, source=source, weight=weight)
            for a, b, kind, room, activity, source, weight in rows
        ]

    def counts(self) -> dict[str, int]:
        with self._lock:
            db = self._conn()
            return {
                table: int(db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
                for table in ("raw", "empty_raw", "ticks", "events", "labels")
            }


def series(
    rows: Iterable[tuple[float, dict[str, list[Any]], list[list[Any]]]],
    start: float,
    end: float,
    step: float,
    rooms: list[str],
    with_pairs: bool,
) -> tuple[dict[str, list[list[Any]]], list[dict[str, Any]] | None]:
    room_buckets: dict[str, dict[int, tuple[float, bool]]] = {room: {} for room in rooms}
    pair_buckets: dict[tuple[str, str], dict[int, int]] = {}
    for t, room_values, pair_values in rows:
        bucket = int((t - start) // step)
        for room, value in room_values.items():
            if room not in room_buckets:
                continue
            p, motion = float(value[0]), bool(value[1])
            old = room_buckets[room].get(bucket)
            room_buckets[room][bucket] = (max(p, old[0]), motion or old[1]) if old else (p, motion)
        if with_pairs:
            for a, b, obs in pair_values:
                key = (str(a), str(b))
                slot = pair_buckets.setdefault(key, {})
                slot[bucket] = max(int(obs), slot.get(bucket, 0))
    last = int((end - start) // step)
    out_rooms: dict[str, list[list[Any]]] = {}
    for room, buckets in room_buckets.items():
        samples: list[list[Any]] = []
        for bucket in sorted(buckets):
            p, motion = buckets[bucket]
            samples.append([start + bucket * step, round(p, 3), motion])
            if bucket + 1 not in buckets and bucket + 1 <= last:
                samples.append([start + (bucket + 1) * step, 0.0, False])
        out_rooms[room] = samples
    if not with_pairs:
        return out_rooms, None
    out_pairs = []
    for (a, b), obs_buckets in sorted(pair_buckets.items()):
        pair_samples: list[list[Any]] = []
        for bucket in sorted(obs_buckets):
            pair_samples.append([start + bucket * step, obs_buckets[bucket]])
            if bucket + 1 not in obs_buckets and bucket + 1 <= last:
                pair_samples.append([start + (bucket + 1) * step, None])
        out_pairs.append({"a": a, "b": b, "samples": pair_samples})
    return out_rooms, out_pairs
