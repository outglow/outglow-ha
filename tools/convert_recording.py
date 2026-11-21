import argparse
import sys
from collections.abc import Iterable, Iterator
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import recording
from engine.types import Header, Plan, Record, Settings


def convert(lines: Iterable[str], plan: Plan | None = None, settings: Settings | None = None) -> Iterator[str]:
    records = recording.read(lines)
    first = next(records, None)
    if first is None:
        return
    source = first if isinstance(first, Header) else Header()
    header = Header(
        plan=plan or source.plan,
        settings=settings or source.settings,
        created=source.created,
        generator=f"tools/convert_recording.py from format {source.format}",
    )
    rest: Iterable[Record] = records if isinstance(first, Header) else [first, *records]
    yield from recording.write([header, *rest])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Convert an Outglow recording (format 1 or 2) to format 2")
    parser.add_argument("input", type=Path)
    args = parser.parse_args(argv)
    with args.input.open() as f:
        for line in convert(f):
            sys.stdout.write(line + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
