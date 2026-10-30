import asyncio
import hmac
import logging
import re
import secrets
import time
from collections import OrderedDict, deque
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
from psycopg_pool import AsyncConnectionPool
from pydantic import ValidationError

from app import ingest
from app.config import Settings
from app.live import HttpLiveSource
from app.llm import GeminiLLM
from app.logging import setup_logging
from app.models import ChatRequest
from app.service import ChatService
from app.store import Store

log = logging.getLogger("chatbot")
MAX_BODY = 8 * 1024
REQUEST_ID = re.compile(r"^[a-f0-9]{16}$")


def create_app(settings: Settings | None = None, *, store: Store | None = None, llm=None, live=None, background: bool = True) -> FastAPI:
    """Builds the app. Tests pass their own store/llm/live (so nothing touches the network) and background=False."""
    settings = settings or Settings()
    setup_logging()
    hits: OrderedDict[str, deque] = OrderedDict()  # in-service per-address limit: a second line of defence behind the gateway

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pool = None
        if store is None:
            pool = AsyncConnectionPool(settings.database_url, min_size=1, max_size=8, open=False)
            await pool.open()
            app.state.store = Store(pool)
        else:
            app.state.store = store
        app.state.live = live or HttpLiveSource(settings.catalog_url, settings.inventory_url)
        app.state.llm = llm or GeminiLLM(settings)
        for attempt in range(10):  # the database may still be starting
            try:
                await app.state.store.ensure_schema(settings.gemini_embed_model, settings.gemini_embed_dimensions)
                break
            except Exception as exc:  # noqa: BLE001
                if attempt == 9:
                    raise
                log.warning("database not ready yet", extra={"error": type(exc).__name__})
                await asyncio.sleep(2)
        app.state.chat = ChatService(settings, app.state.store, app.state.llm, app.state.live)

        async def reindex_forever():
            failures = 0
            while True:
                try:
                    result = await ingest.run(app.state.store, app.state.llm, app.state.live, settings.knowledge_dir, settings.gemini_embed_model, settings.gemini_embed_dimensions)
                    log.info("reindexed", extra={"count": result.get("chunks", 0), "embedded": result.get("embedded", 0)})
                    # Look again soon only if the CATALOG wasn't readable. Rows waiting for embeddings (no key, quota) are not
                    # a reason to hammer the catalog every minute.
                    failures = failures + 1 if result.get("catalog_complete") is False else 0
                except Exception as exc:  # noqa: BLE001
                    log.warning("reindex failed", extra={"error": type(exc).__name__})
                    failures += 1
                # 1 min, 2, 4, ... up to the normal interval, so an outage is retried promptly and then calmly
                await asyncio.sleep(min(60 * 2 ** (failures - 1), settings.reindex_seconds) if failures else settings.reindex_seconds)

        task = asyncio.create_task(reindex_forever()) if background else None
        try:
            yield
        finally:
            if task:
                task.cancel()
            if hasattr(app.state.live, "aclose"):
                await app.state.live.aclose()
            if pool:
                await pool.close()

    app = FastAPI(title="Authentix chatbot-service", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("x-request-id", "")
        rid = rid if REQUEST_ID.match(rid) else secrets.token_hex(8)
        request.state.request_id = rid
        started = time.monotonic()
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        # Method, path and status only. Never the query, the body or any header: a chat message must not reach the logs.
        log.info("request", extra={"requestId": rid, "method": request.method, "path": request.url.path, "status": response.status_code, "ms": int((time.monotonic() - started) * 1000)})
        return response

    def too_many(request: Request) -> bool:
        ip = (request.headers.get("x-forwarded-for", "").split(",")[0].strip()) or (request.client.host if request.client else "?")
        now = time.monotonic()
        window = hits.setdefault(ip, deque())
        hits.move_to_end(ip)  # most recently seen last
        while len(hits) > settings.rate_limit_tracked_addresses:  # many distinct addresses: forget the LEAST recently seen, never everyone at once
            hits.popitem(last=False)
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= settings.rate_limit_per_minute:
            return True
        window.append(now)
        return False

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.get("/readyz")
    async def readyz():
        try:
            await app.state.store.ping()
            return {"status": "ready", "geminiConfigured": settings.has_key, "indexedChunks": await app.state.store.counts()}
        except Exception:  # noqa: BLE001
            return JSONResponse({"status": "not_ready"}, status_code=503)

    @app.post("/chat/messages")
    async def chat(request: Request):
        rid = request.state.request_id
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_BODY:
            return JSONResponse({"error": "too_large"}, status_code=413)
        if too_many(request):
            return JSONResponse({"error": "rate_limited"}, status_code=429)
        # Read the body as it arrives and stop at the limit, so a request with no declared length can't make us buffer megabytes.
        parts, total = [], 0
        async for chunk in request.stream():
            total += len(chunk)
            if total > MAX_BODY:
                return JSONResponse({"error": "too_large"}, status_code=413)
            parts.append(chunk)
        raw = b"".join(parts)
        try:
            body = ChatRequest.model_validate_json(raw)
        except ValidationError:
            return JSONResponse({"error": "validation_error"}, status_code=400)
        result = await app.state.chat.chat(body, rid)
        return JSONResponse(result.model_dump(mode="json"), headers={"cache-control": "no-store"})

    @app.post("/internal/reindex")
    async def reindex(request: Request):
        token = settings.internal_token.get_secret_value()
        if not token or not hmac.compare_digest(request.headers.get("x-internal-token", ""), token):
            return Response(status_code=401)
        result = await ingest.run(app.state.store, app.state.llm, app.state.live, settings.knowledge_dir, settings.gemini_embed_model, settings.gemini_embed_dimensions)
        return result

    return app
