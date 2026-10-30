import asyncio

import pytest
from fastapi.testclient import TestClient
from google.genai import errors

from app.llm import GeminiLLM, LlmError
from app.main import create_app
from app.models import ChatRequest
from app.service import BLOCKED, NOT_FOUND, ChatService
from tests.fakes import EVENTS, FAQ, FakeLive, FakeLLM, FakeStore, settings


def run(svc, message="Can I transfer a ticket to a friend?"):
    return asyncio.run(svc.chat(ChatRequest.model_validate({"message": message}), "0123456789abcdef"))


def svc(llm, **over):
    return ChatService(settings(**over), FakeStore(FAQ + EVENTS), llm, FakeLive())


def test_with_no_api_key_the_bot_still_answers_from_the_help_articles():
    llm = FakeLLM()
    r = run(svc(llm, gemini_api_key=""))
    assert llm.calls == 0
    assert r.flags.degraded == "no_api_key"
    assert "transferred twice" in r.answer and r.sources[0].id == "faq:transfers#rules"


def test_with_no_api_key_live_data_still_works():
    r = asyncio.run(svc(FakeLLM(), gemini_api_key="").chat(ChatRequest.model_validate({"message": "how much is it?", "context": {"eventSlug": "neon-monsoon-live-gurugram"}}), "0123456789abcdef"))
    assert r.liveData is not None


def test_a_rate_limit_falls_back_and_then_stops_calling_the_model_for_a_while():
    llm = FakeLLM(error="rate_limited")
    s = svc(llm)
    assert run(s).flags.degraded == "rate_limited"
    first = llm.calls
    assert run(s).flags.degraded == "rate_limited"
    assert llm.calls == first, "during the pause the model is not called at all"


@pytest.mark.parametrize("kind", ["unavailable", "embed"])
def test_a_server_error_or_failed_embedding_falls_back(kind):
    r = run(svc(FakeLLM(error=kind)))
    assert r.flags.degraded == "unavailable" and r.sources


def test_a_blocked_answer_gets_a_polite_refusal():
    r = run(svc(FakeLLM(error="blocked")))
    assert r.answer == BLOCKED and r.flags.degraded == "blocked"


def test_the_daily_budget_stops_model_calls():
    llm = FakeLLM()
    s = svc(llm, max_gemini_calls_per_day=0)
    r = run(s)
    assert r.flags.degraded == "budget" and llm.calls == 0


def test_when_nothing_matches_the_bot_says_it_does_not_know():
    r = run(svc(FakeLLM(), min_similarity=0.99), "zzz qqq")
    assert r.answer == NOT_FOUND and r.flags.grounded is False


# ---- the real Gemini wrapper, with a fake Google client underneath ----
class _Models:
    def __init__(self, behaviour):
        self.behaviour, self.calls = behaviour, 0

    async def generate_content(self, **kw):
        self.calls += 1
        return self.behaviour(self.calls)

    async def embed_content(self, **kw):
        self.calls += 1
        return self.behaviour(self.calls)


class _Client:
    def __init__(self, behaviour):
        self.models = _Models(behaviour)
        self.aio = self


def gemini(behaviour):
    return GeminiLLM(settings(), client=_Client(behaviour))


def ask_llm(llm):
    return asyncio.run(llm.answer("sys", [], "turn"))


def test_a_429_is_mapped_and_never_retried():
    c = _Client(lambda n: (_ for _ in ()).throw(errors.APIError(429, {"error": {"message": "quota"}})))
    llm = GeminiLLM(settings(), client=c)
    with pytest.raises(LlmError) as e:
        ask_llm(llm)
    assert e.value.kind == "rate_limited" and c.models.calls == 1


