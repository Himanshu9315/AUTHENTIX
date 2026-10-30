import hashlib
import logging
import re
import unicodedata
from pathlib import Path
from typing import Protocol

from app.prompt import PROMPT_FORMAT
from app.store import Store

log = logging.getLogger("chatbot")
BATCH = 16
EVENT_DESCRIPTION_CAP = 1500
_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿­"), None)


class Embedder(Protocol):
    async def embed_documents(self, texts: list[str]) -> list[list[float]]: ...


class CatalogSource(Protocol):
    async def list_events(self) -> list[dict] | None:
        """Every published event (with description and artists), or None if the catalog could not be read completely."""


def clean_untrusted(text: str, cap: int = EVENT_DESCRIPTION_CAP) -> str:
    """Event text is written by organisers, so treat it as hostile: normalise it, drop invisible and control characters,
    flatten whitespace, neutralise angle brackets (so it can never close one of our tags), and cap its length."""
    text = unicodedata.normalize("NFKC", text).translate(_ZERO_WIDTH)
    text = "".join(c for c in text if c in "\n\t " or unicodedata.category(c)[0] != "C")
    text = " ".join(text.split()).replace("<", "‹").replace(">", "›")
    return text[:cap]


def content_hash(model: str, dims: int, title: str, body: str) -> str:
    return hashlib.sha256(f"{model}|{dims}|{PROMPT_FORMAT}|{title}|{body}".encode()).hexdigest()


def parse_faq(path: Path) -> list[dict]:
    """One chunk per '## ' section. Front matter gives the page title and the in-app link."""
    raw = path.read_text(encoding="utf-8")
    meta: dict[str, str] = {}
    if raw.startswith("---"):
        _, front, raw = raw.split("---", 2)
        for line in front.strip().splitlines():
            k, _, v = line.partition(":")
            meta[k.strip()] = v.strip()
    topic = path.stem
    chunks = []
    for section in re.split(r"^## ", raw, flags=re.MULTILINE)[1:]:
        heading, _, body = section.partition("\n")
        slug = re.sub(r"[^a-z0-9]+", "-", heading.lower()).strip("-")
        chunks.append({"id": f"faq:{topic}#{slug}", "kind": "faq", "trusted": True, "title": f'{meta.get("title", topic)}: {heading.strip()}', "path": meta.get("path", "/"), "body": " ".join(body.split())})
    return chunks


def event_chunk(ev: dict) -> dict:
    # No prices, dates or stock go in here, so retrieved text can never be a source for them.
    artists = ", ".join(a["name"] for a in ev.get("artists", []))
    body = clean_untrusted(f'{ev["category"].capitalize()} at {ev["venue"]["name"]}, {ev["venue"]["city"]}. {"Featuring " + artists + ". " if artists else ""}{ev.get("description", "")}')
    return {"id": f'event:{ev["slug"]}', "kind": "event", "trusted": False, "title": clean_untrusted(ev["title"], 200), "path": f'/events/{ev["slug"]}', "body": body}


async def run(store: Store, embedder: Embedder, catalog: CatalogSource, knowledge_dir: str, model: str, dims: int) -> dict:
    """Refresh the help index. Safe to run repeatedly and from several instances (an advisory lock lets one run at a time)."""
    async with store.pool.connection() as lock_conn:
        got = (await (await lock_conn.execute("SELECT pg_try_advisory_lock(7001)")).fetchone())[0]
        if not got:
            return {"skipped": True}
        try:
            faq = [c for p in sorted(Path(knowledge_dir).glob("*.md")) for c in parse_faq(p)]
            events_raw = await catalog.list_events()
            events, events_ok = [], events_raw is not None
            for raw_event in events_raw or []:
                try:
                    events.append(event_chunk(raw_event))
                except (KeyError, TypeError, AttributeError):
                    events_ok = False  # one malformed event must not stop the rest, and it must not cause real events to be deleted
            for c in faq + events:
                c["content_hash"] = content_hash(model, dims, c["title"], c["body"])
                await store.upsert(c)
            deleted = 0
            if faq:  # an empty or wrong knowledge directory must never wipe the help articles
                deleted += await store.delete_missing("faq", [c["id"] for c in faq])
            else:
                log.warning("no help articles found; leaving the index alone", extra={"reason": "empty_knowledge_dir"})
            if events_ok:  # an incomplete or partly unreadable catalog must never wipe the event index
                deleted += await store.delete_missing("event", [c["id"] for c in events])
            embedded = 0
            todo = await store.unembedded()

            async def embed_rows(rows) -> int:
                """Embeds rows; True/False per row so a single rejected row can't hold up the others."""
                try:
                    vecs = await embedder.embed_documents([f"title: {h.title} | text: {h.body}" for h in rows])
                except Exception as exc:  # noqa: BLE001 (any failure leaves these rows empty; a later run retries them)
                    log.warning("embedding batch failed", extra={"error": type(exc).__name__})
                    return 0
                if len(vecs) != len(rows) or any(len(v) != dims for v in vecs):
                    log.warning("embedding batch had the wrong shape", extra={"reason": "shape"})  # the "one combined vector" trap
                    return 0
                await store.set_embeddings([(h.id, v) for h, v in zip(rows, vecs, strict=True)])
                return len(rows)

            for i in range(0, len(todo), BATCH):
                batch = todo[i : i + BATCH]
                done = await embed_rows(batch)
                if done == 0 and len(batch) > 1:
                    for row in batch:  # the batch failed: try rows one by one, so one bad row only costs itself
                        done += await embed_rows([row])
                embedded += done
            pending = len(todo) - embedded
            return {"chunks": len(faq) + len(events), "embedded": embedded, "deleted": deleted, "catalog_complete": events_ok, "pending": pending}
        finally:
            await lock_conn.execute("SELECT pg_advisory_unlock(7001)")
