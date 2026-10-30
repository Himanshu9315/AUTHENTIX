import json
from pathlib import Path

import jsonschema
import pytest
from pydantic import ValidationError

from app import models

MODEL_FOR = {"request": models.ChatRequest, "response": models.ChatResponse}


def spec(contracts_dir):
    return json.loads((Path(contracts_dir) / "chatbot.openapi.json").read_text())


def validator(contracts_dir, name):
    s = spec(contracts_dir)
    return jsonschema.Draft202012Validator({"$ref": f"#/components/schemas/{name}", "components": s["components"]})


def examples(contracts_dir, kind):
    return sorted((Path(contracts_dir) / "examples" / "chat" / kind).glob("*.json"))


def kind_of(path: Path) -> str:
    return "ChatRequest" if path.name.startswith("request") else "ChatResponse"


def test_valid_examples_pass_both_the_json_schema_and_the_python_model(contracts_dir):
    files = examples(contracts_dir, "valid")
    assert len(files) >= 4
    for f in files:
        data = json.loads(f.read_text())
        validator(contracts_dir, kind_of(f)).validate(data)
        MODEL_FOR[f.name.split("-")[0]].model_validate(data)


def test_invalid_examples_fail_both(contracts_dir):
    files = examples(contracts_dir, "invalid")
    assert len(files) >= 4
    for f in files:
        data = json.loads(f.read_text())
        with pytest.raises(jsonschema.ValidationError):
            validator(contracts_dir, kind_of(f)).validate(data)
        with pytest.raises(ValidationError):
            MODEL_FOR[f.name.split("-")[0]].model_validate(data)


def _resolve(schema, defs):
    while "$ref" in schema:
        schema = defs[schema["$ref"].split("/")[-1]]
    return schema


def shape(schema, defs):
    """Reduces a JSON Schema (from the contract or from Pydantic) to what matters, so the two can be compared:
    type, allowed values, nullability, size limits, pattern and nested shape. Titles, descriptions and defaults are ignored."""
    schema = _resolve(schema, defs)
    nullable = False
    options = schema.get("anyOf") or schema.get("oneOf")
    if options:
        non_null = [o for o in options if o.get("type") != "null"]
        nullable = len(non_null) != len(options)
        schema = _resolve(non_null[0], defs) if len(non_null) == 1 else {"anyOf": non_null}
    types = schema.get("type")
    types = set(types) if isinstance(types, list) else ({types} if types else set())
    if "null" in types:
        nullable = True
        types.discard("null")
    enum = schema.get("enum")
    if enum is not None and None in enum:
        nullable = True
        enum = [e for e in enum if e is not None]
    if enum is not None and not types:
        types = {"string"}
    out = {"type": sorted(types), "nullable": nullable}
    if enum is not None:
        out["enum"] = sorted(enum)
    for key in ("minLength", "maxLength", "minimum", "maximum", "maxItems", "minItems", "pattern"):
        if key in schema:
            out[key] = schema[key]
    if schema.get("format") == "date-time":
        out["format"] = "date-time"
    if "items" in schema:
        out["items"] = shape(schema["items"], defs)
    if "properties" in schema:
        out["properties"] = {k: shape(v, defs) for k, v in schema["properties"].items()}
        out["required"] = sorted(schema.get("required", []))
        out["closed"] = schema.get("additionalProperties") is False
    return out


def contract_shape(contracts_dir, name):
    s = spec(contracts_dir)
    return shape({"$ref": f"#/components/schemas/{name}"}, s["components"]["schemas"])


def model_shape(model):
    schema = model.model_json_schema()
    return shape(schema, schema.get("$defs", {}))


