import argparse
import json
import sys
from collections.abc import Iterable

Rect = tuple[int, int, int, int]
Cells = set[tuple[int, int]]

PIXEL_CM = 5
OUTER: Rect = (98, 98, 227, 227)


def rect(x0: int, y0: int, x1: int, y1: int) -> Cells:
    return {(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)}


def union(*parts: Iterable[tuple[int, int]]) -> Cells:
    out: Cells = set()
    for part in parts:
        out |= set(part)
    return out


def compressed(cells: Cells) -> list[int]:
    out: list[int] = []
    for y in sorted({c[1] for c in cells}):
        xs = sorted(c[0] for c in cells if c[1] == y)
        start = previous = xs[0]
        for x in [*xs[1:], None]:
            if x is not None and x == previous + 1:
                previous = x
                continue
            out += [start, y, previous - start + 1]
            if x is not None:
                start = previous = x
    return out


def layer(kind: str, cells: Cells, meta: dict[str, object], plain: bool = False) -> dict[str, object]:
    body: dict[str, object] = {
        "__class": "MapLayer",
        "metaData": {**meta, "area": len(cells) * PIXEL_CM**2},
        "type": kind,
    }
    if plain:
        body["pixels"] = [v for x, y in sorted(cells, key=lambda c: (c[1], c[0])) for v in (x, y)]
    else:
        body["compressedPixels"] = compressed(cells)
    return body


def flat() -> dict[str, object]:
    living = union(rect(100, 100, 179, 159), rect(180, 120, 181, 137), rect(110, 160, 127, 161))
    kitchen = union(rect(184, 100, 223, 159), rect(182, 120, 183, 137))
    hall = union(rect(100, 164, 139, 223), rect(140, 204, 199, 223), rect(110, 162, 127, 163), rect(160, 202, 175, 203))
    bath = union(rect(144, 164, 199, 199), rect(160, 200, 175, 201))
    tiny = rect(203, 210, 206, 213)
    rooms = union(living, kitchen, hall, bath, tiny)
    x0, y0, x1, y1 = OUTER
    inside = rect(x0 + 2, y0 + 2, x1 - 2, y1 - 2)
    ring = rect(x0, y0, x1, y1) - inside
    walls = union(ring, inside - rooms - rect(200, 164, 225, 225) - rect(100, 224, 199, 225)) - rooms
    balcony = rect(230, 120, 245, 150)
    return {
        "__class": "ValetudoMap",
        "metaData": {"version": 2, "nonce": "00000000-0000-0000-0000-000000000000", "totalLayerArea": 0},
        "size": {"x": 4000, "y": 4000},
        "pixelSize": PIXEL_CM,
        "layers": [
            layer("floor", balcony, {}, plain=True),
            layer("wall", walls, {}),
            layer("segment", living, {"segmentId": "1", "name": "Living room", "active": False}),
            layer("segment", kitchen, {"segmentId": "2", "name": "Kitchen", "active": False}),
            layer("segment", hall, {"segmentId": "3", "name": "Hall", "active": False}),
            layer("segment", bath, {"segmentId": "7", "active": False}),
            layer("segment", tiny, {"segmentId": "9", "active": False}),
        ],
        "entities": [
            {"__class": "PointMapEntity", "metaData": {"angle": 90}, "points": [1050, 1100], "type": "charger_location"}
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a small synthetic Valetudo map (ValetudoMap JSON)")
    parser.parse_args(argv)
    sys.stdout.write(json.dumps(flat(), separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
