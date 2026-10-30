import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { ShieldCheck } from "../components/Icons.jsx";
import { useAuth } from "../lib/auth.jsx";
import { formatPrice } from "../lib/format.js";
import { DEMO_HINTS } from "../lib/safeNext.js";

// Fictional test instruments (see payment-service). Shown so the demo can reach every outcome.
const TEST_CARDS = [
  { label: "Succeeds", number: "4242 4242 4242 4242" },
  { label: "Declined", number: "4000 0000 0000 0002" },
  { label: "Never answers", number: "4000 0000 0000 9999" },
];
const POLLING = ["PENDING", "PAYMENT_PENDING", "PAID", "REFUND_PENDING"];

const PAY_ERRORS = {
  hold_expired: "Your seats are no longer held. Please start again.",
  seats_unavailable: "Those seats were taken before you could pay. You haven't been charged.",
  payment_attempts_exhausted: "No payment attempts left for this order.",
  unsupported_test_instrument: "That isn't one of the demo test cards. Use a test card below.",
  invalid_state: "This order can't be paid right now.",
  idempotency_key_reused: "Your payment details changed since the last try. Press Pay again.",
};

function useCountdown(order, offsetMs) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!order?.holdExpiresAt) return null;
  return Math.max(0, Math.floor((Date.parse(order.holdExpiresAt) - (now + offsetMs)) / 1000));
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function Checkout() {
  const { id } = useParams();
  const { signedIn, call } = useAuth();
  const [order, setOrder] = useState(null);
  const [offset, setOffset] = useState(0);
  const [missing, setMissing] = useState(false);
  const [method, setMethod] = useState("card");
  const [form, setForm] = useState({ number: "", exp: "", cvc: "", vpa: "" });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const payKey = useRef(null); // kept until the server gives a definite answer, so a retry can't charge twice
  const paying = useRef(false);
  const seq = useRef(0); // only the newest response may update the page
  const dead = useRef(false);
  // Reset on mount too: React.StrictMode runs mount, cleanup, mount in dev, and a cleanup-only flag would stay true.
  useEffect(() => {
    dead.current = false;
    return () => {
      dead.current = true;
    };
  }, []);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { status, body } = await call(`/booking/orders/${id}`);
      if (dead.current || mine !== seq.current) return;
      if (status === 404 || status === 403) return setMissing(true);
      if (status !== 200) throw new Error("load failed");
      setOffset(Date.parse(body.serverTime) - Date.now()); // correct for a wrong clock on this device
      setOrder(body);
      setLoadError(false);
    } catch {
      if (!dead.current && mine === seq.current) setLoadError(true);
    }
  }, [call, id]);

  useEffect(() => {
    if (signedIn) load();
  }, [signedIn, load]);

  const left = useCountdown(order, offset);
  // Poll while something is in flight, and also once the hold has run out until the server says what happened to the order.
  const polling = !!order && (POLLING.includes(order.state) || (order.state === "HELD" && left === 0));
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [polling, load]);

  if (!signedIn) return <Navigate to={`/login?next=${encodeURIComponent(`/checkout/${id}`)}`} replace />;
  if (missing) return <Shell title="We couldn’t find that order"><Link className="text-brand underline" to="/">Back to events</Link></Shell>;
  if (!order && loadError) {
    return (
      <Shell title="We couldn’t load your order">
        <p role="alert" className="text-body1 text-ink-secondary">Check your connection and try again.</p>
        <button type="button" onClick={load} className="mt-4 rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Try again</button>
      </Shell>
    );
  }
  if (!order) return <Shell title="Loading your order…"><div aria-busy="true" className="h-32 animate-pulse rounded-lg bg-bg-secondary" /></Shell>;

  const submit = async (ev) => {
    ev.preventDefault();
    if (paying.current || cancelling) return; // double-submit guard (state alone is too slow for a fast double-click)
    paying.current = true;
    setBusy(true);
    setProblem(null);
    payKey.current ??= crypto.randomUUID();
    let body;
    if (method === "card") {
      const [mm, yy] = form.exp.split("/").map((x) => Number(x.trim()));
      body = { method: "card", card: { number: form.number, expMonth: mm, expYear: yy < 100 ? 2000 + yy : yy, cvc: form.cvc } };
    } else {
      body = { method: "upi", upi: { vpa: form.vpa } };
    }
    setForm({ number: "", exp: "", cvc: "", vpa: "" }); // card details leave memory as soon as they are sent
    try {
      const res = await call(`/booking/orders/${id}/pay`, { method: "POST", body, headers: { "idempotency-key": payKey.current } });
      if (res.status === 202) {
        payKey.current = null;
        seq.current++; // drop any older in-flight poll so it can't overwrite this newer order state
        setOrder(res.body);
      } else if (res.status >= 500) {
        // Unknown outcome: keep the key, so pressing Pay again can't start a second payment, and refresh the order.
        setProblem("We couldn't confirm that payment. Check the status below, or try again.");
        load();
      } else {
        // A definite answer, so the next press is a new attempt (with a new key).
        payKey.current = null;
        setProblem(PAY_ERRORS[res.body.error] ?? (res.status === 400 ? "Check your payment details." : "Payment couldn't start. Please try again."));
        if (res.body.error) load();
      }
    } catch {
      setProblem("Network problem. Your payment was not confirmed, so check the order status before trying again.");
      load();
    } finally {
      paying.current = false;
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (paying.current || cancelling) return;
    setCancelling(true);
    setProblem(null);
    try {
      const { status } = await call(`/booking/orders/${id}/cancel`, { method: "POST", body: {}, headers: { "idempotency-key": crypto.randomUUID() } });
      if (status === 200) await load();
      else setProblem("We couldn't cancel this order right now. Please try again.");
    } catch {
      setProblem("Network problem. Please try again.");
    } finally {
      setCancelling(false);
    }
  };

  const field = "mt-1 h-12 w-full rounded-lg border border-line-moderate bg-bg-primary px-4 text-body1 text-ink";
  const summary = (
    <section aria-labelledby="sum" className="rounded-lg border border-line-moderate p-4">
      <h2 id="sum" className="text-title3 text-ink">Your order</h2>
      <ul className="mt-2 space-y-1">
        {order.items.map((i, n) => (
          <li key={n} className="flex justify-between text-body2 text-ink">
            <span>{i.seatLabel ?? `${i.quantity} × ticket`}</span>
            <span>{formatPrice(i.unitPriceInr * i.quantity)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 flex justify-between border-t border-line-subtle pt-3 text-title3 text-ink"><span>Total</span><span>{formatPrice(order.totalInr)}</span></p>
    </section>
  );

  if (order.state === "CONFIRMED") {
    return (
      <Shell title="You're going! 🎉" icon>
        <p className="text-body1 text-ink-secondary">Payment received and your tickets are confirmed.</p>
        <div className="mt-4">{summary}</div>
        <p className="mt-3 text-body3 text-ink-tertiary">Order {order.id.slice(0, 8)}. Your tickets with a rotating entry code arrive in the next release.</p>
        <Link to="/" className="mt-6 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Keep exploring</Link>
      </Shell>
    );
  }
  if (["PENDING", "PAYMENT_PENDING", "PAID"].includes(order.state)) {
    return (
      <Shell title={order.state === "PENDING" ? "Reserving your seats…" : "Processing your payment…"}>
        <p role="status" className="text-body1 text-ink-secondary">Please keep this page open. This usually takes a few seconds.</p>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-bg-secondary"><div className="h-full w-1/3 animate-pulse rounded-full bg-brand" /></div>
        <div className="mt-6">{summary}</div>
      </Shell>
    );
  }
  if (order.state === "REFUND_PENDING" || order.state === "REFUNDED") {
    return (
      <Shell title={order.state === "REFUNDED" ? "We've refunded you" : "Refunding your payment…"}>
        <p role="status" className="text-body1 text-ink-secondary">Your payment went through, but the seats were no longer available. {order.state === "REFUNDED" ? "The full amount has been refunded." : "We're refunding the full amount now."}</p>
        <Link to="/" className="mt-6 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Back to events</Link>
      </Shell>
    );
  }
  if (order.state !== "HELD") {
    const why = { EXPIRED: "Your seats were held for a limited time and that time ran out.", CANCELLED: "You cancelled this order.", FAILED: order.failureReason === "payment_failed" ? "The payment didn't go through after 3 attempts." : "We couldn't hold those tickets." };
    return (
      <Shell title="This order has ended">
        <p className="text-body1 text-ink-secondary">{why[order.state] ?? "This order can't be completed."} You haven't been charged.</p>
        <Link to="/" className="mt-6 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Back to events</Link>
      </Shell>
    );
  }

  return (
    <Shell title="Checkout">
      <p className={`rounded-lg p-3 text-body2 ${left !== null && left < 60 ? "bg-bg-secondary text-ink" : "bg-brand-surface text-ink"}`} role="timer" aria-live="off">
        Your tickets are held for <strong>{left === null ? "…" : mmss(left)}</strong>
      </p>
      {/* Screen readers hear the countdown only at the moments that matter, not every second. */}
      <p className="sr-only" role="status">{left === 0 ? "Your hold has ended. Checking your order." : left !== null && left <= 60 ? "One minute left to pay." : ""}</p>
      {order.attempts > 0 && <p role="alert" className="mt-3 text-body2 text-ink">That payment didn't go through. You can try again ({3 - order.attempts} {3 - order.attempts === 1 ? "try" : "tries"} left).</p>}
      <div className="mt-4">{summary}</div>

      <form onSubmit={submit} className="mt-6 space-y-4" aria-labelledby="pay">
        <h2 id="pay" className="text-title2 text-ink">Pay</h2>
        <fieldset className="flex gap-2">
          <legend className="sr-only">Payment method</legend>
          {[["card", "Card"], ["upi", "UPI"]].map(([v, l]) => (
            <label key={v} className="cursor-pointer">
              <input type="radio" name="method" value={v} checked={method === v} onChange={() => setMethod(v)} className="peer sr-only" />
              <span className="block rounded-full border border-line-moderate px-4 py-2 text-label1 text-ink peer-checked:border-brand peer-checked:bg-brand-surface peer-checked:text-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand">{l}</span>
            </label>
          ))}
        </fieldset>
        {method === "card" ? (
          <>
            <div><label htmlFor="cn" className="text-label1 text-ink">Card number</label><input id="cn" inputMode="numeric" autoComplete="cc-number" required value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} className={field} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><label htmlFor="ce" className="text-label1 text-ink">Expiry (MM/YY)</label><input id="ce" autoComplete="cc-exp" placeholder="12/30" required pattern="\d{1,2}\s*/\s*\d{2,4}" value={form.exp} onChange={(e) => setForm({ ...form, exp: e.target.value })} className={field} /></div>
              <div><label htmlFor="cc" className="text-label1 text-ink">CVC</label><input id="cc" inputMode="numeric" autoComplete="cc-csc" required pattern="\d{3,4}" maxLength={4} value={form.cvc} onChange={(e) => setForm({ ...form, cvc: e.target.value })} className={field} /></div>
            </div>
          </>
        ) : (
          <div><label htmlFor="vpa" className="text-label1 text-ink">UPI ID</label><input id="vpa" required value={form.vpa} onChange={(e) => setForm({ ...form, vpa: e.target.value })} className={field} /></div>
        )}
        {DEMO_HINTS && <div className="rounded-lg bg-bg-secondary p-3">
          <p className="text-label1 text-ink">Demo payments only. No real money moves.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {method === "card"
              ? TEST_CARDS.map((c) => <button key={c.label} type="button" onClick={() => setForm({ number: c.number, exp: "12/30", cvc: "123", vpa: "" })} className="rounded-full border border-line-moderate px-3 py-1 text-label2 text-ink">{c.label}</button>)
              : [["Succeeds", "success@authentix"], ["Declined", "fail@authentix"], ["Never answers", "timeout@authentix"]].map(([l, v]) => <button key={l} type="button" onClick={() => setForm({ ...form, vpa: v })} className="rounded-full border border-line-moderate px-3 py-1 text-label2 text-ink">{l}</button>)}
          </div>
        </div>}
        {problem && <p role="alert" className="text-body2 text-ink">{problem}</p>}
        <button type="submit" disabled={busy || cancelling || left === 0} className="h-12 w-full rounded-full bg-brand text-title3 text-brand-on disabled:opacity-60">{busy ? "Starting payment…" : `Pay ${formatPrice(order.totalInr)}`}</button>
        <button type="button" onClick={cancel} disabled={busy || cancelling} className="w-full text-label1 text-ink-secondary underline disabled:opacity-60">{cancelling ? "Cancelling…" : "Cancel and release my seats"}</button>
      </form>
    </Shell>
  );
}

function Shell({ title, icon, children }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="flex items-center gap-2 text-headline3 text-ink">{icon && <ShieldCheck className="text-brand" />}{title}</h1>
      <div className="mt-4">{children}</div>
    </div>
  );
}
