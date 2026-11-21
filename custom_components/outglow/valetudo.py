import bisect
import heapq
import itertools
import math
import operator
import re
import time
import unicodedata
from array import array
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .engine.types import Door, Point, Room, Wall

MAX_PIXELS = 4_000_000
MAX_CELLS = 36_000_000
MAX_COORD = 100_000
MAX_SEGMENTS = 250
MAX_ROOM_VERTICES = 200
MAX_GROW_PX = 15
MAX_SVG_BYTES = 10 * 1024 * 1024
BUDGET_S = 5.0
MIN_ROOM_M2 = 0.5
MIN_PART_M2 = 0.25
GROW_M = 0.15
SIMPLIFY_PX = 2.0
SNAP_PX = 2.0
COARSEST_PX = 64.0
MIN_DOOR_M = 0.4
OPENING_M = 1.5
DOOR_GAP_PX = 2
EMPTY, FLOOR, WALL, FIRST = 0, 1, 2, 3
COLOURS = ("#4e9af1", "#f28b30", "#42b883", "#c678dd", "#e5c07b", "#e06c75", "#56b6c2", "#98c379")
DIRS = ((1, 0), (0, 1), (-1, 0), (0, -1))
TRANSLIT = str.maketrans({"ł": "l", "Ł": "L", "ø": "o", "Ø": "O", "ß": "ss", "æ": "ae", "Æ": "AE", "đ": "d"})
LABELLED = bytes(1 if v >= FIRST else 0 for v in range(256))
OPEN = bytes(1 if v < FIRST else 0 for v in range(256))
UNWALLED = bytes([EMPTY, EMPTY, EMPTY, *range(FIRST, 256)])
VACANT = bytes([1, *([0] * 255)])
SELECT = [bytes(1 if v == label else 0 for v in range(256)) for label in range(256)]
CLASSES = bytes([0, 1, 2, *([1] * (256 - FIRST))])
LABEL_RUN = re.compile(rb"([\x03-\xff])\1*")
CLASS_RUN = re.compile(rb"\x01+|\x02+")
CHECK_EVERY = 1 << 14

Run = tuple[int, int, int]
Corner = tuple[int, int]
Key = tuple[Corner, ...]
Warning = dict[str, Any]


class MapError(ValueError):
    pass


class Budget:
    def __init__(self, seconds: float | None = None) -> None:
        self.deadline = time.thread_time() + (BUDGET_S if seconds is None else seconds)

    def check(self) -> None:
        if time.thread_time() > self.deadline:
            raise MapError("The map is too complex to read in time")


@dataclass(frozen=True, slots=True)
class Segment:
    key: str
    name: str | None
    runs: array[int]


@dataclass(frozen=True, slots=True)
class ValetudoMap:
    pixel_cm: float
    floor: tuple[array[int], ...]
    wall: tuple[array[int], ...]
    segments: tuple[Segment, ...]


@dataclass(frozen=True, slots=True)
class Backdrop:
    svg: bytes | None
    x: float
    y: float
    m_per_px: float


@dataclass(slots=True)
class Parsed:
    backdrop: Backdrop
    rooms: list[Room] = field(default_factory=list)
    walls: list[Wall] = field(default_factory=list)
    doors: list[Door] = field(default_factory=list)
    adjacent: list[tuple[str, str]] = field(default_factory=list)
    warnings: list[Warning] = field(default_factory=list)


def is_map(data: object) -> bool:
    return isinstance(data, Mapping) and (
        data.get("__class") == "ValetudoMap" or ("pixelSize" in data and isinstance(data.get("layers"), list))
    )


def triples(runs: array[int]) -> Iterator[Run]:
    return zip(runs[0::3], runs[1::3], runs[2::3], strict=True)


def _int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise MapError("Pixel coordinates must be whole numbers")
    if isinstance(value, float) and not value.is_integer():
        raise MapError("Pixel coordinates must be whole numbers")
    return int(value)


