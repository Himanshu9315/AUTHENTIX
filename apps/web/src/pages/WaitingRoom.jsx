import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { ShieldCheck } from "../components/Icons.jsx";
import { useAuth } from "../lib/auth.jsx";
import { useFetch } from "../lib/useFetch.js";

const JOIN_ERRORS = {
  email_not_verified: ["Confirm your email first.", true],
  aadhaar_not_verified: ["Verify your identity (Aadhaar) first. It keeps scalpers out of the line.", true],
  rate_limited: ["You’ve tried a lot in a minute. Please wait a moment.", false],
  service_unavailable: ["We couldn’t reach the queue just now. Please try again.", false],
  event_not_on_sale: ["Tickets for this event aren’t on sale.", false],
};
const eta = (s) => (s <= 60 ? `about ${Math.max(5, Math.round(s / 5) * 5)} seconds` : `about ${Math.ceil(s / 60)} minutes`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** Keyed by slug so moving between events never carries one event's line into another. */
export default function WaitingRoom() {
  const { slug } = useParams();
  return <Room key={slug} slug={slug} />;
}

function Room({ slug }) {
  const { signedIn, call } = useAuth();
  const navigate = useNavigate();
  const { data: event, error: eventError } = useFetch(`/events/${encodeURIComponent(slug)}`);
  const [view, setView] = useState({ kind: "joining" }); // joining | waiting | admitted | dropped | blocked | failed
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [flaky, setFlaky] = useState(false);
  const dead = useRef(false);
  const timer = useRef(null);
  const started = useRef(false);

  const apply = useCallback((b) => {
    setOffset(Date.parse(b.serverTime) - Date.now());
    if (b.state === "waiting") setView({ kind: "waiting", ...b });
    else if (b.state === "admitted") setView({ kind: "admitted", ...b });
    else setView((v) => (v.kind === "waiting" || v.kind === "admitted" ? { kind: "dropped", was: v.kind } : v));
  }, []);

  // Checking in every few seconds is what keeps your place: the server drops people who go quiet.
  const poll = useCallback(async () => {
    if (dead.current || !event) return;
    try {
      const { status, body } = await call(`/queue/events/${event.id}/me`);
      if (dead.current) return;
      if (status === 200) {
        setFlaky(false);
        apply(body);
        if (body.state !== "waiting") return; // admitted, or dropped: nothing more to watch until the person acts
      } else setFlaky(true);
    } catch {
      if (!dead.current) setFlaky(true); // your place is kept for a while, so keep trying quietly
    }
    timer.current = setTimeout(poll, 3000 + Math.random() * 1000);
  }, [call, event, apply]);

  const join = useCallback(async () => {
    clearTimeout(timer.current); // never run two polling chains at once
    setView({ kind: "joining" });
    try {
      const { status, body } = await call(`/queue/events/${event.id}/join`, { method: "POST", body: {} });
      if (dead.current) return;
      if (status === 200) {
        apply(body);
        if (body.state === "waiting") timer.current = setTimeout(poll, 3000);
      } else if (status === 409 && body.error === "queue_not_needed") navigate(`/events/${slug}`, { replace: true });
      else setView({ kind: JOIN_ERRORS[body.error]?.[1] ? "blocked" : "failed", error: body.error });
    } catch {
      if (!dead.current) setView({ kind: "failed", error: "service_unavailable" });
    }
  }, [call, event, apply, poll, navigate, slug]);

  useEffect(() => {
    dead.current = false;
    return () => {
      dead.current = true;
      clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (!signedIn || !event || started.current) return;
    started.current = true;
    join();
  }, [signedIn, event, join]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => document.visibilityState === "visible" && view.kind === "waiting" && (clearTimeout(timer.current), poll());
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [view.kind, poll]);

  // Once let in, go straight to choosing tickets.
  useEffect(() => {
    if (view.kind !== "admitted") return;
    const t = setTimeout(() => navigate(`/events/${slug}`), 2500);
    return () => clearTimeout(t);
  }, [view.kind, navigate, slug]);

  const leave = async () => {
    clearTimeout(timer.current);
    dead.current = true;
    try {
      await call(`/queue/events/${event.id}/me`, { method: "DELETE" });
    } catch {
      /* the server drops people who go quiet anyway */
    }
    navigate(`/events/${slug}`);
  };

  if (!signedIn) return <Navigate to={`/login?next=${encodeURIComponent(`/queue/${slug}`)}`} replace />;
  if (eventError) return <Shell title="We couldn’t find that event"><Link className="text-brand underline" to="/">Back to events</Link></Shell>;
  if (!event) return <Shell title="Loading…"><div aria-busy="true" className="h-32 animate-pulse rounded-lg bg-bg-secondary" /></Shell>;

  const button = "mt-4 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on";
  return (
    <Shell title={event.title}>
      <p className="flex items-center gap-2 text-body2 text-ink-secondary"><ShieldCheck className="text-brand" width={18} height={18} /> High demand: the queue keeps it fair for everyone.</p>

      {view.kind === "joining" && <p role="status" className="mt-6 text-body1 text-ink-secondary">Joining the queue…</p>}

      {view.kind === "waiting" && (
        <section className="mt-6 rounded-xl bg-brand-surface p-6 text-center" aria-labelledby="pos">
          <h2 id="pos" className="text-body1 text-ink-secondary">Your place in line</h2>
          <p className="mt-1 text-display2 text-ink" role="status" aria-live="polite">{view.position}</p>
          <p className="text-body1 text-ink">{view.ahead === 0 ? "You’re next." : `${view.ahead} ${view.ahead === 1 ? "person is" : "people are"} ahead of you.`}</p>
          <p className="mt-2 text-body2 text-ink-secondary">Wait: {eta(view.etaSeconds)}. {view.total} in the queue.</p>
          <div className="mx-auto mt-4 h-2 max-w-xs overflow-hidden rounded-full bg-bg-primary" aria-hidden="true"><div className="h-full w-1/3 animate-pulse rounded-full bg-brand" /></div>
          {flaky && <p role="status" className="mt-3 text-body2 text-ink">Reconnecting… your place is safe for a short while.</p>}
          <p className="mt-4 text-body3 text-ink-secondary">Keep this page open. You can switch tabs, but if you close it for more than a minute or two you’ll lose your place.</p>
          <button type="button" onClick={leave} className="mt-4 text-label1 text-ink-secondary underline">Leave the queue</button>
        </section>
      )}

      {view.kind === "admitted" && (
        <section className="mt-6 rounded-xl bg-brand-surface p-6 text-center">
          <h2 className="text-headline3 text-ink">You’re in!</h2>
          <p role="status" className="mt-2 text-body1 text-ink">You have <strong>{mmss(Math.max(0, Math.floor((Date.parse(view.expiresAt) - (now + offset)) / 1000)))}</strong> to choose and book your tickets.</p>
          <Link to={`/events/${slug}`} className={button}>Choose tickets now</Link>
        </section>
      )}

      {view.kind === "dropped" && (
        <section role="alert" className="mt-6 rounded-xl bg-bg-secondary p-6 text-center">
          <h2 className="text-title1 text-ink">{view.was === "admitted" ? "Your booking time ran out" : "You were removed from the queue"}</h2>
          <p className="mt-2 text-body2 text-ink-secondary">{view.was === "admitted" ? "The time to book has ended." : "You were away for too long, so your place was given up."} You can join again, at the back of the line.</p>
          <button type="button" onClick={join} className={button}>Join the queue again</button>
        </section>
      )}

      {(view.kind === "blocked" || view.kind === "failed") && (
        <section role="alert" className="mt-6 rounded-xl bg-bg-secondary p-6">
          <p className="text-body1 text-ink">{JOIN_ERRORS[view.error]?.[0] ?? "We couldn’t put you in the queue."}</p>
          {view.kind === "blocked" ? <Link to={`/verify?next=${encodeURIComponent(`/queue/${slug}`)}`} className={button}>Verify now</Link> : <button type="button" onClick={join} className={button}>Try again</button>}
        </section>
      )}
    </Shell>
  );
}

function Shell({ title, children }) {
  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <h1 className="text-headline3 text-ink">{title}</h1>
      <div className="mt-3">{children}</div>
    </div>
  );
}
