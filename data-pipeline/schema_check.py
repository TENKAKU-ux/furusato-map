"""確定契約で使うJSON Schemaキーワードを標準ライブラリだけで検査する。"""

from datetime import date
import math
import re
from urllib.parse import urlsplit


def validate(value, schema, root=None, path="$"):
    if root is None:
        root = schema
    supported = {
        "$schema", "$defs", "$ref", "title", "description", "type", "const",
        "enum", "required", "properties", "additionalProperties", "items",
        "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength",
        "pattern", "format",
    }
    if set(schema) - supported:
        raise ValueError(f"未対応のSchemaキーワード: {set(schema) - supported}")

    def check(condition, message):
        if not condition:
            raise ValueError(f"{path}: {message}")

    if "$ref" in schema:
        ref = schema["$ref"]
        check(ref.startswith("#/$defs/"), "ローカル参照以外は未対応")
        validate(value, root["$defs"][ref.removeprefix("#/$defs/")], root, path)
    integer = type(value) is int or (
        type(value) is float and math.isfinite(value) and value.is_integer()
    )
    types = {
        "object": isinstance(value, dict), "array": isinstance(value, list),
        "string": isinstance(value, str), "integer": integer,
        "null": value is None,
    }
    if "type" in schema:
        allowed = schema["type"]
        allowed = [allowed] if isinstance(allowed, str) else allowed
        check(any(types[t] for t in allowed), f"型が不一致: {allowed}")
    if "const" in schema:
        check(value == schema["const"], "定数が不一致")
    if "enum" in schema:
        check(value in schema["enum"], "列挙値が不一致")
    if isinstance(value, dict):
        check(set(schema.get("required", [])) <= set(value), "必須キーの欠落")
        props = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            check(set(value) <= set(props), "未知のキー")
        for key, child in value.items():
            if key in props:
                validate(child, props[key], root, f"{path}.{key}")
    if isinstance(value, list):
        check(len(value) >= schema.get("minItems", 0), "配列が短い")
        check(len(value) <= schema.get("maxItems", math.inf), "配列が長い")
        if "items" in schema:
            for i, child in enumerate(value):
                validate(child, schema["items"], root, f"{path}[{i}]")
    if type(value) in (int, float):
        check(schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf), "数値範囲外")
    if isinstance(value, str):
        check(schema.get("minLength", 0) <= len(value) <= schema.get("maxLength", math.inf), "文字数範囲外")
        if "pattern" in schema:
            check(re.search(schema["pattern"], value) is not None, "文字列形式が不一致")
        if schema.get("format") == "date":
            try:
                check(date.fromisoformat(value).isoformat() == value, "日付形式が不一致")
            except ValueError as exc:
                raise ValueError(f"{path}: 不正な日付") from exc
        elif schema.get("format") == "uri":
            try:
                url = urlsplit(value)
                check(bool(url.scheme and url.hostname) and not any(c.isspace() for c in value), "不正なURI")
            except ValueError as exc:
                raise ValueError(f"{path}: 不正なURI") from exc
        elif "format" in schema:
            raise ValueError(f"未対応のformat: {schema['format']}")