def _numbers(values: list[Any]) -> array[int]:
    if set(map(type, values)) <= {int}:
        try:
            numbers = array("q", values)
        except OverflowError as err:
            raise MapError("Pixel coordinate out of range") from err
    else:
        numbers = array("q", map(_int, values))
    if numbers and (min(numbers) < 0 or max(numbers) >= MAX_COORD):
        raise MapError("Pixel coordinate out of range")
    return numbers


def _runs(layer: Mapping[str, Any]) -> array[int]:
    compressed = layer.get("compressedPixels")
    if isinstance(compressed, list):
        if len(compressed) % 3:
            raise MapError("compressedPixels must hold x, y, count triples")
        runs = _numbers(compressed)
        if 0 in runs[2::3]:
            runs = array("q", itertools.chain.from_iterable(r for r in triples(runs) if r[2]))
        return runs
    pixels = layer.get("pixels")
    if isinstance(pixels, list):
        if len(pixels) % 2:
            raise MapError("pixels must hold x, y pairs")
        numbers = _numbers(pixels)
        runs = array("q", bytes(8 * 3 * (len(numbers) // 2)))
        runs[0::3] = numbers[0::2]
        runs[1::3] = numbers[1::2]
        runs[2::3] = array("q", [1]) * (len(numbers) // 2)
        return runs
    return array("q")


def decode(data: object) -> ValetudoMap:
    if not isinstance(data, Mapping):
        raise MapError("A Valetudo map is a JSON object")
    size = data.get("pixelSize")
    if isinstance(size, bool) or not isinstance(size, int | float) or not 0.1 <= size <= 100:
        raise MapError("pixelSize must be a number of centimetres")
    layers = data.get("layers")
    if not isinstance(layers, list):
        raise MapError("The map has no layers")
    floor: list[array[int]] = []
    wall: list[array[int]] = []
    segments: list[Segment] = []
    total = 0
    for index, layer in enumerate(layers):
        if not isinstance(layer, Mapping):
            continue
        runs = _runs(layer)
        total += sum(runs[2::3])
        if total > MAX_PIXELS:
            raise MapError("The map has too many pixels")
        match layer.get("type"):
            case "floor":
                floor.append(runs)
            case "wall":
                wall.append(runs)
            case "segment":
                meta = layer.get("metaData")
                meta = meta if isinstance(meta, Mapping) else {}
                key = meta.get("segmentId")
                name = meta.get("name")
                segments.append(
                    Segment(
                        key=str(key) if key is not None else str(index),
                        name=str(name).strip() if isinstance(name, str) and name.strip() else None,
                        runs=runs,
                    )
                )
    if len(segments) > MAX_SEGMENTS:
        raise MapError("The map has too many segments")
    return ValetudoMap(pixel_cm=float(size), floor=tuple(floor), wall=tuple(wall), segments=tuple(segments))


def slug(name: str, taken: set[str]) -> str:
    text = unicodedata.normalize("NFKD", name.translate(TRANSLIT))
    base = re.sub(r"[^a-z0-9]+", "_", "".join(c for c in text if not unicodedata.combining(c)).lower()).strip("_")
    base = base or "room"
    out, n = base, 2
    while out in taken:
        out, n = f"{base}_{n}", n + 1
    taken.add(out)
    return out


class Grid:
    def __init__(self, vmap: ValetudoMap, pad: int) -> None:
        layers = [r for r in (*vmap.floor, *vmap.wall, *(s.runs for s in vmap.segments)) if r]
        if not layers:
            raise MapError("The map is empty")
        self.x0 = min(min(r[0::3]) for r in layers) - pad
        self.y0 = min(min(r[1::3]) for r in layers) - pad
        self.w = max(max(map(operator.add, r[0::3], r[2::3], strict=True)) for r in layers) + pad - self.x0
        self.h = max(max(r[1::3]) for r in layers) + 1 + pad - self.y0
        if self.w * self.h > MAX_CELLS:
            raise MapError("The map is too large")
        self.cells = bytearray(self.w * self.h)

    def fill(self, runs: array[int], value: int) -> None:
        cells = memoryview(self.cells)
        line = memoryview(bytes([value]) * self.w)
        w, x0, y0 = self.w, self.x0, self.y0
        for x, y, count in triples(runs):
            start = (y - y0) * w + x - x0
            cells[start : start + count] = line[:count]


@dataclass(slots=True)
class _Ring:
    corners: array[int]
    direct: bytearray
    w: int


@dataclass(slots=True)
class _Run:
    ring: _Ring
    start: int
    span: int
    neighbour: int
    key: Key
    backwards: bool

    def corner(self, k: int) -> Corner:
        c = self.ring.corners[(self.start + k) % len(self.ring.corners)]
        return c % self.ring.w, c // self.ring.w

    def hits(self) -> bytes:
        direct, a, n = self.ring.direct, self.start, len(self.ring.direct)
        end = a + self.span
        return bytes(direct[a:end] if end <= n else direct[a:] + direct[: end - n])


@dataclass(slots=True)
class _Part:
    first: int
    size: int
    runs: list[tuple[int, int]]


def _positions(mask: bytes, base: int) -> Iterator[int]:
    i = mask.find(1)
    while i >= 0:
        yield base + i
        i = mask.find(1, i + 1)


def _frontier(cells: bytearray, w: int, h: int) -> dict[int, bytes]:
    out: dict[int, bytes] = {}
    for y in range(1, h - 1):
        row = cells[y * w : (y + 1) * w]
        labelled = int.from_bytes(row.translate(LABELLED))
        if not labelled:
            continue
        side = int.from_bytes(row.translate(OPEN))
        up = int.from_bytes(cells[(y - 1) * w : y * w].translate(OPEN))
        down = int.from_bytes(cells[(y + 1) * w : (y + 2) * w].translate(OPEN))
        edge = labelled & (up | down | (side << 8) | (side >> 8))
        if edge:
            out[y] = (int.from_bytes(row) & edge * 255).to_bytes(w)
    return out


def _claim(row: bytearray, near: list[bytes], label: int, lo: int, hi: int) -> int:
    mask = SELECT[label]
    seen = 0
    for r in near:
        seen |= int.from_bytes(r[lo:hi].translate(mask))
    taken = (seen | seen << 8 | seen >> 8) & int.from_bytes(row[lo:hi].translate(VACANT))
    if taken:
        row[lo:hi] = (int.from_bytes(row[lo:hi]) | taken * label).to_bytes(hi - lo)
    return taken * label


def _grow(cells: bytearray, w: int, h: int, steps: int, budget: Budget) -> bytearray:
    grown = cells.translate(UNWALLED)
    frontier = _frontier(cells, w, h)
    for _ in range(steps):
        budget.check()
        claimed: dict[int, bytes] = {}
        for y in sorted({y + d for y in frontier for d in (-1, 0, 1)}):
            near = [r for r in (frontier.get(y - 1), frontier.get(y), frontier.get(y + 1)) if r is not None]
            labels = set(b"".join(r.translate(None, b"\0") for r in near))
            row = grown[y * w : (y + 1) * w]
            if len(labels) == 1:
                new = _claim(row, near, labels.pop(), 0, w)
                if new:
                    grown[y * w : (y + 1) * w] = row
                    claimed[y] = new.to_bytes(w)
                continue
            total = 0
            for label in sorted(labels):
                ends = [(r.find(label), r.rfind(label)) for r in near]
                lo = max(0, min(a for a, _ in ends if a >= 0) - 1)
                hi = min(w, max(b for _, b in ends) + 2)
                total |= _claim(row, near, label, lo, hi) << 8 * (w - hi)
            if total:
                grown[y * w : (y + 1) * w] = row
                claimed[y] = total.to_bytes(w)
        frontier = claimed
    return grown


def _parts(grown: bytearray, w: int, budget: Budget) -> dict[int, list[_Part]]:
    starts, ends, labels, parent = array("q"), array("q"), bytearray(), array("q")
    previous: list[int] = []
    current: list[int] = []
    row = k = -1

    def find(i: int) -> int:
        root = i
        while parent[root] != root:
            root = parent[root]
        while parent[i] != root:
            parent[i], i = root, parent[i]
        return root

    for n, match in enumerate(LABEL_RUN.finditer(grown)):
        if not n % CHECK_EVERY:
            budget.check()
        s, e = match.span()
        y = s // w
        if y != row:
            previous = current if y == row + 1 else []
            current = []
            row = y
            k = 0
        label = grown[s]
        starts.append(s)
        ends.append(e)
        labels.append(label)
        parent.append(n)
        current.append(n)
        top, bottom = s - w, e - w
        while k < len(previous) and ends[previous[k]] <= top:
            k += 1
        q = k
        while q < len(previous) and starts[previous[q]] < bottom:
            other = previous[q]
            if labels[other] == label:
                a, b = find(other), find(n)
                if a != b:
                    parent[max(a, b)] = min(a, b)
            q += 1
    groups: dict[int, _Part] = {}
    for n in range(len(starts)):
        root = find(n)
        s, e = starts[n], ends[n]
        part = groups.get(root)
        if part is None:
            groups[root] = _Part(first=s, size=e - s, runs=[(s, e)])
        else:
            part.size += e - s
            part.runs.append((s, e))
    out: dict[int, list[_Part]] = {}
    for root, part in groups.items():
        out.setdefault(labels[root], []).append(part)
    for parts in out.values():
        parts.sort(key=lambda p: (-p.size, p.first))
    return out


def _trace(grown: bytearray, cells: bytearray, w: int, label: int, start: int, budget: Budget) -> list[_Run]:
    def offset(qx: int, qy: int) -> int:
        return (0 if qx > 0 else -1) + (0 if qy > 0 else -w)

    same = [offset(dx - dy, dy + dx) for dx, dy in DIRS]
    other_of = [offset(dx + dy, dy - dx) for dx, dy in DIRS]
    move = [dx + dy * w for dx, dy in DIRS]
    corner, d = start, 0
    corners = array("q")
    neighbours = bytearray()
    direct = bytearray()
    while True:
        if not len(corners) % CHECK_EVERY:
            budget.check()
        corners.append(corner)
        other = grown[corner + other_of[d]]
        neighbours.append(other)
        direct.append(other >= FIRST and cells[corner + same[d]] == label and cells[corner + other_of[d]] == other)
        corner += move[d]
        if grown[corner + same[d]] != label:
            d = (d + 1) & 3
        elif grown[corner + other_of[d]] == label:
            d = (d + 3) & 3
        if corner == start and d == 0:
            break
    n = len(corners)
    ring = _Ring(corners=corners, direct=direct, w=w)
    steps = array("q", map(operator.sub, corners[1:] + corners[:1], corners, strict=True))
    turns = list(itertools.compress(range(n), map(operator.ne, steps[-1:] + steps[:-1], steps, strict=True)))

    def point(i: int) -> Corner:
        c = corners[i % n]
        return c % w, c // w

    splits = list(
        itertools.compress(range(n), map(operator.ne, neighbours[-1:] + neighbours[:-1], neighbours, strict=True))
    )
    if not splits:
        fx, fy = point(0)
        far = max(turns, key=lambda i: (point(i)[0] - fx) ** 2 + (point(i)[1] - fy) ** 2, default=0)
        splits = [0, far] if far else [0]
    runs = []
    for k, a in enumerate(splits):
        b = splits[(k + 1) % len(splits)]
        span = (b - a) % n or n
        lo = bisect.bisect_right(turns, a)
        inside = turns[lo : bisect.bisect_left(turns, a + span)]
        if a + span > n:
            inside += [t + n for t in turns[: bisect.bisect_left(turns, a + span - n)]]
        key, backwards = _canonical([point(a), *(point(t) for t in inside), point(a + span)])
        runs.append(_Run(ring=ring, start=a, span=span, neighbour=neighbours[a], key=key, backwards=backwards))
    return runs


def _farthest(points: Sequence[Corner], a: int, b: int) -> tuple[float, int]:
    (ax, ay), (bx, by) = points[a], points[b]
    dx, dy = bx - ax, by - ay
    best, index = -1, -1
    if dx or dy:
        for i in range(a + 1, b):
            px, py = points[i]
            cross = abs(dy * (px - ax) - dx * (py - ay))
            if cross > best:
                best, index = cross, i
        return best / math.hypot(dx, dy), index
    for i in range(a + 1, b):
        px, py = points[i]
        far = (px - ax) ** 2 + (py - ay) ** 2
        if far > best:
            best, index = far, i
    return math.sqrt(best), index


def _simplify(points: Sequence[Corner], eps: float, cap: int = MAX_ROOM_VERTICES) -> tuple[list[Corner], float]:
    n = len(points)
    if n < 3:
        return list(points), 0.0
    keep = bytearray(n)
    keep[0] = keep[-1] = 1
    dist, index = _farthest(points, 0, n - 1)
    heap = [(-dist, 0, index, n - 1)]
    kept = 2
    while heap and -heap[0][0] > eps and kept < cap:
        _, a, i, b = heapq.heappop(heap)
        keep[i] = 1
        kept += 1
        for lo, hi in ((a, i), (i, b)):
            if hi - lo > 1:
                dist, index = _farthest(points, lo, hi)
                heapq.heappush(heap, (-dist, lo, index, hi))
    return [p for p, k in zip(points, keep, strict=True) if k], -heap[0][0] if heap else 0.0


def _canonical(points: list[Corner]) -> tuple[tuple[Corner, ...], bool]:
    forward = tuple(points)
    backward = forward[::-1]
    return (forward, False) if forward <= backward else (backward, True)


class _Classes:
    def __init__(self) -> None:
        self.parent: dict[Corner, Corner] = {}

    def find(self, p: Corner) -> Corner:
        root = self.parent.setdefault(p, p)
        while self.parent[root] != root:
            root = self.parent[root]
        while p != root:
            self.parent[p], p = root, self.parent[p]
        return root

    def union(self, a: Corner, b: Corner) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)

    def means(self, axis: int) -> dict[Corner, float]:
        groups: dict[Corner, list[Corner]] = {}
        for p in list(self.parent):
            groups.setdefault(self.find(p), []).append(p)
        out: dict[Corner, float] = {}
        for members in groups.values():
            value = sum(p[axis] for p in members) / len(members)
            out.update(dict.fromkeys(members, value))
        return out


def _snap(chains: Sequence[list[Corner]], tolerance: float) -> dict[Corner, tuple[float, float]]:
    xs, ys = _Classes(), _Classes()
    for chain in chains:
        for (ax, ay), (bx, by) in itertools.pairwise(chain):
            dx, dy = abs(bx - ax), abs(by - ay)
            if dy <= tolerance and dx > dy:
                ys.union((ax, ay), (bx, by))
            elif dx <= tolerance and dy > dx:
                xs.union((ax, ay), (bx, by))
    mx, my = xs.means(0), ys.means(1)
    return {p: (mx.get(p, float(p[0])), my.get(p, float(p[1]))) for chain in chains for p in chain}


Chains = dict[Key, list[tuple[float, float]]]
Polygons = dict[int, list[tuple[float, float]]]


class _Shapes:
    def __init__(self, traced: Mapping[int, list[_Run]], budget: Budget) -> None:
        self.traced = traced
        self.budget = budget
        self.rooms_of: dict[Key, set[int]] = {}
        for k, runs in traced.items():
            for run in runs:
                self.rooms_of.setdefault(run.key, set()).add(k)
        self.simple: dict[Key, list[Corner]] = {}
        self.error: dict[Key, float] = {}
        self.snapped: dict[Corner, tuple[float, float]] = {}
        self.chains: Chains = {}

    def simplify(self, eps: float, cap: int) -> bool:
        capped = False
        for key in self.rooms_of:
            self.budget.check()
            self.simple[key], self.error[key] = _simplify(key, eps, cap)
            capped |= self.error[key] > eps
        return capped

    def settle(self, snap: float) -> Polygons:
        self.snapped = _snap(list(self.simple.values()), snap)
        self.chains = {key: self.chain(points) for key, points in self.simple.items()}
        return {k: self.polygon(k, self.chains) for k in self.traced}

    def chain(self, points: list[Corner]) -> list[tuple[float, float]]:
        return _clean([self.snapped[p] for p in points], closed=False)

    def polygon(self, k: int, chains: Mapping[Key, list[tuple[float, float]]]) -> list[tuple[float, float]]:
        outline: list[tuple[float, float]] = []
        for run in self.traced[k]:
            chain = chains[run.key]
            outline.extend((chain[::-1] if run.backwards else chain)[:-1])
        return _clean(outline, closed=True)

    def build(self) -> tuple[Chains, Polygons, dict[int, float]]:
        eps = SIMPLIFY_PX
        self.simplify(eps, MAX_ROOM_VERTICES)
        polygons = self.settle(SNAP_PX)
        if self.crossing(polygons):
            eps = 0.0
            capped = self.simplify(eps, MAX_ROOM_VERTICES)
            polygons = self.settle(0.0)
            if capped and self.crossing(polygons):
                self.simplify(eps, MAX_CELLS)
                polygons = self.settle(0.0)
        blocked: set[int] = set()
        tolerance = SIMPLIFY_PX
        while tolerance < COARSEST_PX:
            crowded = sorted(k for k, p in polygons.items() if len(p) > MAX_ROOM_VERTICES and k not in blocked)
            if not crowded:
                break
            tolerance *= 2
            for k in crowded:
                keys = {run.key for run in self.traced[k]}
                simple = {key: _simplify(self.simple[key], tolerance, MAX_CELLS) for key in keys}
                chains = {key: self.chain(points) for key, (points, _) in simple.items()}
                trial = {r: self.polygon(r, self.chains | chains) for key in keys for r in self.rooms_of[key]}
                if self.crossing(trial):
                    blocked.add(k)
                    continue
                for key, (points, error) in simple.items():
                    self.simple[key] = points
                    self.error[key] = max(self.error[key], error)
                self.chains.update(chains)
                polygons.update(trial)
        coarse: dict[int, float] = {}
        for key, error in self.error.items():
            if error > eps:
                for k in self.rooms_of[key]:
                    coarse[k] = max(coarse.get(k, 0.0), error)
        return self.chains, polygons, coarse

    def crossing(self, polygons: Mapping[int, list[tuple[float, float]]]) -> bool:
        for polygon in polygons.values():
            self.budget.check()
            if _crossing(polygon):
                return True
        return False


def _crossing(polygon: Sequence[tuple[float, float]]) -> bool:
    def side(p: tuple[float, float], q: tuple[float, float], r: tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    n = len(polygon)
    if n < 4:
        return False
    edges = [(polygon[i], polygon[(i + 1) % n]) for i in range(n)]
    boxes = [(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])) for a, b in edges]
    lo_x, lo_y = min(b[0] for b in boxes), min(b[1] for b in boxes)
    width = max(b[2] for b in boxes) - lo_x
    height = max(b[3] for b in boxes) - lo_y
    cell = max(math.sqrt(width * height / n) * 2, width / n, height / n, 1e-9)
    buckets: dict[tuple[int, int], list[int]] = {}
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        for cx in range(int((x0 - lo_x) / cell), int((x1 - lo_x) / cell) + 1):
            for cy in range(int((y0 - lo_y) / cell), int((y1 - lo_y) / cell) + 1):
                buckets.setdefault((cx, cy), []).append(i)
    for (cx, cy), members in buckets.items():
        for i, j in itertools.combinations(members, 2):
            if j - i == 1 or (i == 0 and j == n - 1):
                continue
            bi, bj = boxes[i], boxes[j]
            if bi[2] < bj[0] or bj[2] < bi[0] or bi[3] < bj[1] or bj[3] < bi[1]:
                continue
            if int((max(bi[0], bj[0]) - lo_x) / cell) != cx or int((max(bi[1], bj[1]) - lo_y) / cell) != cy:
                continue
            (a, b), (c, d) = edges[i], edges[j]
            if side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0:
                return True
    return False


def _collinear(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> bool:
    return abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-9


def _clean(points: list[tuple[float, float]], closed: bool) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for p in points:
        if out and p == out[-1]:
            continue
        out.append(p)
        while len(out) >= 3 and _collinear(out[-3], out[-2], out[-1]):
            del out[-2]
    if not closed:
        return out
    start = 0
    changed = True
    while changed and len(out) - start >= 3:
        changed = False
        if out[start] == out[-1] or _collinear(out[-2], out[-1], out[start]):
            out.pop()
            changed = True
        elif _collinear(out[-1], out[start], out[start + 1]):
            start += 1
            changed = True
    return out[start:]


def _area(points: Sequence[tuple[float, float]]) -> float:
    return (
        sum(
            points[i][0] * points[(i + 1) % len(points)][1] - points[(i + 1) % len(points)][0] * points[i][1]
            for i in range(len(points))
        )
        / 2
    )


def _project(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dy * dy
    t = 0.0 if length == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length))
    return t, math.dist(p, (a[0] + t * dx, a[1] + t * dy))


def _openings(run: _Run) -> list[tuple[tuple[float, float], int]]:
    groups: list[list[int]] = []
    for i in _positions(run.hits(), 0):
        if groups and i - groups[-1][1] <= DOOR_GAP_PX + 1:
            groups[-1][1] = i
        else:
            groups.append([i, i])
    out = []
    for first, last in groups:
        length = last - first + 1
        middle = first + length / 2
        k = int(middle)
        a, b = run.corner(k), run.corner(min(k + 1, run.span))
        f = middle - k
        out.append(((a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])), length))
    return out