def test_a_server_error_is_retried_once_then_reported_as_unavailable(monkeypatch):
    real_sleep = asyncio.sleep
    monkeypatch.setattr("app.llm.asyncio.sleep", lambda s: real_sleep(0))  # no real waiting in tests
    c = _Client(lambda n: (_ for _ in ()).throw(errors.APIError(503, {"error": {"message": "down"}})))
    with pytest.raises(LlmError) as e:
        ask_llm(GeminiLLM(settings(), client=c))
    assert e.value.kind == "unavailable" and c.models.calls >= 2


def test_a_timeout_is_unavailable():
    c = _Client(lambda n: (_ for _ in ()).throw(TimeoutError()))
    with pytest.raises(LlmError) as e:
        ask_llm(GeminiLLM(settings(), client=c))
    assert e.value.kind == "unavailable"


def test_an_empty_or_blocked_candidate_is_blocked():
    class R:
        candidates = []
        text = None

    with pytest.raises(LlmError) as e:
        ask_llm(gemini(lambda n: R()))
    assert e.value.kind == "blocked"


def test_embedding_wraps_each_text_separately_so_there_is_one_vector_per_text():
    seen = {}

    class Emb:
        def __init__(self, v):
            self.values = v

    class R:
        embeddings = [Emb([0.1] * 128), Emb([0.2] * 128)]

    class M:
        async def embed_content(self, model, contents, config):
            seen.update(model=model, n=len(contents), dims=config.output_dimensionality, task=config.task_type)
            return R()

    class C:
        aio = type("A", (), {"models": M()})()

    out = asyncio.run(GeminiLLM(settings(), client=C()).embed_documents(["a", "b"]))
    assert len(out) == 2 and seen == {"model": "gemini-embedding-2", "n": 2, "dims": 128, "task": None}


def test_no_failure_ever_reaches_the_caller_as_a_server_error():
    for error in ("rate_limited", "unavailable", "blocked", "embed"):
        app = create_app(settings(), store=FakeStore(FAQ + EVENTS), llm=FakeLLM(error=error), live=FakeLive(), background=False)
        with TestClient(app) as client:
            r = client.post("/chat/messages", json={"message": "Can I transfer a ticket?"})
            assert r.status_code == 200, error


class BrokenStore(FakeStore):
    """A database that fails on every call (down, wrong vector size, anything)."""

    async def search(self, vec, k):
        raise RuntimeError("different vector dimensions 768 and 128")

    async def fts_faq(self, query):
        raise RuntimeError("connection lost")

    async def event_titles(self):
        raise RuntimeError("connection lost")


def test_a_failing_database_gives_a_polite_answer_never_a_server_error():
    app = create_app(settings(), store=BrokenStore(FAQ + EVENTS), llm=FakeLLM(), live=FakeLive(), background=False)
    with TestClient(app) as client:
        for message in ["Can I transfer a ticket?", "how much is a ticket for Neon Monsoon Live?"]:
            r = client.post("/chat/messages", json={"message": message})
            assert r.status_code == 200
            assert r.json()["flags"]["degraded"] in ("unavailable", None)
            assert "Traceback" not in r.text and "dimensions" not in r.text


def test_a_failing_database_with_no_api_key_is_also_handled():
    app = create_app(settings(gemini_api_key=""), store=BrokenStore(FAQ + EVENTS), llm=FakeLLM(), live=FakeLive(), background=False)
    with TestClient(app) as client:
        assert client.post("/chat/messages", json={"message": "Can I transfer a ticket?"}).status_code == 200


def test_an_embedding_response_with_no_vectors_or_the_wrong_size_is_refused():
    class R:
        embeddings = None

    with pytest.raises(LlmError):
        asyncio.run(gemini(lambda n: R()).embed_query("hello"))

    class Emb:
        values = [0.1] * 7

    class Wrong:
        embeddings = [Emb()]

    with pytest.raises(LlmError):
        asyncio.run(gemini(lambda n: Wrong()).embed_query("hello"))
    with pytest.raises(LlmError):
        asyncio.run(gemini(lambda n: Wrong()).embed_documents(["a", "b"]))
