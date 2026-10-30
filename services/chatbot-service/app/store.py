from dataclasses import dataclass

from psycopg_pool import AsyncConnectionPool

from app.prompt import PROMPT_FORMAT


@dataclass(frozen=True)
class Hit:
    id: str
    kind: str
    trusted: bool
    title: str
    path: str
    body: str
    sim: float = 0.0


def vec_literal(v: list[float]) -> str:
    """pgvector's text form. Passed as a parameter and cast in SQL, so no extra Python package is needed."""
    return "[" + ",".join(f"{x:.7g}" for x in v) + "]"


def _ddl(dims: int) -> str:
    # dims is an int validated by the caller (128..3072); it is put in the statement because DDL can't take parameters.
    return f"""
    CREATE TABLE IF NOT EXISTS chunks (
      id text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('faq','event')),
      trusted boolean NOT NULL,
      title text NOT NULL,
      path text NOT NULL,
      body text NOT NULL,
      content_hash text NOT NULL,
      embedding vector({dims}),
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS chunks_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
    CREATE INDEX IF NOT EXISTS chunks_tsv ON chunks USING gin (tsv);
    """


class Store:
    """All SQL for the help index lives here."""

    def __init__(self, pool: AsyncConnectionPool):
        self.pool = pool

    async def ensure_schema(self, model: str, dims: int) -> bool:
        """Creates the tables. If the embedding model or size changed, the old vectors are in a different space and
        useless: drop them and start again. Returns True if the index was rebuilt (so everything must be re-embedded)."""
        if not 128 <= dims <= 3072:
            raise ValueError("embedding dimensions must be between 128 and 3072")
        async with self.pool.connection() as conn:
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            await conn.execute("CREATE TABLE IF NOT EXISTS index_meta (id int PRIMARY KEY CHECK (id = 1), embed_model text NOT NULL, embed_dims int NOT NULL, prompt_format int NOT NULL)")
            cur = await conn.execute("SELECT embed_model, embed_dims, prompt_format FROM index_meta WHERE id = 1")
            row = await cur.fetchone()
            rebuilt = row is not None and tuple(row) != (model, dims, PROMPT_FORMAT)
            async with conn.transaction():
                if rebuilt:
                    await conn.execute("DROP TABLE IF EXISTS chunks")
                await conn.execute(_ddl(dims))
                await conn.execute(
                    "INSERT INTO index_meta (id, embed_model, embed_dims, prompt_format) VALUES (1, %s, %s, %s) "
                    "ON CONFLICT (id) DO UPDATE SET embed_model = EXCLUDED.embed_model, embed_dims = EXCLUDED.embed_dims, prompt_format = EXCLUDED.prompt_format",
                    (model, dims, PROMPT_FORMAT),
                )
            return rebuilt

    async def upsert(self, c: dict) -> None:
        """Insert or update a chunk. The vector is kept only if the content did not change; otherwise it is cleared to be re-embedded."""
        async with self.pool.connection() as conn:
            await conn.execute(
                """INSERT INTO chunks (id, kind, trusted, title, path, body, content_hash) VALUES (%(id)s,%(kind)s,%(trusted)s,%(title)s,%(path)s,%(body)s,%(content_hash)s)
                   ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, trusted = EXCLUDED.trusted, title = EXCLUDED.title, path = EXCLUDED.path, body = EXCLUDED.body,
                     embedding = CASE WHEN chunks.content_hash = EXCLUDED.content_hash THEN chunks.embedding ELSE NULL END,
                     content_hash = EXCLUDED.content_hash, updated_at = now()""",
                c,
            )

    async def unembedded(self, limit: int = 500) -> list[Hit]:
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT id, kind, trusted, title, path, body FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT %s", (limit,))
            return [Hit(*r) for r in await cur.fetchall()]

    async def set_embeddings(self, pairs: list[tuple[str, list[float]]]) -> None:
        async with self.pool.connection() as conn:
            for chunk_id, vec in pairs:
                await conn.execute("UPDATE chunks SET embedding = %s::vector WHERE id = %s", (vec_literal(vec), chunk_id))

    async def delete_missing(self, kind: str, keep_ids: list[str]) -> int:
        async with self.pool.connection() as conn:
            cur = await conn.execute("DELETE FROM chunks WHERE kind = %s AND NOT (id = ANY(%s))", (kind, keep_ids))
            return cur.rowcount

    async def search(self, vec: list[float], k: int) -> list[Hit]:
        async with self.pool.connection() as conn:
            lit = vec_literal(vec)
            cur = await conn.execute(
                "SELECT id, kind, trusted, title, path, body, 1 - (embedding <=> %s::vector) AS sim FROM chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> %s::vector LIMIT %s",
                (lit, lit, k),
            )
            return [Hit(*r[:6], sim=float(r[6])) for r in await cur.fetchall()]

    async def fts_faq(self, query: str) -> Hit | None:
        """Keyword fallback over TRUSTED FAQ rows only (organiser text is never used when the model is unavailable)."""
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                "SELECT id, kind, trusted, title, path, body, ts_rank(tsv, q) FROM chunks, websearch_to_tsquery('english', %s) q "
                "WHERE kind = 'faq' AND trusted AND tsv @@ q ORDER BY ts_rank(tsv, q) DESC LIMIT 1",
                (query,),
            )
            r = await cur.fetchone()
            return Hit(*r[:6], sim=float(r[6])) if r else None

    async def event_titles(self) -> list[tuple[str, str]]:
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT substr(id, 7), title FROM chunks WHERE kind = 'event' ORDER BY title")
            return [(r[0], r[1]) for r in await cur.fetchall()]

    async def counts(self) -> int:
        async with self.pool.connection() as conn:
            cur = await conn.execute("SELECT count(*) FROM chunks")
            return (await cur.fetchone())[0]

    async def ping(self) -> None:
        async with self.pool.connection() as conn:
            await conn.execute("SELECT 1")
