import types
from collections.abc import Mapping
from dataclasses import fields, is_dataclass
from typing import Any, Literal, Union, get_args, get_origin, get_type_hints

from .types import Json


class CodecError(ValueError):
    pass


def json_name(f: Any) -> str:
    return str(f.metadata.get("json", f.name))


def to_json(value: object) -> Json:
    if is_dataclass(value) and not isinstance(value, type):
        return {json_name(f): to_json(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, frozenset):
        return [str(v) for v in sorted(value)]
    if isinstance(value, tuple | list):
        return [to_json(v) for v in value]
    if isinstance(value, Mapping):
        return {str(k): to_json(v) for k, v in value.items()}
    if value is None or isinstance(value, bool | int | float | str):
        return value
    raise CodecError(f"cannot encode {type(value).__name__}")


def from_json[T](tp: type[T], data: object) -> T:
    result: T = _decode(tp, data, "$")
    return result


def _decode(tp: Any, data: object, path: str) -> Any:
    origin = get_origin(tp)
    if is_dataclass(tp):
        return _decode_dataclass(tp, data, path)
    if origin is Literal:
        return _decode_literal(get_args(tp), data, path)
    if origin is Union or origin is types.UnionType:
        return _decode_union(get_args(tp), data, path)
    if origin is tuple:
        return _decode_tuple(get_args(tp), data, path)
    if origin is frozenset:
        return frozenset(_decode(get_args(tp)[0], v, path) for v in _expect(list, data, path))
    if origin is dict:
        value_type = get_args(tp)[1]
        return {str(k): _decode(value_type, v, f"{path}.{k}") for k, v in _expect(dict, data, path).items()}
    return _decode_scalar(tp, data, path)


def _expect[T](kind: type[T], data: object, path: str) -> T:
    if not isinstance(data, kind):
        raise CodecError(f"{path}: expected {kind.__name__}, got {type(data).__name__}")
    return data


def _decode_dataclass(tp: Any, data: object, path: str) -> Any:
    obj = _expect(dict, data, path)
    hints = get_type_hints(tp)
    known = {json_name(f): f for f in fields(tp)}
    unknown = sorted(set(obj) - set(known))
    if unknown:
        raise CodecError(f"{path}: unknown field {unknown[0]}")
    kwargs = {f.name: _decode(hints[f.name], obj[key], f"{path}.{key}") for key, f in known.items() if key in obj}
    try:
        return tp(**kwargs)
    except TypeError as err:
        raise CodecError(f"{path}: {err}") from err


def _decode_literal(options: tuple[Any, ...], data: object, path: str) -> Any:
    for option in options:
        if type(option) is type(data) and option == data:
            return data
    raise CodecError(f"{path}: {data!r} is not one of {list(options)}")


def _decode_union(options: tuple[Any, ...], data: object, path: str) -> Any:
    if data is None and type(None) in options:
        return None
    errors = []
    for option in options:
        if option is type(None):
            continue
        try:
            return _decode(option, data, path)
        except CodecError as err:
            errors.append(str(err))
    raise CodecError("; ".join(errors))


def _decode_tuple(args: tuple[Any, ...], data: object, path: str) -> tuple[Any, ...]:
    items = _expect(list, data, path)
    if len(args) == 2 and args[1] is Ellipsis:
        return tuple(_decode(args[0], v, f"{path}[{i}]") for i, v in enumerate(items))
    if len(items) != len(args):
        raise CodecError(f"{path}: expected {len(args)} items, got {len(items)}")
    return tuple(_decode(a, v, f"{path}[{i}]") for i, (a, v) in enumerate(zip(args, items, strict=True)))


def _decode_scalar(tp: Any, data: object, path: str) -> Any:
    if tp is float and isinstance(data, int | float) and not isinstance(data, bool):
        return float(data)
    if tp is int and isinstance(data, int) and not isinstance(data, bool):
        return data
    if tp in (str, bool) and type(data) is tp:
        return data
    raise CodecError(f"{path}: expected {getattr(tp, '__name__', tp)}, got {type(data).__name__}")
