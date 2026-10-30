// Plain, accessible, transactional emails: one column, real text, every value escaped. Templates only ever see what is
// listed in the contexts below. They never receive ticket ids, QR data, holder keys or surnames, so they cannot leak them.

const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const when = (iso) => new Date(iso).toLocaleString("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
const inr = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const SUPPORT = "support@authentix.test";

const REFUND_REASON = {
  seats_unavailable: "the seats were no longer available by the time your payment went through",
  sold_out: "the tickets sold out while you were paying",
  late_payment: "your payment arrived after your booking time had ended",
};

/** Wraps paragraphs (and an optional button-style link) in a minimal single-column page. */
function page({ heading, paragraphs, cta }) {
  const p = paragraphs.map((t) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px">${escapeHtml(t)}</p>`).join("");
  const button = cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(cta.url)}" style="background:#0c7c70;color:#ffffff;padding:12px 24px;border-radius:24px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p><p style="margin:0 0 16px;font-size:14px;color:#545459">Or copy this link: ${escapeHtml(cta.url)}</p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(heading)}</title></head><body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#131316;background:#ffffff"><main style="max-width:560px;margin:0 auto"><h1 style="font-size:22px;line-height:28px;margin:0 0 16px">${escapeHtml(heading)}</h1>${p}${button}<hr style="border:0;border-top:1px solid #dddddd;margin:24px 0"><p style="font-size:13px;color:#545459">Authentix: tickets tied to real, verified people. Questions? ${escapeHtml(SUPPORT)}</p></main></body></html>`;
}

function build({ subject, heading, paragraphs, cta }) {
  const text = [`${heading}`, "", ...paragraphs, ...(cta ? ["", `${cta.label}: ${cta.url}`] : []), "", `Authentix. Questions? ${SUPPORT}`].join("\n");
  return { subject, text, html: page({ heading, paragraphs, cta }) };
}

const eventLines = (ev) => [`${ev.title}`, `${ev.venue.name}, ${ev.venue.city}`, when(ev.startsAt)];

/** Email templates. Each takes a small, explicit context. */
export const EMAIL = {
  verify_email: ({ firstName, link }) =>
    build({
      subject: "Confirm your email for Authentix",
      heading: `Hi ${firstName}, confirm your email`,
      paragraphs: ["Confirm your email address to start booking. The link works once.", "If you didn’t create an Authentix account, you can ignore this message."],
      cta: { label: "Confirm my email", url: link },
    }),

  user_verified: ({ firstName, webBaseUrl }) =>
    build({
      subject: "You’re verified on Authentix",
      heading: `You’re verified, ${firstName}`,
      paragraphs: ["Your identity check is complete. You can book tickets now.", "We only keep a scrambled fingerprint of your Aadhaar and its last four digits, never the number."],
      cta: { label: "Find an event", url: `${webBaseUrl}/` },
    }),

  order_confirmed: ({ firstName, event, order, webBaseUrl }) =>
    build({
      subject: `Your tickets for ${event.title} are confirmed`,
      heading: `You’re going, ${firstName}!`,
      paragraphs: [
        ...eventLines(event),
        `${order.items.map((i) => (i.seatLabel ? i.seatLabel : `${i.quantity} × general admission`)).join(", ")}`,
        `Total paid: ${inr(order.totalInr)}. Order reference ${order.ref}.`,
        "Your entry code appears in My tickets. It changes every 30 seconds, so screenshots won’t work.",
      ],
      cta: { label: "Open my tickets", url: `${webBaseUrl}/tickets` },
    }),

  order_refunded: ({ firstName, event, order, reason, webBaseUrl }) =>
    build({
      subject: `Your refund for ${event.title}`,
      heading: `We’ve refunded your payment, ${firstName}`,
      paragraphs: [
        `We’re sorry: ${REFUND_REASON[reason] ?? "we couldn’t complete your booking"}.`,
        `The full amount you paid for ${event.title} has been refunded to your original payment method. Order reference ${order.ref}.`,
      ],
      cta: { label: "Browse events", url: `${webBaseUrl}/` },
    }),

  ticket_received: ({ firstName, event, other, webBaseUrl }) =>
    build({
      subject: `You’ve received a ticket for ${event.title}`,
      heading: `A ticket for you, ${firstName}`,
      paragraphs: [`${other} sent you a ticket for ${event.title}.`, ...eventLines(event).slice(1), "It’s in My tickets, with a new entry code only you can use."],
      cta: { label: "Open my tickets", url: `${webBaseUrl}/tickets` },
    }),

  ticket_sent: ({ firstName, event, other }) =>
    build({
      subject: `You transferred a ticket for ${event.title}`,
      heading: `Ticket transferred, ${firstName}`,
      paragraphs: [`You sent a ticket for ${event.title} to ${other}. Your old entry code no longer works.`, `If you didn’t do this, contact ${SUPPORT} straight away.`],
    }),
};

/** In-app inbox entries (short, app-relative links). */
export const INBOX = {
  email_confirmed: () => ({ kind: "account", title: "Email confirmed", body: "Next, verify your identity so you can book.", link: "/verify" }),
  user_verified: () => ({ kind: "account", title: "You’re verified", body: "You can book tickets now.", link: "/" }),
  tickets_ready: ({ count }) => ({ kind: "tickets", title: count === 1 ? "Your ticket is ready" : `Your ${count} tickets are ready`, body: "Open My tickets to see your entry code.", link: "/tickets" }),
  order_confirmed: ({ event }) => ({ kind: "order", title: "Booking confirmed", body: `${event.title}: your tickets are confirmed.`, link: "/tickets" }),
  order_refunded: ({ event }) => ({ kind: "order", title: "Payment refunded", body: `${event.title}: we refunded your payment in full.`, link: "/" }),
  ticket_received: ({ event, other }) => ({ kind: "tickets", title: "You received a ticket", body: `${other} sent you a ticket for ${event.title}.`, link: "/tickets" }),
  ticket_sent: ({ event, other }) => ({ kind: "tickets", title: "Ticket transferred", body: `You sent a ticket for ${event.title} to ${other}.`, link: "/tickets" }),
};

export { escapeHtml };