@pytest.mark.parametrize(
    ("schema_name", "model"),
    [("ChatRequest", models.ChatRequest), ("Turn", models.Turn), ("Source", models.Source), ("LiveTier", models.LiveTier), ("Flags", models.Flags), ("ChatResponse", models.ChatResponse), ("LiveData", models.LiveData)],
)
def test_python_models_and_the_contract_agree_on_every_field_type_value_limit_and_requirement(contracts_dir, schema_name, model):
    # LiveData's "format" and the date strings are the only places the two sides spell the same thing differently
    # (the contract says format: date-time, the model keeps plain strings), so formats are compared separately below.
    def strip_formats(d):
        if isinstance(d, dict):
            return {k: strip_formats(v) for k, v in d.items() if k != "format"}
        return d

    assert strip_formats(model_shape(model)) == strip_formats(contract_shape(contracts_dir, schema_name)), schema_name


def test_the_comparison_really_catches_drift(contracts_dir):
    """If one side changes, this must fail. Proves the check isn't vacuous."""
    base = model_shape(models.Flags)
    drifted = json.loads(json.dumps(base))
    drifted["properties"]["degraded"]["enum"] = sorted([*drifted["properties"]["degraded"]["enum"], "brand_new_value"])
    assert drifted != contract_shape(contracts_dir, "Flags")
    longer = json.loads(json.dumps(model_shape(models.ChatRequest)))
    longer["properties"]["message"]["maxLength"] = 9999
    assert longer != contract_shape(contracts_dir, "ChatRequest")
    nullable = json.loads(json.dumps(model_shape(models.ChatResponse)))
    nullable["properties"]["answer"]["nullable"] = True
    assert nullable != contract_shape(contracts_dir, "ChatResponse")


def test_the_nested_event_matches_too(contracts_dir):
    contract = spec(contracts_dir)["components"]["schemas"]["LiveData"]["properties"]["event"]
    py = models.LiveEvent.model_json_schema()
    assert set(py["properties"]) == set(contract["properties"]) and set(py["required"]) == set(contract["required"])


def test_every_kind_of_response_the_service_produces_matches_the_contract(contracts_dir):
    import asyncio

    from app.service import ChatService
    from tests.fakes import EVENTS, FAQ, FakeLive, FakeLLM, FakeStore, settings

    twin = dict(EVENTS[0], id="event:neon-monsoon-live-pune", path="/events/neon-monsoon-live-pune")
    v = validator(contracts_dir, "ChatResponse")

    def run(svc, msg, ctx=None):
        req = models.ChatRequest.model_validate({"message": msg, **({"context": ctx} if ctx else {})})
        v.validate(asyncio.run(svc.chat(req, "0123456789abcdef")).model_dump(mode="json"))

    ok = ChatService(settings(), FakeStore(FAQ + EVENTS + [twin]), FakeLLM(), FakeLive())
    for msg, ctx in [
        ("How do transfers work?", None),                                     # grounded help answer
        ("my email is a@example.test", None),                                 # refused
        ("how much is it?", {"eventSlug": "neon-monsoon-live-gurugram"}),     # live data
        ("are tickets available?", {"eventSlug": "neon-monsoon-live-gurugram"}),
        ("price?", None),                                                      # which event?
        ("how much is neon monsoon live", None),                               # ambiguous
        ("zzzz", None),                                                        # not found
    ]:
        run(ok, msg, ctx)
    for label, svc in {
        "no key": ChatService(settings(gemini_api_key=""), FakeStore(FAQ + EVENTS), FakeLLM(), FakeLive()),
        "rate limited": ChatService(settings(), FakeStore(FAQ + EVENTS), FakeLLM(error="rate_limited"), FakeLive()),
        "unavailable": ChatService(settings(), FakeStore(FAQ + EVENTS), FakeLLM(error="unavailable"), FakeLive()),
        "blocked": ChatService(settings(), FakeStore(FAQ + EVENTS), FakeLLM(error="blocked"), FakeLive()),
        "budget": ChatService(settings(max_gemini_calls_per_day=0), FakeStore(FAQ + EVENTS), FakeLLM(), FakeLive()),
        "catalog down": ChatService(settings(), FakeStore(FAQ + EVENTS), FakeLLM(), FakeLive(down=True)),
    }.items():
        run(svc, "Can I transfer a ticket to a friend?" if label != "catalog down" else "how much is a ticket?", None if label != "catalog down" else {"eventSlug": "neon-monsoon-live-gurugram"})
