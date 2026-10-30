import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { z } from "zod";
import { REQUEST_ID_HEADER } from "@authentix/logger";

const SEED = JSON.parse(readFileSync(new URL("../seed/aadhaar-test-numbers.json", import.meta.url), "utf8"));
const OUTAGE_UID = "100000009001";
const SLOW_UID = "100000009002";
const MAX_ATTEMPTS = 5;
const TXN_TTL_MS = 10 * 60_000;

const sendSchema = z.object({ uid: z.string().regex(/^\d{12}$/) });
const verifySchema = z.object({ txnId: z.string().min(8).max(64), otp: z.string().regex(/^\d{6}$/) });

/**
 * Fake UIDAI. Dev only: the OTP is a fixed value and nothing is ever sent anywhere.
 * @param {{ logger: any, config: { otp: string, slowMs?: number } }} deps
 */
export async function buildApp({ logger, config }) {
  const app = Fastify({ loggerInstance: logger, requestIdHeader: REQUEST_ID_HEADER });
  const known = new Set([...SEED.numbers, OUTAGE_UID, SLOW_UID]);
  /** @type {Map<string, { attempts: number, expiresAt: number, verified: boolean }>} */
  const txns = new Map();

  const bad = (reply, code, error) => reply.code(code).send({ error });

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));

  app.post("/uidai/otp/send", async (req, reply) => {
    const body = sendSchema.safeParse(req.body);
    if (!body.success) return bad(reply, 400, "validation_error");
    const { uid } = body.data;
    if (uid === OUTAGE_UID) return bad(reply, 503, "uidai_unavailable");
    if (uid === SLOW_UID) await new Promise((r) => setTimeout(r, config.slowMs ?? 4000));
    if (!known.has(uid)) return bad(reply, 404, "uid_not_found");
    const txnId = randomBytes(12).toString("hex");
    txns.set(txnId, { attempts: 0, expiresAt: Date.now() + TXN_TTL_MS, verified: false });
    return { txnId };
  });

  // A correct OTP stays valid for repeats of the same txn so a client retry after a timeout is safe.
  app.post("/uidai/otp/verify", async (req, reply) => {
    const body = verifySchema.safeParse(req.body);
    if (!body.success) return bad(reply, 400, "validation_error");
    const { txnId, otp } = body.data;
    const txn = txns.get(txnId);
    if (!txn || txn.expiresAt < Date.now()) {
      txns.delete(txnId);
      return bad(reply, 410, "txn_expired");
    }
    if (txn.attempts >= MAX_ATTEMPTS && !txn.verified) return bad(reply, 410, "too_many_attempts");
    if (otp !== config.otp) {
      txn.attempts += 1;
      return bad(reply, 400, "otp_mismatch");
    }
    txn.verified = true;
    return { verified: true };
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, t] of txns) if (t.expiresAt < now) txns.delete(id);
  }, 60_000).unref();

  return app;
}
