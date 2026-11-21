from collections.abc import Callable
from typing import Any

Item = dict[str, Any]


def _changed_list(prev: list[Item], cur: list[Item], key: Callable[[Item], str]) -> list[Item] | None:
    before = {key(item): item for item in prev}
    now = {key(item) for item in cur}
    if any(k not in now for k in before):
        return None
    return [item for item in cur if before.get(key(item)) != item]


def _changed_map(prev: dict[str, Any], cur: dict[str, Any]) -> dict[str, Any] | None:
    if any(k not in cur for k in prev):
        return None
    return {k: v for k, v in cur.items() if prev.get(k) != v}


def frame_delta(prev: dict[str, Any], cur: dict[str, Any]) -> dict[str, Any] | None:
    directions = _changed_list(prev["directions"], cur["directions"], lambda d: f"{d['rx']}<{d['tx']}")
    pairs = _changed_list(prev["pairs"], cur["pairs"], lambda p: f"{p['a']}|{p['b']}")
    rooms = _changed_map(prev["rooms"], cur["rooms"])
    gates = _changed_map(prev["gates"], cur["gates"])
    if directions is None or pairs is None or rooms is None or gates is None:
        return None
    delta: dict[str, Any] = {"t": cur["t"]}
    for key in ("status", "model_version", "veto", "trail", "illustrative_xy"):
        if prev[key] != cur[key]:
            delta[key] = cur[key]
    for key, value in (("directions", directions), ("pairs", pairs), ("rooms", rooms), ("gates", gates)):
        if value:
            delta[key] = value
    return delta
