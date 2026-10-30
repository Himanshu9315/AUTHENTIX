import { createHash } from "node:crypto";
import { PermanentError } from "@authentix/events";
import {
  orderConfirmedSchema,
  orderRefundedSchema,
  ticketIssuedSchema,
  ticketTransferredSchema,
  userEmailVerificationRequestedSchema,
  userEmailVerifiedSchema,
  userVerifiedSchema,
} from "@authentix/schemas";
import { EMAIL, INBOX } from "./templates.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const firstWord = (name) => name.trim().split(/\s+/)[0] || "there";

// Which events are handled. user.registered is deliberately absent: the verification email is the welcome.
export const BINDINGS = [
  "user.email_verification_requested",
  "user.email_verified",
  "user.verified",
  "order.confirmed",
  "order.refunded",
  "ticket.issued",
  "ticket.transferred",
];
const SCHEMAS = {
  "user.email_verification_requested": userEmailVerificationRequestedSchema,
  "user.email_verified": userEmailVerifiedSchema,
  "user.verified": userVerifiedSchema,
  "order.confirmed": orderConfirmedSchema,
  "order.refunded": orderRefundedSchema,
  "ticket.issued": ticketIssuedSchema,
  "ticket.transferred": ticketTransferredSchema,
};

/**
 * Turns events into emails and inbox entries. Safe under at-least-once delivery:
 *  - inbox rows have a unique dedupe key (written exactly once),
 *  - each email is CLAIMED in `deliveries`, sent, then marked sent. A crash between "sent" and "marked" can repeat one email,
 *    which a deterministic Message-ID lets mail programs collapse. Exactly-once email isn't possible over SMTP.
 * Nothing is stored about the message itself: the verification token exists only in a local variable and the outgoing mail.
 * @param {{ pool: import("pg").Pool, clients: any, sink: { sendMail: Function }, logger: any, config: { webBaseUrl: string, mailFrom: string, maxEmailsPerHour?: number, claimStaleSeconds?: number } }} deps
 */
