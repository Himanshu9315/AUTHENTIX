import hashlib
import math
import re
from collections import Counter

from app.config import Settings
from app.llm import LlmError
from app.models import ModelAnswer
from app.store import Hit

DIMS = 128
STOP = {"the", "a", "an", "to", "of", "and", "or", "is", "are", "in", "on", "for", "can", "i", "my", "how", "do", "does", "what", "title", "text", "task", "search", "result", "query", "it", "you", "your"}


def embed(text: str) -> list[float]:
    """A tiny deterministic 'embedding': hashed bag of words, length-normalised. Texts that share words are close."""
    v = [0.0] * DIMS
    for w, n in Counter(re.findall(r"[a-z]+", text.lower())).items():
        if w not in STOP:
            v[int(hashlib.md5(w[:5].encode()).hexdigest(), 16) % DIMS] += n  # noqa: S324  (first 5 letters: a crude stem, so transfer ~ transferred)
    norm = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / norm for x in v]


def settings(**over) -> Settings:
    base = dict(gemini_api_key="test-key-not-real", gemini_embed_dimensions=DIMS, min_similarity=0.3, web_base_url="http://localhost:8080", database_url="postgresql://x", internal_token="t" * 40)
    return Settings(**{**base, **over})


class FakeLLM:
    """Stands in for GeminiLLM. Records every call so tests can prove what was (and was not) sent to the model."""

    def __init__(self, reply=None, error: str | None = None):
        self.answer_calls: list[dict] = []
        self.embed_calls: list[str] = []
        self.reply = reply or (lambda turn: ModelAnswer(answer="You can transfer a ticket twice to a verified user.", used_source_ids=["S1"]))
        self.error = error

    @property
    def calls(self) -> int:
        return len(self.answer_calls) + len(self.embed_calls)

    async def embed_query(self, text):
        self.embed_calls.append(text)
        if self.error == "embed":
            raise LlmError("unavailable")
        return embed(text)

    async def embed_documents(self, texts):
        return [embed(t) for t in texts]

    async def answer(self, system, history, user_turn):
        self.answer_calls.append({"system": system, "history": history, "turn": user_turn})
        if self.error and self.error != "embed":
            raise LlmError(self.error)
        return self.reply(user_turn), 42


class FakeStore:
    """The same interface as app.store.Store, in memory, so most tests need no database."""

    def __init__(self, chunks: list[dict]):
        self.rows = [(Hit(c["id"], c["kind"], c["trusted"], c["title"], c["path"], c["body"]), embed(c["title"] + " " + c["body"])) for c in chunks]

    async def ensure_schema(self, model, dims):
        return False

    async def search(self, vec, k):
        scored = [(sum(a * b for a, b in zip(vec, v, strict=True)), h) for h, v in self.rows]
        return [Hit(h.id, h.kind, h.trusted, h.title, h.path, h.body, sim=s) for s, h in sorted(scored, key=lambda x: -x[0])[:k]]

    async def fts_faq(self, query):
        words = set(re.findall(r"[a-z]+", query.lower())) - STOP
        best = max(((len(words & set(re.findall(r"[a-z]+", (h.title + " " + h.body).lower()))), h) for h, _ in self.rows if h.kind == "faq" and h.trusted), key=lambda x: x[0], default=(0, None))
        return best[1] if best[0] else None

    async def event_titles(self):
        return [(h.id[6:], h.title) for h, _ in self.rows if h.kind == "event"]

    async def counts(self):
        return len(self.rows)

    async def ping(self):
        return None


class FakeLive:
    def __init__(self, down=False):
        self.down = down
        self.event = {
            "id": "11111111-1111-4111-8111-111111111111", "slug": "neon-monsoon-live-gurugram", "title": "Neon Monsoon Live",
            "startsAt": "2026-11-11T13:30:00.000Z", "endsAt": "2026-11-11T17:30:00.000Z", "venue": {"name": "Lotus Arena", "city": "Delhi NCR"},
            "tiers": [{"id": "t1", "name": "General", "priceInr": 1499}, {"id": "t2", "name": "Premium", "priceInr": 2999}],
        }

    async def get_event(self, slug):
        if self.down:
            raise RuntimeError("catalog down")
        return self.event if slug == self.event["slug"] else None

    async def get_availability(self, event_id):
        if self.down:
            raise RuntimeError("inventory down")
        return {"t1": 120, "t2": 0}


FAQ = [
    {"id": "faq:transfers#rules", "kind": "faq", "trusted": True, "title": "Transferring tickets: The rules", "path": "/tickets", "body": "A ticket can be transferred twice to a verified user. Transfers close 24 hours before the event. Tickets cannot be resold."},
    {"id": "faq:booking#timer", "kind": "faq", "trusted": True, "title": "Booking tickets: The booking timer", "path": "/", "body": "We hold your seats while you pay. A countdown shows how long is left and the seats are released when it ends."},
    {"id": "faq:contact#support", "kind": "faq", "trusted": True, "title": "Contact and support: Support", "path": "/", "body": "Email support at support@authentix.test if this assistant cannot help."},
]
EVENTS = [
    {"id": "event:neon-monsoon-live-gurugram", "kind": "event", "trusted": False, "title": "Neon Monsoon Live", "path": "/events/neon-monsoon-live-gurugram", "body": "Concerts at Lotus Arena, Delhi NCR. Synth pop show."},
    {"id": "event:echo-bazaar-night-noida", "kind": "event", "trusted": False, "title": "Echo Bazaar Night", "path": "/events/echo-bazaar-night-noida", "body": "Concerts at Yamuna Open Grounds. Folk electronica."},
]
