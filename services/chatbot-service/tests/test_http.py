import logging

from fastapi.testclient import TestClient

from app.main import create_app
from tests.fakes import EVENTS, FAQ, FakeLive, FakeLLM, FakeStore, settings


def client(**over):
    return TestClient(create_app(settings(**over), store=FakeStore(FAQ + EVENTS), llm=FakeLLM(), live=FakeLive(), background=False))


def test_validation_size_and_rate_limit():
    with client(rate_limit_per_minute=5) as c:
        assert c.post("/chat/messages", json={"message": ""}).status_code == 400
        assert c.post("/chat/messages", json={"message": "x" * 501}).status_code == 400
        assert c.post("/chat/messages", json={"message": "hi", "userId": "x"}).status_code == 400
        assert c.post("/chat/messages", content=b"{" + b" " * 9000 + b"}", headers={"content-type": "application/json"}).status_code == 413
        r = c.post("/chat/messages", json={"message": "How do transfers work?"}, headers={"x-request-id": "0123456789abcdef"})
        assert r.status_code == 200 and r.headers["x-request-id"] == "0123456789abcdef" and r.json()["requestId"] == "0123456789abcdef"
        codes = [c.post("/chat/messages", json={"message": "hello there"}).status_code for _ in range(8)]
        assert 429 in codes


def test_a_bad_request_id_is_replaced_not_trusted():
    with client() as c:
        r = c.post("/chat/messages", json={"message": "How do transfers work?"}, headers={"x-request-id": "../../etc"})
        assert r.headers["x-request-id"] != "../../etc" and len(r.headers["x-request-id"]) == 16


def test_the_chat_text_never_appears_in_any_log_line(caplog):
    secret_words = "zebra-umbrella-question about transfers"
    with caplog.at_level(logging.DEBUG), client() as c:
        c.post("/chat/messages", json={"message": secret_words, "history": [{"role": "user", "text": "earlier zebra-secret"}]})
    logged = " ".join(r.getMessage() + " " + " ".join(str(v) for v in r.__dict__.values()) for r in caplog.records)
    assert "zebra" not in logged


def test_reindex_needs_the_internal_token_and_health_reports_without_secrets():
    with client() as c:
        assert c.post("/internal/reindex").status_code == 401
        assert c.post("/internal/reindex", headers={"x-internal-token": "wrong"}).status_code == 401
        h = c.get("/readyz").json()
        assert h["status"] == "ready" and h["geminiConfigured"] is True and "test-key" not in str(h)
        assert c.get("/healthz").json() == {"status": "ok"}
    with client(internal_token="") as c:
        assert c.post("/internal/reindex", headers={"x-internal-token": ""}).status_code == 401  # an unset token never matches


def test_a_body_with_no_declared_length_is_cut_off_at_the_limit():
    def chunks():
        for _ in range(20):
            yield b"x" * 1024  # 20 KB, sent in pieces with no Content-Length

    with client() as c:
        assert c.post("/chat/messages", content=chunks(), headers={"content-type": "application/json"}).status_code == 413


def test_a_flood_of_made_up_addresses_cannot_reset_a_real_clients_limit():
    with client(rate_limit_per_minute=3, rate_limit_tracked_addresses=20) as c:
        real = {"x-forwarded-for": "10.0.0.1"}
        assert [c.post("/chat/messages", json={"message": "hello there"}, headers=real).status_code for _ in range(3)] == [200, 200, 200]
        for i in range(60):  # more distinct addresses than the limiter remembers
            c.post("/chat/messages", json={"message": "hello there"}, headers={"x-forwarded-for": f"10.1.{i // 250}.{i % 250}"})
            assert c.post("/chat/messages", json={"message": "hello there"}, headers=real).status_code == 429, i
