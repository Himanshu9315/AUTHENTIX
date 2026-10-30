import asyncio
import json
import logging
import random

from google import genai
from google.genai import errors, types

from app.config import Settings
from app.models import ModelAnswer

log = logging.getLogger("chatbot")


class LlmError(Exception):
    """kind: no_api_key | rate_limited | unavailable | blocked"""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


class GeminiLLM:
    """The only module that talks to Google. `client` can be replaced in tests, so nothing here touches the network there."""

    def __init__(self, settings: Settings, client=None):
        self.s = settings
        self.sem = asyncio.Semaphore(4)  # at most four model calls at once
        if client is not None:
            self.client = client
        elif settings.has_key:
            self.client = genai.Client(api_key=settings.gemini_api_key.get_secret_value(), http_options=types.HttpOptions(timeout=settings.gemini_timeout_ms))
        else:
            self.client = None

    def _need_key(self):
        if self.client is None:
            raise LlmError("no_api_key")

    @staticmethod
    def _map(exc: Exception) -> LlmError:
        """Turns any Google/network failure into one of our four kinds. The original message is dropped on purpose:
        it can contain the request."""
        if isinstance(exc, errors.APIError):
            return LlmError("rate_limited" if exc.code == 429 else "unavailable")
        return LlmError("unavailable")

    async def _retry(self, call):
        """One retry after a short pause for server errors and timeouts. A 429 is never retried: that would only make it worse."""
        for attempt in (1, 2):
            try:
                return await call()
            except LlmError:
                raise
            except Exception as exc:  # noqa: BLE001
                mapped = self._map(exc)
                if mapped.kind == "rate_limited" or attempt == 2:
                    raise mapped from None
                await asyncio.sleep(0.5 + random.random() * 0.5)  # noqa: S311 (jitter, not security)

    # ----- embeddings (Gemini Embedding 2) -----
    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """One vector per text. A plain list of strings would come back as ONE combined vector, so every text is wrapped
        in its own Content. Gemini Embedding 2 takes no task type: the task is written into the text instead."""
        self._need_key()
        contents = [types.Content(parts=[types.Part.from_text(text=t)]) for t in texts]
        res = await self._retry(
            lambda: self.client.aio.models.embed_content(model=self.s.gemini_embed_model, contents=contents, config=types.EmbedContentConfig(output_dimensionality=self.s.gemini_embed_dimensions))
        )
        vectors = [list(e.values) for e in (getattr(res, "embeddings", None) or [])]
        if len(vectors) != len(texts) or any(len(v) != self.s.gemini_embed_dimensions for v in vectors):
            raise LlmError("unavailable")  # the wrong number or size of vectors: refuse it rather than store it
        return vectors

    async def embed_query(self, text: str) -> list[float]:
        self._need_key()
        res = await self._retry(
            lambda: self.client.aio.models.embed_content(
                model=self.s.gemini_embed_model,
                contents=[types.Content(parts=[types.Part.from_text(text=f"task: search result | query: {text}")])],
                config=types.EmbedContentConfig(output_dimensionality=self.s.gemini_embed_dimensions),
            )
        )
        embeddings = getattr(res, "embeddings", None) or []
        vec = list(embeddings[0].values) if embeddings else []
        if len(vec) != self.s.gemini_embed_dimensions:
            raise LlmError("unavailable")
        return vec

    # ----- chat -----
    async def answer(self, system: str, history: list[dict], user_turn: str) -> tuple[ModelAnswer, int]:
        """Returns the parsed answer and the number of tokens used (for the cost log)."""
        self._need_key()
        contents = [types.Content(role=h["role"], parts=[types.Part.from_text(text=h["text"])]) for h in history]
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_turn)]))

        def config(with_thinking: bool) -> types.GenerateContentConfig:
            return types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.2,
                max_output_tokens=400,
                response_mime_type="application/json",
                response_schema=ModelAnswer,
                **({"thinking_config": types.ThinkingConfig(thinking_budget=self.s.gemini_thinking_budget)} if with_thinking else {}),
            )

        async def call(with_thinking: bool):
            async with self.sem:
                return await self.client.aio.models.generate_content(model=self.s.gemini_chat_model, contents=contents, config=config(with_thinking))

        try:
            res = await self._retry(lambda: call(True))
        except LlmError as exc:
            if exc.kind != "unavailable":
                raise
            res = await self._retry(lambda: call(False))  # some models reject a thinking setting: try once without it
        cands = getattr(res, "candidates", None) or []
        if not cands or str(getattr(cands[0], "finish_reason", "")).endswith(("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION")):
            raise LlmError("blocked")
        text = getattr(res, "text", None)
        if not text:
            raise LlmError("blocked")
        try:
            parsed = ModelAnswer.model_validate(json.loads(text))
        except (ValueError, TypeError):
            raise LlmError("unavailable") from None
        usage = getattr(res, "usage_metadata", None)
        return parsed, int(getattr(usage, "total_token_count", 0) or 0)
