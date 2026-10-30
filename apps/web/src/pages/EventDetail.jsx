import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import TicketPicker from "../components/TicketPicker.jsx";
import { useAuth } from "../lib/auth.jsx";
import { useAdmission } from "../lib/useAdmission.js";
import { CalendarIcon, PinIcon, ShieldCheck } from "../components/Icons.jsx";
import VerifiedBadge from "../components/VerifiedBadge.jsx";
import { useFetch } from "../lib/useFetch.js";
import { formatPrice, formatRange } from "../lib/format.js";
import NotFound from "./NotFound.jsx";

/** Keyed by slug so moving between events never carries one event's selection into another. */
export default function EventDetail() {
  const { slug } = useParams();
  return <EventDetailInner key={slug} />;
}

function EventDetailInner() {
  const { slug } = useParams();
  const { data: e, loading, error } = useFetch(`/events/${encodeURIComponent(slug)}`);
  const inv = useFetch(e ? `/inventory/events/${e.id}` : null);
  const admission = useAdmission(e);
  const needsQueue = !!e?.hotSale && admission.state !== "admitted";
  const { signedIn, call } = useAuth();
  const navigate = useNavigate();
  const here = useLocation();
  const tiers = useRef(null);
  const [selection, setSelection] = useState({ seats: [], qty: {} });
  const [booking, setBooking] = useState(false);
  const [problem, setProblem] = useState(null);
  const bookKey = useRef(null); // reused until the server gives a definite answer, so a retry can't create a second order
  const inFlight = useRef(false);
  const alertRef = useRef(null);

  const { items, units, total } = useMemo(() => {
    if (!e) return { items: [], units: 0, total: 0 };
    const price = Object.fromEntries(e.tiers.map((t) => [t.id, t.priceInr]));
    const items = [
      ...selection.seats.map((s) => ({ tierId: s.tierId, seatId: s.id })),
      ...Object.entries(selection.qty).filter(([, q]) => q > 0).map(([tierId, quantity]) => ({ tierId, quantity })),
    ];
    const units = items.reduce((a, i) => a + (i.quantity ?? 1), 0);
    const total = items.reduce((a, i) => a + (i.quantity ?? 1) * price[i.tierId], 0);
    return { items, units, total };
  }, [e, selection]);

  // A different selection is a different request, so it gets a different idempotency key.
  const selectionKey = JSON.stringify(items);
  useEffect(() => {
    bookKey.current = null;
  }, [selectionKey]);
  useEffect(() => {
    if (problem) {
      alertRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      alertRef.current?.focus();
    }
  }, [problem]);

  if (error?.status === 404) return <NotFound />;
  if (error) return <p className="mx-auto max-w-7xl px-4 py-16 text-body1 text-ink-secondary">Couldn’t load this event. Please try again in a moment.</p>;
  if (loading) return <div className="mx-auto max-w-7xl px-4 py-8" aria-busy="true"><div className="aspect-[16/7] animate-pulse rounded-xl bg-bg-secondary" /></div>;

  const MESSAGES = {
    email_not_verified: "Verify your email before booking.",
    aadhaar_not_verified: "Verify your identity (Aadhaar) before booking. This is what keeps scalpers out.",
    admission_required: "This is a high-demand event. Join the queue to book.",
    admission_invalid: "Your place in the queue isn't valid. Join the queue again.",
    admission_expired: "Your time to book ran out. Join the queue again.",
    seats_unavailable: "Someone just took one of those seats. We've refreshed the map, so please choose again.",
    sold_out: "That ticket type just sold out.",
    event_not_on_sale: "Tickets for this event aren't on sale.",
    service_unavailable: "We couldn't check your account right now. Please try again in a moment.",
    try_again: "That took too long. Please try again.",
    account_not_found: "We couldn't find your account. Please sign in again.",
    event_not_found: "That event is no longer available.",
    invalid_items: "Something about that selection isn't valid. Please choose again.",
    too_many_tickets: "You can book up to 10 tickets at a time.",
    hold_failed: "We couldn't reserve those tickets. Please try again.",
  };

  const book = async () => {
    if (inFlight.current) return; // a double-click must not send a second request
    setProblem(null);
    if (!signedIn) return navigate(`/login?next=${encodeURIComponent(here.pathname)}`);
    if (needsQueue) return navigate(`/queue/${slug}`); // high-demand events: wait in line first
    if (units === 0) return tiers.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    inFlight.current = true;
    setBooking(true);
    bookKey.current ??= crypto.randomUUID();
    try {
      const { status, body } = await call("/booking/orders", { method: "POST", body: { eventId: e.id, items }, headers: { "idempotency-key": bookKey.current, ...(e.hotSale && admission.token ? { "admission-token": admission.token } : {}) } });
      if (status === 200 || status === 201) {
        bookKey.current = null;
        return navigate(`/checkout/${body.id}`);
      }
      if (status === 401) return navigate(`/login?next=${encodeURIComponent(here.pathname)}`);
      if (status >= 500) {
        // Outcome unknown (for example 503 try_again): keep the key so pressing the button again returns the same order.
        return setProblem({ text: MESSAGES[body.error] ?? "We couldn't confirm your booking. Please try again." });
      }
      bookKey.current = null; // a definite answer: the next click is a new request
      if (body.error === "ticket_cap_exceeded") {
        setProblem({ text: `You can hold up to ${body.cap} tickets for this event${body.remaining < body.cap ? ` (${body.remaining} left for you)` : ""}.` });
      } else {
        setProblem({ text: MESSAGES[body.error] ?? "We couldn't start your booking. Please try again.", verify: ["email_not_verified", "aadhaar_not_verified"].includes(body.error) });
      }
      if (body.error?.startsWith("admission_")) admission.refresh(); // our place may have expired: find out
      if (body.error === "seats_unavailable" || body.error === "sold_out") {
        setSelection({ seats: [], qty: {} });
        inv.reload();
      }
    } catch {
      setProblem({ text: "Network problem. Please try again." }); // key kept: a retry is the same request
    } finally {
      inFlight.current = false;
      setBooking(false);
    }
  };

  return (
    <article className="pb-28">
      <div className="relative overflow-hidden bg-bg-secondary">
        <img src={e.posterUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-30 blur-2xl" />
        <div className="relative mx-auto grid max-w-7xl gap-6 px-4 py-8 md:grid-cols-[18rem_1fr] md:items-end">
          <img src={e.posterUrl} alt={`${e.title} poster`} className="mx-auto aspect-[3/4] w-56 rounded-xl object-cover shadow-lg md:w-72" />
          <div>
            <p className="text-label1 capitalize text-ink-secondary"><Link className="hover:underline" to={`/search?category=${e.category}`}>{e.category}</Link></p>
            <h1 className="mt-1 text-headline2 text-ink md:text-headline1">{e.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <VerifiedBadge />
              {e.hotSale && <span className="rounded-full bg-ink px-2 py-1 text-label2 text-bg-primary">Hot sale</span>}
            </div>
            <dl className="mt-5 space-y-3">
              <div className="flex items-start gap-3"><dt className="sr-only">When</dt><CalendarIcon className="mt-0.5 shrink-0 text-ink-secondary" /><dd className="text-body1 text-ink">{formatRange(e.startsAt, e.endsAt)}</dd></div>
              <div className="flex items-start gap-3"><dt className="sr-only">Where</dt><PinIcon className="mt-0.5 shrink-0 text-ink-secondary" /><dd className="text-body1 text-ink">{e.venue.name}<span className="block text-body2 text-ink-secondary">{e.venue.address}</span></dd></div>
            </dl>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-10 px-4 pt-8">
        <section aria-labelledby="about">
          <h2 id="about" className="text-title1 text-ink">About</h2>
          <p className="mt-2 max-w-3xl text-body1 text-ink-secondary">{e.description}</p>
          <p className="mt-4 flex max-w-3xl items-start gap-2 rounded-lg bg-brand-surface p-4 text-body2 text-ink">
            <ShieldCheck className="mt-0.5 shrink-0 text-brand" />
            Entry is tied to a verified person. Up to {e.ticketCap} tickets per verified person for this event, and tickets can only be transferred to other verified users.
          </p>
        </section>

        {e.artists.length > 0 && (
          <section aria-labelledby="lineup">
            <h2 id="lineup" className="text-title1 text-ink">Line-up</h2>
            <ul className="mt-3 flex flex-wrap gap-6">
              {e.artists.map((a) => (
                <li key={a.slug}><Link to={`/search?q=${encodeURIComponent(a.name)}`} className="flex w-24 flex-col items-center gap-2 rounded-lg text-center"><img src={a.imageUrl} alt="" className="h-20 w-20 rounded-full" /><span className="text-label1 text-ink">{a.name}</span></Link></li>
              ))}
            </ul>
          </section>
        )}

        <section ref={tiers} aria-labelledby="tickets" className="scroll-mt-32">
          <h2 id="tickets" className="text-title1 text-ink">Tickets</h2>
          {e.hotSale && (
            <div className="mt-2 rounded-lg bg-brand-surface p-4 text-body2 text-ink" role="status">
              {admission.state === "admitted" ? (
                <p><strong>You’re in!</strong> You have {Math.floor(admission.secondsLeft / 60)}:{String(admission.secondsLeft % 60).padStart(2, "0")} to choose and book.</p>
              ) : admission.state === "waiting" ? (
                <p>You’re in the queue (place {admission.position}). <Link className="font-medium text-brand underline" to={`/queue/${slug}`}>Go to the waiting room</Link></p>
              ) : (
                <p>{admission.expired ? "Your time to book ran out. " : ""}This event is in high demand. You’ll wait in a short, fair online queue before you can book. <Link className="font-medium text-brand underline" to={`/queue/${slug}`}>Join the queue</Link></p>
              )}
            </div>
          )}
          {problem && (
            <p ref={alertRef} tabIndex={-1} role="alert" className="mt-2 rounded-md bg-bg-secondary p-3 text-body2 text-ink focus:outline-none">
              {problem.text} {problem.verify && <Link className="font-medium text-brand underline" to="/verify">Verify now</Link>}
            </p>
          )}
          <div className="mt-3">
            {inv.loading && <div className="h-40 animate-pulse rounded-lg bg-bg-secondary" aria-busy="true" />}
            {inv.error && <p className="text-body2 text-ink-secondary">Ticket availability couldn’t be loaded. Please refresh.</p>}
            {inv.data && <TicketPicker event={e} inventory={inv.data} selection={selection} setSelection={setSelection} />}
          </div>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line-subtle bg-bg-primary/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div aria-live="polite">
            {units > 0 ? (
              <>
                <p className="text-body3 text-ink-secondary">{units} {units === 1 ? "ticket" : "tickets"}</p>
                <p className="text-title2 text-ink">{formatPrice(total)}</p>
              </>
            ) : (
              <>
                <p className="text-body3 text-ink-secondary">Starts from</p>
                <p className="text-title2 text-ink">{e.priceFrom !== null ? formatPrice(e.priceFrom) : "—"}</p>
              </>
            )}
          </div>
          <button type="button" onClick={book} disabled={booking} className="h-12 rounded-full bg-brand px-8 text-title3 text-brand-on hover:opacity-90 disabled:opacity-60">
            {booking ? "Reserving…" : needsQueue ? "Join the queue" : units > 0 ? "Book tickets" : "Select tickets"}
          </button>
        </div>
      </div>
    </article>
  );
}
