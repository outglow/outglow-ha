from dataclasses import dataclass, field
from typing import Literal

import pytest

from engine import CodecError, from_json, to_json
from engine.types import Context, Frame, HistoryEvent, PairFrame, Plan, Room, Settings


@dataclass(frozen=True)
class Pair:
    xy: tuple[int, str]
    tag: Literal[0, "a"] = 0
    alias: int = field(default=0, metadata={"json": "other"})


def test_settings_round_trip_uses_the_json_name_of_global() -> None:
    data = to_json(Settings())
    assert isinstance(data, dict)
    assert "global" in data
    assert from_json(Settings, data) == Settings()


def test_ints_become_floats_and_tuples_lists() -> None:
    plan = from_json(Plan, {"rooms": [{"id": "a", "name": "A", "outline": [[0, 0], [1, 0], [1, 1]]}]})
    assert plan.rooms == (Room(id="a", name="A", outline=((0.0, 0.0), (1.0, 0.0), (1.0, 1.0))),)
    assert isinstance(plan.rooms[0].outline[0][0], float)
    assert to_json(plan.rooms[0].outline) == [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0]]


def test_frozensets_encode_sorted() -> None:
    ctx = Context(t=1.0, persons_home=frozenset({"person.b", "person.a"}))
    data = to_json(ctx)
    assert isinstance(data, dict)
    assert data["persons_home"] == ["person.a", "person.b"]
    assert from_json(Context, data) == ctx


def test_scalar_union_keeps_types() -> None:
    event = from_json(
        HistoryEvent, {"t": 1, "kind": "label", "data": {"a": True, "b": 2, "c": 2.5, "d": "x", "e": None}}
    )
    assert event.data == {"a": True, "b": 2, "c": 2.5, "d": "x", "e": None}
    assert type(event.data["b"]) is int


def test_fixed_tuple_and_literal_and_alias() -> None:
    value = from_json(Pair, {"xy": [1, "b"], "tag": "a", "other": 3})
    assert value == Pair(xy=(1, "b"), tag="a", alias=3)
    assert to_json(value) == {"xy": [1, "b"], "tag": "a", "other": 3}


def test_optional_none() -> None:
    assert from_json(PairFrame, {"a": "x", "b": "y", "obs": None}).obs is None
    assert from_json(PairFrame, {"a": "x", "b": "y", "obs": 2}).obs == 2


@pytest.mark.parametrize(
    ("cls", "data", "message"),
    [
        (Pair, [], "expected dict"),
        (Pair, {"xy": [1, "b"], "nope": 1}, "unknown field nope"),
        (Pair, {}, "missing"),
        (Pair, {"xy": [1]}, "expected 2 items"),
        (Pair, {"xy": [True, "b"]}, "expected int"),
        (Pair, {"xy": [1, "b"], "tag": 1}, "is not one of"),
        (Pair, {"xy": [1, "b"], "tag": False}, "is not one of"),
        (PairFrame, {"a": "x", "b": "y", "obs": "2"}, "is not one of"),
        (Frame, {"t": True}, "expected float"),
        (Frame, {"t": 1, "rooms": []}, "expected dict"),
        (Context, {"t": 1, "persons_home": "x"}, "expected list"),
    ],
)
def test_decode_errors(cls: type, data: object, message: str) -> None:
    with pytest.raises(CodecError, match=message):
        from_json(cls, data)


def test_encode_rejects_unknown_objects() -> None:
    with pytest.raises(CodecError, match="cannot encode object"):
        to_json(object())
