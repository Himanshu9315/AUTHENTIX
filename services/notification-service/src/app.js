import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";

const REQUEST_ID = /^[a-f0-9]{16}$/;
const uuid = z.string().uuid();
const MAX_UNREAD_SHOWN = 99;

// A cursor is "<created_at to the microsecond>~<id>", so rows created in the same millisecond are never skipped or repeated.
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)~([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const TS = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const item = (r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, link: r.link, createdAt: r.created_at, readAt: r.read_at });

/**
 * The in-app inbox. Everything is scoped to the signed-in user (x-user-id from the gateway); another person's
 * notification is simply "not found".
 * @param {{ pool: import("pg").Pool, logger: any, consumer?: { isHealthy: () => boolean } }} deps
 */
export async function buildApp({ pool, logger, consumer }) {
  const app = Fastify({
    loggerInstance: logger,
    genReqId: (req) => {
      const id = req.headers[REQUEST_ID_HEADER];
      return typeof id === "string" && REQUEST_ID.test(id) ? id : randomBytes(8).toString("hex");
    },
    requestIdHeader: REQUEST_ID_HEADER,
  });
  // A JSON content-type with no body is an empty request, not an error.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, raw, done) => {
    try {
      done(null, raw ? JSON.parse(raw) : {});
    } catch {
      done(Object.assign(new Error("invalid json"), { statusCode: 400 }));
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      if (consumer && !consumer.isHealthy()) return reply.code(503).send({ status: "not_ready", reason: "messaging down" }); // SMTP is not a dependency: retries cover it
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  const userId = (req, reply) => {
    const id = req.headers["x-user-id"];
    if (!uuid.safeParse(id).success) return void reply.code(401).send({ error: "unauthorized" });
    return id.toLowerCase();
  };

  app.get("/notifications", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit ?? "20", 10) || 20));
    const cur = req.query.before === undefined ? null : CURSOR.exec(String(req.query.before));
    // The shape must match AND be a real date, or the database would reject it with a 500 instead of a clean 400.
    if (req.query.before !== undefined && (!cur || Number.isNaN(Date.parse(cur[1].replace(/\.(\d{3})\d{3}Z$/, ".$1Z"))))) return reply.code(400).send({ error: "validation_error" });
    const { rows } = await pool.query(
      `SELECT id, kind, title, body, link, created_at, read_at, ${TS} AS cursor_ts FROM notifications
       WHERE user_id = $1 ${cur ? "AND (created_at, id) < ($3::timestamptz, $4::uuid)" : ""}
       ORDER BY created_at DESC, id DESC LIMIT $2`,
      cur ? [uid, limit + 1, cur[1], cur[2]] : [uid, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    reply.header("cache-control", "no-store");
    return { items: page.map(item), nextBefore: rows.length > limit ? `${last.cursor_ts}~${last.id}` : null };
  });

  app.get("/notifications/unread-count", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM (SELECT 1 FROM notifications WHERE user_id = $1 AND read_at IS NULL LIMIT $2) t", [uid, MAX_UNREAD_SHOWN + 1]);
    reply.header("cache-control", "no-store");
    return { unread: Math.min(rows[0].n, MAX_UNREAD_SHOWN) };
  });

  app.post("/notifications/read-all", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    await pool.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL", [uid]);
    return reply.code(204).send();
  });

  app.post("/notifications/:id/read", async (req, reply) => {
    const uid = userId(req, reply);
    if (!uid) return;
    if (!uuid.safeParse(req.params.id).success) return reply.code(404).send({ error: "not_found" });
    // Marking an already-read one is fine (204); somebody else's, or a made-up id, is 404.
    const { rowCount } = await pool.query("SELECT 1 FROM notifications WHERE id = $1 AND user_id = $2", [req.params.id, uid]);
    if (rowCount === 0) return reply.code(404).send({ error: "not_found" });
    await pool.query("UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL", [req.params.id, uid]);
    return reply.code(204).send();
  });

  return app;
}
