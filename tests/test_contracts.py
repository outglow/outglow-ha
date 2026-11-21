import dataclasses
import json
import types
import typing

import pytest
from jsonschema import Draft202012Validator

from engine import codec, from_json, to_json
from engine import types as et
from tests.contract import RECORDINGS, WS_FIXTURES, commands, resolve, schema_files, validate, ws_fixture
from tools import contracts

DATACLASS_SCHEMAS = {
    et.Plan: "plan.json",
    et.Background: "plan.json#/$defs/Background",
    et.Room: "plan.json#/$defs/Room",
    et.Wall: "plan.json#/$defs/Wall",
    et.Door: "plan.json#/$defs/Door",
    et.PlanBulb: "plan.json#/$defs/PlanBulb",
    et.ExcludedDirection: "plan.json#/$defs/ExcludedDirection",
    et.Settings: "settings.json",
    et.RoomSettings: "settings.json#/$defs/RoomSettings",
    et.GlobalSettings: "settings.json#/$defs/GlobalSettings",
    et.Retention: "settings.json#/$defs/Retention",
    et.Frame: "frame.json",
    et.DirectionFrame: "frame.json#/$defs/DirectionFrame",
    et.PairFrame: "frame.json#/$defs/PairFrame",
    et.RoomFrame: "frame.json#/$defs/RoomFrame",
    et.Veto: "frame.json#/$defs/Veto",
    et.QualityReport: "quality.json",
    et.RoomQuality: "quality.json#/$defs/RoomQuality",
    et.DirectionQuality: "quality.json#/$defs/DirectionQuality",
    et.PairQuality: "quality.json#/$defs/PairQuality",
    et.Recommendation: "quality.json#/$defs/Recommendation",
    et.Label: "recording.json#/$defs/Label",
    et.LightState: "recording.json#/$defs/LightStateRecord",
    et.HistoryEvent: "history.json#/$defs/HistoryEvent",
}


@pytest.mark.parametrize("name", sorted(schema_files()))
def test_schema_is_valid(name: str) -> None:
    Draft202012Validator.check_schema(schema_files()[name])


def test_every_command_has_a_fixture_and_back() -> None:
    expected = {f"{c.removeprefix('outglow/').replace('/', '_')}.json" for c in commands()}
    assert {p.name for p in WS_FIXTURES.glob("*.json")} == expected


@pytest.mark.parametrize("command", sorted(commands()))
def test_fixture_matches_schema(command: str) -> None:
    spec = commands()[command]
    fixture = ws_fixture(command)
    assert fixture["command"] == command
    assert set(fixture) <= {"command", "request", "response", "events", "errors"}
    validate(spec["request"], fixture["request"])
    validate(spec["response"], fixture["response"])
    if "event" in spec:
        assert fixture["events"]
        for event in fixture["events"]:
            validate(spec["event"], event)
    else:
        assert "events" not in fixture
    for error in fixture.get("errors", []):
        validate("error.json", error)


def test_generated_files_are_current() -> None:
    assert contracts.main(["--check"]) == 0


def _literals(tp: object) -> set[object] | None:
    origin = typing.get_origin(tp)
    if origin is typing.Literal:
        return set(typing.get_args(tp))
    for arg in typing.get_args(tp) if origin in (typing.Union, types.UnionType, tuple, dict) else ():
        found = _literals(arg)
        if found is not None:
            return found
    return None


def _enum(schema: dict[str, typing.Any], file: str) -> set[object] | None:
    schema, file = resolve(schema, file)
    if "enum" in schema:
        return set(schema["enum"])
    if "const" in schema:
        return {schema["const"]}
    for key in ("oneOf", "anyOf"):
        for option in schema.get(key, []):
            found = _enum(option, file)
            if found is not None:
                return found
    for key in ("items", "additionalProperties"):
        if isinstance(schema.get(key), dict):
            return _enum(schema[key], file)
    return None


@pytest.mark.parametrize("cls", list(DATACLASS_SCHEMAS), ids=lambda c: c.__name__)
def test_dataclass_mirrors_schema(cls: type) -> None:
    schema, file = resolve({"$ref": DATACLASS_SCHEMAS[cls]}, "")
    names = {codec.json_name(f): f for f in dataclasses.fields(cls)}
    assert set(names) == set(schema["properties"])
    assert set(schema["required"]) == set(names)
    assert schema["additionalProperties"] is False
    hints = typing.get_type_hints(cls)
    for key, f in names.items():
        expected = _literals(hints[f.name])
        if expected is not None:
            assert _enum(schema["properties"][key], file) == expected, key


@pytest.mark.parametrize(
    ("cls", "ref"),
    [
        (et.Plan, "plan.json"),
        (et.Settings, "settings.json"),
        (et.Frame, "frame.json"),
        (et.QualityReport, "quality.json"),
    ],
)
def test_default_instance_validates(cls: type, ref: str) -> None:
    required = {
        f.name: 0
        for f in dataclasses.fields(cls)
        if f.default is dataclasses.MISSING and f.default_factory is dataclasses.MISSING
    }
    if "days" in required:
        required["days"] = 1
    validate(ref, to_json(cls(**required)))


@pytest.mark.parametrize(
    ("command", "path", "cls"),
    [
        ("outglow/plan/get", ("response", "plan"), et.Plan),
        ("outglow/settings/get", ("response",), et.Settings),
        ("outglow/quality", ("response",), et.QualityReport),
        ("outglow/live/subscribe", ("events", 0, "frame"), et.Frame),
        ("outglow/history/frames", ("response", "frames", 0), et.Frame),
    ],
)
def test_fixture_round_trips_through_dataclass(command: str, path: tuple[object, ...], cls: type) -> None:
    node: typing.Any = ws_fixture(command)
    for part in path:
        node = node[part]
    assert to_json(from_json(cls, node)) == node


@pytest.mark.parametrize("name", sorted(p.name for p in RECORDINGS.glob("*_v2.jsonl")))
def test_v2_recording_lines_validate(name: str) -> None:
    lines = (RECORDINGS / name).read_text().splitlines()
    assert json.loads(lines[0])["type"] == "header"
    for line in lines:
        validate("recording.json", json.loads(line))
