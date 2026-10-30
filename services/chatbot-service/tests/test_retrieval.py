import asyncio
import os
import uuid

import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool

from app import ingest
from app.models import ChatRequest
from app.service import NOT_FOUND, ChatService
from app.store import Store
from tests.fakes import DIMS, FakeLive, FakeLLM, settings

ADMIN_URL = os.environ.get("TEST_VECTOR_PG_URL")
pytestmark = pytest.mark.skipif(not ADMIN_URL, reason="TEST_VECTOR_PG_URL not set (needs the chatbot-db container with pgvector on 127.0.0.1:5433)")

EVENT = {"slug": "neon-monsoon-live-gurugram", "title": "Neon Monsoon Live", "category": "concerts", "description": "Synth pop. Price 999 on 1 Jan.", "venue": {"name": "Lotus Arena", "city": "Delhi NCR"}, "artists": [{"name": "Neon Monsoon"}]}


class FakeCatalog:
    def __init__(self, events):
        self.events = events

    async def list_events(self):
        return self.events


@pytest.fixture
def db_url():
    name = f"chatbot_test_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f"CREATE DATABASE {name}")
    scratch = ADMIN_URL.rsplit("/", 1)[0] + "/" + name
    yield scratch
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


def with_store(db_url, fn):
    async def go():
        async with AsyncConnectionPool(db_url, min_size=1, max_size=4, open=False) as pool:
            return await fn(Store(pool))

    return asyncio.run(go())


def index(store, llm=None, events=(EVENT,), model="m1", dims=DIMS):
    llm = llm or FakeLLM()
    return ingest.run(store, llm, FakeCatalog(list(events) if events is not None else None), "knowledge", model, dims)


