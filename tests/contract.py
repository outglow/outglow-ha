import json
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent.parent
SCHEMAS = ROOT / "docs" / "schemas"
WS_FIXTURES = ROOT / "tests" / "fixtures" / "ws"
RECORDINGS = ROOT / "tests" / "fixtures" / "recordings"


@cache
def schema_files() -> dict[str, dict[str, Any]]:
    return {p.name: json.loads(p.read_text()) for p in sorted(SCHEMAS.glob("*.json")) if p.name != "commands.json"}


@cache
def commands() -> dict[str, dict[str, Any]]:
    data: dict[str, dict[str, Any]] = json.loads((SCHEMAS / "commands.json").read_text())["commands"]
    return data


@cache
def registry() -> Registry:
    resources = [(name, Resource.from_contents(body)) for name, body in schema_files().items()]
    return Registry().with_resources(resources)


def validator(ref: str) -> Draft202012Validator:
    schema = {"type": "null"} if ref == "null" else {"$ref": ref}
    return Draft202012Validator(schema, registry=registry())


def validate(ref: str, instance: object) -> None:
    validator(ref).validate(instance)


def fixture_path(command: str) -> Path:
    return WS_FIXTURES / (command.removeprefix("outglow/").replace("/", "_") + ".json")


def ws_fixture(command: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(fixture_path(command).read_text())
    return data


def resolve(schema: dict[str, Any], file: str) -> tuple[dict[str, Any], str]:
    while "$ref" in schema:
        target, _, pointer = schema["$ref"].partition("#")
        file = target or file
        node: Any = schema_files()[file]
        for part in pointer.strip("/").split("/") if pointer else []:
            node = node[part]
        schema = node
    return schema, file