def _rects(classes: bytearray, w: int, h: int) -> Iterator[tuple[int, int, int, int, int]]:
    open_rects: dict[tuple[int, int, int], list[int]] = {}
    y = 0
    while y < h:
        row = classes[y * w : (y + 1) * w]
        last = y
        while last + 1 < h and classes[(last + 1) * w : (last + 2) * w] == row:
            last += 1
        for match in CLASS_RUN.finditer(row):
            s, e = match.span()
            key = (s, e - s, row[s])
            span = open_rects.get(key)
            if span is not None and span[1] == y - 1:
                span[1] = last
                continue
            if span is not None:
                yield (*key, span[0], span[1] - span[0] + 1)
            open_rects[key] = [y, last]
        y = last + 1
    for key, span in open_rects.items():
        yield (*key, span[0], span[1] - span[0] + 1)


def _svg(cells: bytearray, w: int, h: int) -> bytes | None:
    paths: dict[int, list[str]] = {1: [], 2: []}
    size = 0
    for x, width, kind, y, height in _rects(cells.translate(CLASSES), w, h):
        path = f"M{x} {y}h{width}v{height}h-{width}z"
        paths[kind].append(path)
        size += len(path)
        if size > MAX_SVG_BYTES:
            return None
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}" shape-rendering="crispEdges">'
        f'<path fill="#9aa0a6" fill-opacity="0.35" d="{"".join(paths[1])}"/>'
        f'<path fill="#5f6368" d="{"".join(paths[2])}"/></svg>'
    ).encode()
    return svg if len(svg) <= MAX_SVG_BYTES else None


