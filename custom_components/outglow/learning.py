import re
from collections.abc import Collection
from typing import Any, Literal

from .const import SNAPSHOTS_KEPT, SNAPSHOTS_OTHER_KEPT
from .engine.types import Json, Mode
from .errors import OutglowError

SnapshotReason = Literal["daily", "before_session", "before_apply", "before_reset", "before_rollback"]
MODES: tuple[Mode, ...] = ("rules", "bayes")
SEQ_ID = re.compile(r"^[a-z]+-(\d+)$")


def seq_of(item_id: object) -> int:
    match = SEQ_ID.match(item_id) if isinstance(item_id, str) else None
    return int(match.group(1)) if match else 0


class ModelBook:
    def __init__(self, book: dict[str, Any], snapshots: list[dict[str, Any]]) -> None:
        self.book = book
        self.snapshots = snapshots
        self.observe_id(*(item.get("snapshot_id") for item in snapshots))
        seen: set[object] = set()
        for item in snapshots:
            if item.get("snapshot_id") in seen:
                item["snapshot_id"] = f"m-{self.next_seq():04d}"
            seen.add(item["snapshot_id"])

    def observe_id(self, *ids: object) -> None:
        self.book["seq"] = max([int(self.book.get("seq") or 0), *(seq_of(i) for i in ids)])

    def engine_state(self) -> dict[str, Json] | None:
        state = self.book.get("engine")
        return state if isinstance(state, dict) else None

    def next_seq(self) -> int:
        self.book["seq"] = int(self.book.get("seq", 0)) + 1
        return int(self.book["seq"])

    def snapshot(self, reason: SnapshotReason, now: float, version: int, active: Json, mode: Mode | None = None) -> str:
        snapshot_id = f"m-{self.next_seq():04d}"
        item: dict[str, Any] = {"snapshot_id": snapshot_id, "t": now, "reason": reason, "model_version": version}
        self.snapshots.append({**item, "state": active} if mode is None else {**item, "state": active, "mode": mode})
        daily = [s for s in self.snapshots if s["reason"] == "daily"][-SNAPSHOTS_KEPT:]
        other = [s for s in self.snapshots if s["reason"] != "daily"][-SNAPSHOTS_OTHER_KEPT:]
        keep = {id(s) for s in (*daily, *other)}
        self.snapshots[:] = [s for s in self.snapshots if id(s) in keep]
        return snapshot_id

    def find_snapshot(self, snapshot_id: str) -> tuple[dict[str, Json], Mode | None]:
        found = [item for item in self.snapshots if item["snapshot_id"] == snapshot_id]
        if len(found) != 1:
            raise OutglowError("not_found", "No such snapshot")
        state = found[0].get("state")
        mode = found[0].get("mode")
        return state if isinstance(state, dict) else {}, mode if mode in MODES else None

    def delete(self, snapshot_id: str | None, protected: Collection[str]) -> None:
        if snapshot_id is not None:
            self.find_snapshot(snapshot_id)
            if snapshot_id in protected:
                raise OutglowError("busy", "An operation using this snapshot is running")
        self.snapshots[:] = [
            s
            for s in self.snapshots
            if s["snapshot_id"] in protected or (snapshot_id is not None and s["snapshot_id"] != snapshot_id)
        ]

    def snapshot_list(self) -> list[dict[str, Any]]:
        return [
            {k: item[k] for k in ("snapshot_id", "t", "reason", "model_version", "mode") if k in item}
            for item in sorted(self.snapshots, key=lambda s: (s["t"], s["snapshot_id"]))
        ]