def test_the_real_help_articles_are_indexed_and_the_right_one_is_found_with_a_citation(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        result = await index(store)
        assert result["catalog_complete"] and result["embedded"] == result["chunks"] > 20
        llm = FakeLLM()
        svc = ChatService(settings(), store, llm, FakeLive())
        r = await svc.chat(ChatRequest.model_validate({"message": "How many times can a ticket be transferred to a friend?"}), "0123456789abcdef")
        assert r.sources and r.sources[0].id.startswith("faq:transfers#")
        assert "Transferring tickets" in r.sources[0].title and r.sources[0].path == "/tickets"
        assert llm.answer_calls, "the model was asked, with the matching article in front of it"

    with_store(db_url, go)


def test_a_question_with_no_good_match_says_it_does_not_know_and_never_asks_the_model(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        await index(store)
        llm = FakeLLM()
        svc = ChatService(settings(min_similarity=0.5), store, llm, FakeLive())
        r = await svc.chat(ChatRequest.model_validate({"message": "xylophone quasar bicycle"}), "0123456789abcdef")
        assert r.answer == NOT_FOUND and not llm.answer_calls

    with_store(db_url, go)


def test_event_chunks_hold_no_price_or_dates_and_are_marked_untrusted(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        await index(store)
        async with store.pool.connection() as conn:
            row = await (await conn.execute("SELECT trusted, body, path FROM chunks WHERE id = 'event:neon-monsoon-live-gurugram'")).fetchone()
        assert row[0] is False and row[2] == "/events/neon-monsoon-live-gurugram"
        assert "Neon Monsoon" in row[1]
        # the organiser's description is kept as written (the model guard and the router handle numbers), but we add none of our own
        assert "₹" not in row[1].replace("Price 999 on 1 Jan.", "")

    with_store(db_url, go)


def test_running_it_again_embeds_nothing_new_and_a_changed_event_is_re_embedded_alone(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        first = await index(store)
        again = await index(store)
        assert again["embedded"] == 0 and again["deleted"] == 0
        changed = dict(EVENT, description="A brand new description.")
        third = await index(store, events=[changed])
        assert third["embedded"] == 1
        assert first["chunks"] == third["chunks"]

    with_store(db_url, go)


def test_changing_the_embedding_model_rebuilds_the_index(db_url):
    async def go(store):
        assert await store.ensure_schema("m1", DIMS) is False
        await index(store)
        assert await store.counts() > 0
        assert await store.ensure_schema("m1", DIMS) is False  # same settings: left alone
        assert await store.counts() > 0
        assert await store.ensure_schema("m2", DIMS) is True  # different model: old vectors are useless
        assert await store.counts() == 0
        result = await index(store, model="m2")
        assert result["embedded"] == result["chunks"] > 0

    with_store(db_url, go)


def test_an_incomplete_catalog_read_never_deletes_events(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        await index(store)
        before = await store.event_titles()
        assert before
        result = await index(store, events=None)  # the catalog could not be read completely
        assert result["catalog_complete"] is False
        assert await store.event_titles() == before
        gone = await index(store, events=[])  # a complete read that really has no events
        assert gone["catalog_complete"] and await store.event_titles() == []

    with_store(db_url, go)


def test_a_combined_vector_for_a_whole_batch_is_never_stored_against_the_wrong_rows(db_url):
    batches = []

    class Aggregating:  # what Gemini Embedding 2 does if texts are not wrapped one by one: ONE vector for the whole batch
        async def embed_documents(self, texts):
            batches.append(len(texts))
            return [[0.1] * DIMS]

    async def go(store):
        await store.ensure_schema("m1", DIMS)
        result = await index(store, llm=Aggregating())
        # The multi-text batches were refused (the shape was wrong). Each row was then embedded on its own, where one text really
        # does give one vector, so every row ends up with a correct vector and nothing is attached to the wrong row.
        assert any(n > 1 for n in batches) and result["embedded"] == result["chunks"] and result["pending"] == 0

    with_store(db_url, go)


def test_vectors_of_the_wrong_size_are_never_stored(db_url):
    class WrongSize:
        async def embed_documents(self, texts):
            return [[0.1] * (DIMS + 1) for _ in texts]

    async def go(store):
        await store.ensure_schema("m1", DIMS)
        result = await index(store, llm=WrongSize())
        assert result["embedded"] == 0 and result["pending"] == result["chunks"]

    with_store(db_url, go)


def test_a_failing_embedder_leaves_rows_for_the_next_run(db_url):
    class Failing:
        async def embed_documents(self, texts):
            raise RuntimeError("quota")

    async def go(store):
        await store.ensure_schema("m1", DIMS)
        assert (await index(store, llm=Failing()))["embedded"] == 0
        assert (await index(store))["embedded"] > 0

    with_store(db_url, go)


def test_with_no_embeddings_at_all_the_keyword_fallback_still_finds_an_article(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        await index(store, llm=type("F", (), {"embed_documents": staticmethod(lambda t: (_ for _ in ()).throw(RuntimeError("no key")))})())
        hit = await store.fts_faq("refund payment failed")
        assert hit and hit.kind == "faq" and hit.trusted

    with_store(db_url, go)


def test_only_one_reindex_runs_at_a_time(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        async with store.pool.connection() as holder:
            await holder.execute("SELECT pg_advisory_lock(7001)")
            skipped = await index(store)
            await holder.execute("SELECT pg_advisory_unlock(7001)")
        assert skipped == {"skipped": True}
        assert (await index(store)).get("skipped") is None

    with_store(db_url, go)


def test_an_empty_or_missing_knowledge_folder_does_not_wipe_the_help_articles(db_url, tmp_path):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        await index(store)
        async with store.pool.connection() as conn:
            faq_before = (await (await conn.execute("SELECT count(*) FROM chunks WHERE kind = 'faq'")).fetchone())[0]
        assert faq_before > 10
        await ingest.run(store, FakeLLM(), FakeCatalog([EVENT]), str(tmp_path), "m1", DIMS)  # an empty folder
        async with store.pool.connection() as conn:
            assert (await (await conn.execute("SELECT count(*) FROM chunks WHERE kind = 'faq'")).fetchone())[0] == faq_before

    with_store(db_url, go)


def test_one_chunk_the_embedder_rejects_does_not_block_the_others(db_url):
    class PickyEmbedder:
        async def embed_documents(self, texts):
            if any("Neon Monsoon" in t for t in texts):
                raise RuntimeError("rejected")
            return [[0.1] * DIMS for _ in texts]

    async def go(store):
        await store.ensure_schema("m1", DIMS)
        result = await index(store, llm=PickyEmbedder())
        assert result["pending"] == 1  # only the picky one is left
        assert result["embedded"] == result["chunks"] - 1

    with_store(db_url, go)


def test_a_malformed_event_is_skipped_without_stopping_the_run_or_deleting_good_events(db_url):
    async def go(store):
        await store.ensure_schema("m1", DIMS)
        await index(store)
        titles_before = await store.event_titles()
        result = await index(store, events=[EVENT, {"slug": "broken"}])  # the second has no title, venue or category
        assert result["catalog_complete"] is False
        assert await store.event_titles() == titles_before

    with_store(db_url, go)