export function createNotifier({ pool, clients, sink, logger, config }) {
  const cap = config.maxEmailsPerHour ?? 20;
  const stale = config.claimStaleSeconds ?? 120;

  async function contactOf(userId, requestId) {
    let res;
    try {
      res = await clients.getContact(userId, requestId);
    } catch {
      throw new Error("auth-service unreachable"); // transient: the consumer retries
    }
    if (res.status === 404) throw new PermanentError("recipient not found");
    if (res.status !== 200) throw new Error(`auth-service answered ${res.status}`);
    return res.json;
  }
  async function eventOf(eventId, requestId) {
    let res;
    try {
      res = await clients.getEvent(eventId, requestId);
    } catch {
      throw new Error("catalog-service unreachable");
    }
    if (res.status === 404) throw new PermanentError("event not found");
    if (res.status !== 200) throw new Error(`catalog-service answered ${res.status}`);
    return res.json;
  }

  const inbox = (eventId, userId, template, ctx) => {
    const item = INBOX[template](ctx);
    return pool.query(
      "INSERT INTO notifications (dedupe_key, user_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING",
      [`${eventId}:${userId}:inapp:${template}`, userId, item.kind, item.title, item.body, item.link],
    );
  };

  /** Claim, send, mark. Returns "sent", "skipped" or "suppressed"; throws to make the consumer retry. */
  async function email(eventId, userId, template, to, ctx) {
    const key = `${eventId}:${userId}:email:${template}`;

    // The cap never applies to the verification email: dropping it would leave someone unable to confirm their address
    // (auth's own 60-second resend rule already limits how many of those can be requested).
    const recent = template === "verify_email" ? { rows: [{ n: 0 }] } : await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE user_id = $1 AND channel = 'email' AND status = 'sent' AND sent_at > now() - interval '1 hour'", [userId]);
    if (recent.rows[0].n >= cap) {
      await pool.query("INSERT INTO deliveries (dedupe_key, event_id, user_id, channel, template, status) VALUES ($1,$2,$3,'email',$4,'suppressed') ON CONFLICT DO NOTHING", [key, eventId, userId, template]);
      logger.warn({ userId, template, reason: "cap" }, "email suppressed");
      return "suppressed";
    }

    const claim = await pool.query(
      `INSERT INTO deliveries (dedupe_key, event_id, user_id, channel, template, status, attempts, claimed_at)
       VALUES ($1,$2,$3,'email',$4,'sending',1,now())
       ON CONFLICT (dedupe_key) DO UPDATE SET attempts = deliveries.attempts + 1, claimed_at = now()
         WHERE deliveries.status = 'sending' AND (deliveries.claimed_at IS NULL OR deliveries.claimed_at < now() - make_interval(secs => $5))
       RETURNING attempts`,
      [key, eventId, userId, template, stale],
    );
    if (claim.rows.length === 0) {
      const { rows } = await pool.query("SELECT status FROM deliveries WHERE dedupe_key = $1", [key]);
      if (rows[0]?.status === "sending") throw new Error("delivery in progress elsewhere; retry later");
      return "skipped"; // already sent or suppressed
    }

    const message = EMAIL[template](ctx);
    try {
      await sink.sendMail({ from: config.mailFrom, to, subject: message.subject, text: message.text, html: message.html, messageId: `<${sha(key)}@notify.authentix.local>` });
    } catch {
      await pool.query("UPDATE deliveries SET claimed_at = NULL WHERE dedupe_key = $1", [key]); // let the retry take it straight away
      throw new Error("smtp send failed"); // deliberately drops the original error: it can contain the recipient or the body
    }
    await pool.query("UPDATE deliveries SET status = 'sent', sent_at = now() WHERE dedupe_key = $1", [key]);
    logger.info({ userId, template }, "email sent");
    return "sent";
  }

  const suppress = (eventId, userId, template) =>
    pool.query("INSERT INTO deliveries (dedupe_key, event_id, user_id, channel, template, status) VALUES ($1,$2,$3,'email',$4,'suppressed') ON CONFLICT DO NOTHING", [`${eventId}:${userId}:email:${template}`, eventId, userId, template]);

  const orderCtx = (p) => ({ ref: p.orderId.slice(0, 8), items: p.items, totalInr: p.totalInr });

  return async function handle(event) {
    const schema = SCHEMAS[event.type];
    if (!schema) return; // not an event we notify about
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success) throw new PermanentError(`${event.type} payload failed validation`);
    const p = parsed.data;
    const web = config.webBaseUrl;
    const rid = event.requestId;

    switch (event.type) {
      case "user.email_verification_requested": {
        const c = await contactOf(p.userId, rid);
        if (c.emailVerified) return void (await suppress(event.id, p.userId, "verify_email")); // they confirmed some other way
        // The link carries the token in the #fragment, so it never reaches a web server's access log or a Referer header.
        const link = `${web}/verify-email#token=${encodeURIComponent(p.token)}`;
        await email(event.id, p.userId, "verify_email", p.email, { firstName: firstWord(p.name), link });
        return;
      }
      case "user.email_verified":
        await inbox(event.id, p.userId, "email_confirmed", {});
        return;
      case "user.verified": {
        const c = await contactOf(p.userId, rid);
        await inbox(event.id, p.userId, "user_verified", {});
        await email(event.id, p.userId, "user_verified", c.email, { firstName: c.firstName, webBaseUrl: web });
        return;
      }
      case "order.confirmed": {
        const [c, ev] = await Promise.all([contactOf(p.userId, rid), eventOf(p.eventId, rid)]);
        await inbox(event.id, p.userId, "order_confirmed", { event: ev });
        await email(event.id, p.userId, "order_confirmed", c.email, { firstName: c.firstName, event: ev, order: orderCtx(p), webBaseUrl: web });
        return;
      }
      case "order.refunded": {
        const [c, ev] = await Promise.all([contactOf(p.userId, rid), eventOf(p.eventId, rid)]);
        // The refund event carries no amount, so the email says "the full amount" and the order reference identifies it.
        const order = { ref: p.orderId.slice(0, 8) };
        await inbox(event.id, p.userId, "order_refunded", { event: ev, order });
        await email(event.id, p.userId, "order_refunded", c.email, { firstName: c.firstName, event: ev, order, reason: p.reason, webBaseUrl: web });
        return;
      }
      case "ticket.issued":
        await inbox(event.id, p.userId, "tickets_ready", { count: p.ticketIds.length });
        return;
      case "ticket.transferred": {
        const [to, from, ev] = await Promise.all([contactOf(p.toUserId, rid), contactOf(p.fromUserId, rid), eventOf(p.eventId, rid)]);
        await inbox(event.id, p.toUserId, "ticket_received", { event: ev, other: from.displayName });
        await inbox(event.id, p.fromUserId, "ticket_sent", { event: ev, other: to.displayName });
        await email(event.id, p.toUserId, "ticket_received", to.email, { firstName: to.firstName, event: ev, other: from.displayName, webBaseUrl: web });
        await email(event.id, p.fromUserId, "ticket_sent", from.email, { firstName: from.firstName, event: ev, other: to.displayName });
        return;
      }
    }
  };
}
