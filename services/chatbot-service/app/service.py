import logging
import time
from collections import OrderedDict
from datetime import date

from app import guard, pii, router
from app.llm import LlmError
from app.models import ChatRequest, ChatResponse, Flags, LiveData, Source
from app.prompt import SYSTEM, build_user_turn
from app.store import Hit

log = logging.getLogger("chatbot")

REFUSAL_PII = "Please don't share Aadhaar numbers, OTPs, card details, emails or phone numbers here. I don't need them to help. For account issues, see Contact support."
NOT_FOUND = "I couldn't find that in our help articles. Please see Contact support."
WHICH_EVENT = "Which event do you mean? Open its page and ask me there, and I'll check the live details."
LIVE_DOWN = "I can't fetch live prices or availability right now. Please check the event page."
TROUBLE = "I'm having trouble right now. Please try again in a moment, or see Contact support."
BLOCKED = "I can't help with that one."
CONTACT = ("faq:contact#support", "faq", "Contact support", "/")
TOP_K = 4
CACHE_SIZE = 1000


def _flags(grounded=False, refused=None, degraded=None, redirect=False) -> Flags:
    return Flags(grounded=grounded, refused=refused, degraded=degraded, liveDataRedirect=redirect)


class ChatService:
    """The whole request flow:  PII guard -> live-data router -> retrieve -> generate -> output guard."""

    def __init__(self, settings, store, llm, live, clock=time.monotonic, today=date.today):
        self.s, self.store, self.llm, self.live = settings, store, llm, live
        self.clock, self.today = clock, today
        self.query_cache: OrderedDict[str, list[float]] = OrderedDict()
        self.backoff_until = 0.0  # after a 429, don't call Gemini for a little while
        self.calls_today = (today(), 0)

    # ---- helpers ----
    def _budget_left(self) -> bool:
        day, n = self.calls_today
        if day != self.today():
            self.calls_today = (self.today(), 0)
            return True
        return n < self.s.max_gemini_calls_per_day

    def _count_call(self) -> None:
        day, n = self.calls_today
        self.calls_today = (day, n + 1)

    def _source(self, h: Hit) -> Source:
        return Source(id=h.id, kind=h.kind, title=h.title, path=h.path)

    def _reply(self, request_id: str, answer: str, flags: Flags, sources=None, live: LiveData | None = None) -> ChatResponse:
        return ChatResponse(answer=answer, sources=sources or [], liveData=live, flags=flags, requestId=request_id)

    # ---- the flow ----
    async def chat(self, req: ChatRequest, request_id: str) -> ChatResponse:
        started = self.clock()
        # 1. Personal data: refuse before anything is logged, embedded or sent to the model.
        found = pii.detect(req.message)
        if found:
            log.info("refused: personal data", extra={"requestId": request_id, "pii": found, "outcome": "refused"})
            return self._reply(request_id, REFUSAL_PII, _flags(refused="personal_data"))
        history = [{"role": t.role, "text": t.text} for t in req.history if not pii.has_pii(t.text)]  # a turn with personal data is dropped silently

        # 2. Prices, availability, dates: from live data, never from the model.
        want = router.intents(req.message)
        live_answer = await self._live(req, want, request_id)
        if live_answer is not None:
            log.info("answered from live data", extra={"requestId": request_id, "intent": sorted(want), "outcome": "live", "ms": int((self.clock() - started) * 1000)})
            return live_answer

        # 3. Help answer: retrieve, then generate. Whatever goes wrong here becomes a polite answer, never a server error.
        try:
            return await self._help(req, history, request_id, started)
        except Exception as exc:  # noqa: BLE001
            log.warning("help answer failed", extra={"requestId": request_id, "error": type(exc).__name__, "degraded": "unavailable"})
            return self._reply(request_id, TROUBLE, _flags(degraded="unavailable"))

    async def _live(self, req: ChatRequest, want: set[str], request_id: str) -> ChatResponse | None:
        if not want:
            return None
        slug = req.context.eventSlug if req.context else None
        try:
            titles = await self.store.event_titles()
        except Exception:  # noqa: BLE001 (no event list: fall back to the page the widget is on, or a help answer)
            titles = []
        kind, matches = router.resolve_event(req.message, slug, titles)
        if router.wants_help_instead(req.message) and kind in ("none", "slug"):
            return None  # "is there a fee to transfer?" / "how long is the seat hold?" are help questions
        if kind == "none":
            # Price and availability always need an event. A "when/how long" question without one is probably a help question.
            return self._reply(request_id, WHICH_EVENT, _flags()) if want & {"price", "availability"} else None
        if kind == "ambiguous":
            listing = "; ".join(f"{t}" for _, t in matches)
            return self._reply(request_id, f"Did you mean one of these: {listing}? Open the event page and ask me there.", _flags(), sources=[Source(id=f"event:{s}", kind="event", title=t, path=f"/events/{s}") for s, t in matches])
        try:
            data = await router.live_data(self.live, matches[0][0], "availability" in want)
        except Exception:  # noqa: BLE001 (any failure fetching live data means "don't guess")
            return self._reply(request_id, LIVE_DOWN, _flags())
        if data is None:
            return self._reply(request_id, "I couldn't find that event.", _flags())
        return self._reply(request_id, f"Here's the live information for {data.event.title}.", _flags(grounded=True), live=data)

    async def _embed_query(self, text: str) -> list[float]:
        key = " ".join(text.casefold().split())
        if key in self.query_cache:
            self.query_cache.move_to_end(key)
            return self.query_cache[key]
        vec = await self.llm.embed_query(text)
        self.query_cache[key] = vec
        if len(self.query_cache) > CACHE_SIZE:
            self.query_cache.popitem(last=False)
        return vec

    async def _fallback(self, req: ChatRequest, request_id: str, why: str) -> ChatResponse:
        """No model available: show the best matching help article text as it is written, so the person still gets something real."""
        try:
            hit = await self.store.fts_faq(req.message)
        except Exception:  # noqa: BLE001 (even the keyword search failed)
            return self._reply(request_id, TROUBLE, _flags(degraded=why))
        flags = _flags(grounded=bool(hit), degraded=why)
        if hit is None:
            return self._reply(request_id, NOT_FOUND, flags)
        return self._reply(request_id, hit.body[:600].rstrip(), flags, sources=[self._source(hit)])

    async def _help(self, req: ChatRequest, history: list[dict], request_id: str, started: float) -> ChatResponse:
        if not self.s.has_key:
            return await self._fallback(req, request_id, "no_api_key")
        if self.clock() < self.backoff_until:
            return await self._fallback(req, request_id, "rate_limited")
        if not self._budget_left():
            return await self._fallback(req, request_id, "budget")

        try:
            self._count_call()
            hits = [h for h in await self.store.search(await self._embed_query(req.message), TOP_K) if h.sim >= self.s.min_similarity]
        except LlmError as exc:
            return await self._degrade(req, request_id, exc.kind)
        if not hits:
            log.info("no good match", extra={"requestId": request_id, "outcome": "not_found"})
            return self._reply(request_id, NOT_FOUND, _flags(), sources=[Source(id=CONTACT[0], kind="faq", title=CONTACT[2], path=CONTACT[3])])

        labelled = [{"id": f"S{i}", "kind": h.kind, "trusted": h.trusted, "title": h.title, "body": h.body} for i, h in enumerate(hits, 1)]
        try:
            self._count_call()
            parsed, tokens = await self.llm.answer(SYSTEM, history, build_user_turn(labelled, req.message))
        except LlmError as exc:
            return await self._degrade(req, request_id, exc.kind)

        text, redirect = guard.apply(parsed.answer, self.s.web_base_url)
        cited = {f"S{i}": h for i, h in enumerate(hits, 1)}
        used = [cited[i] for i in dict.fromkeys(parsed.used_source_ids) if i in cited]  # only ids we really sent
        if not redirect and not used:
            used = [hits[0]]  # the model cited nothing: cite the best match rather than nothing
        sources = [] if redirect else [self._source(h) for h in used]  # citations come from OUR rows, never from the model's words
        log.info("answered", extra={"requestId": request_id, "retrieved": [(h.id, round(h.sim, 2)) for h in hits], "model": self.s.gemini_chat_model, "tokens": tokens, "outcome": "redirect" if redirect else "answered", "ms": int((self.clock() - started) * 1000)})
        return self._reply(request_id, text, _flags(grounded=not redirect, redirect=redirect), sources=sources)

    async def _degrade(self, req: ChatRequest, request_id: str, kind: str) -> ChatResponse:
        log.warning("model unavailable", extra={"requestId": request_id, "degraded": kind})
        if kind == "blocked":
            return self._reply(request_id, BLOCKED, _flags(degraded="blocked"))
        if kind == "rate_limited":
            self.backoff_until = self.clock() + 30
        return await self._fallback(req, request_id, kind if kind in ("rate_limited", "unavailable") else "unavailable")