def parse(vmap: ValetudoMap, budget: Budget | None = None) -> Parsed:
    budget = budget or Budget()
    m = vmap.pixel_cm / 100
    steps = min(MAX_GROW_PX, max(0, round(GROW_M / m)))
    grid = Grid(vmap, steps + 2)
    for layer in vmap.floor:
        grid.fill(layer, FLOOR)
    for seg in vmap.segments:
        grid.fill(seg.runs, FLOOR)
    for layer in vmap.wall:
        grid.fill(layer, WALL)
    cells, w, h = grid.cells, grid.w, grid.h
    svg = _svg(cells, w, h)
    budget.check()
    out = Parsed(Backdrop(svg=svg, x=round(grid.x0 * m, 3), y=round(grid.y0 * m, 3), m_per_px=m))
    if svg is None:
        out.warnings.append({"code": "background_dropped", "params": {"limit_mb": MAX_SVG_BYTES // (1024 * 1024)}})
    kept: list[Segment] = []
    for seg in vmap.segments:
        area = sum(seg.runs[2::3]) * m * m
        if area < MIN_ROOM_M2:
            out.warnings.append(_dropped(seg, area))
        else:
            kept.append(seg)
    for k, seg in enumerate(kept):
        grid.fill(seg.runs, FIRST + k)
    budget.check()
    grown = _grow(cells, w, h, steps, budget)
    parts = _parts(grown, w, budget)
    traced: dict[int, list[_Run]] = {}
    for k, seg in enumerate(kept):
        label = FIRST + k
        found = parts.get(label, [])
        drop = bytes(range(256)).replace(bytes([label]), bytes([FLOOR]))
        for part in found[1:]:
            original = 0
            for s, e in part.runs:
                original += cells.count(label, s, e)
                grown[s:e] = bytes(e - s)
                cells[s:e] = cells[s:e].translate(drop)
            if original * m * m >= MIN_PART_M2:
                out.warnings.append(_dropped(seg, original * m * m))
        if found:
            traced[k] = _trace(grown, cells, w, label, found[0].first, budget)
    chains, polygons, coarse = _Shapes(traced, budget).build()

    def metres(p: tuple[float, float]) -> Point:
        return round((p[0] + grid.x0) * m, 3), round((p[1] + grid.y0) * m, 3)

    taken: set[str] = set()
    ids: dict[int, str] = {}
    for k, seg in enumerate(kept):
        if k not in traced:
            continue
        polygon = polygons[k]
        if len(polygon) < 3 or abs(_area(polygon)) * m * m < MIN_ROOM_M2:
            out.warnings.append(_dropped(seg, abs(_area(polygon)) * m * m if len(polygon) >= 3 else 0.0))
            continue
        name = seg.name or f"Room {seg.key}"
        ids[k] = slug(name, taken)
        out.rooms.append(
            Room(
                id=ids[k],
                name=name,
                outline=tuple(metres(p) for p in polygon),
                colour=COLOURS[len(out.rooms) % len(COLOURS)],
            )
        )
    for k, tolerance in coarse.items():
        if k in ids:
            out.warnings.append(
                {
                    "code": "room_simplified",
                    "params": {"room": ids[k], "vertices": len(polygons[k]), "tolerance_m": round(tolerance * m, 2)},
                }
            )
    done: set[Key] = set()
    pairs: dict[frozenset[str], tuple[str, str]] = {}
    for k, runs in traced.items():
        for run in runs:
            other = run.neighbour - FIRST
            if run.key in done or k not in ids or other not in ids:
                continue
            done.add(run.key)
            chain = chains[run.key][::-1] if run.backwards else chains[run.key]
            first_wall = len(out.walls)
            segments = [(a, b) for a, b in itertools.pairwise(chain) if a != b]
            out.walls.extend(Wall(a=metres(a), b=metres(b), kind="partition") for a, b in segments)
            for centre, length in _openings(run):
                if length * m < MIN_DOOR_M or not segments:
                    continue
                best = min(range(len(segments)), key=lambda i: _project(centre, *segments[i])[1])
                a, b = segments[best]
                t, _ = _project(centre, a, b)
                width = round(min(length * m, math.dist(a, b) * m), 2)
                out.doors.append(
                    Door(
                        wall=first_wall + best,
                        at=round(t, 4),
                        width=width,
                        kind="opening" if width >= OPENING_M else "door",
                    )
                )
                pairs.setdefault(frozenset((ids[k], ids[other])), (ids[k], ids[other]))
    out.adjacent = list(pairs.values())
    return out


def _dropped(seg: Segment, area: float) -> Warning:
    return {"code": "dropped_segment", "params": {"segment": seg.key, "name": seg.name, "area_m2": round(area, 2)}}
