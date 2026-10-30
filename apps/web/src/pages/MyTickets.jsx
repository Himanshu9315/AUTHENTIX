import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate } from "react-router-dom";
import QrDialog from "../components/QrDialog.jsx";
import TransferDialog from "../components/TransferDialog.jsx";
import { ShieldCheck } from "../components/Icons.jsx";
import { useAuth } from "../lib/auth.jsx";
import { formatRange } from "../lib/format.js";
import { useFetch } from "../lib/useFetch.js";

export default function MyTickets() {
  const { signedIn, call } = useAuth();
  const events = useFetch(signedIn ? "/events?limit=50" : null);
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState(false);
  const [dialog, setDialog] = useState(null); // { kind: "qr" | "transfer", ticket }

  const load = useCallback(async () => {
    try {
      const { status, body } = await call("/tickets");
      if (status !== 200) throw new Error("load failed");
      setTickets(body.items);
      setError(false);
    } catch {
      setError(true);
    }
  }, [call]);
  useEffect(() => {
    if (signedIn) load();
  }, [signedIn, load]);

  // Tickets are issued a moment after payment. If the list is empty, keep looking for about 30 seconds before saying "none".
  const [lookups, setLookups] = useState(0);
  const looking = tickets !== null && tickets.length === 0 && lookups < 10;
  useEffect(() => {
    if (!looking) return;
    const t = setTimeout(() => {
      setLookups((n) => n + 1);
      load();
    }, 3000);
    return () => clearTimeout(t);
  }, [looking, lookups, load]);

  const byEvent = useMemo(() => Object.fromEntries((events.data?.items ?? []).map((e) => [e.id, e])), [events.data]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const t of tickets ?? []) m.set(t.eventId, [...(m.get(t.eventId) ?? []), t]);
    return [...m.entries()].sort(([a], [b]) => (Date.parse(byEvent[a]?.startsAt) || Infinity) - (Date.parse(byEvent[b]?.startsAt) || Infinity));
  }, [tickets, byEvent]);

  const close = useCallback(() => setDialog(null), []);
  const gone = useCallback(() => {
    setDialog(null);
    load(); // transferred away: drop it from the list
  }, [load]);

  if (!signedIn) return <Navigate to={`/login?next=${encodeURIComponent("/tickets")}`} replace />;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-headline3 text-ink">My tickets</h1>
      {error && !tickets && (
        <div role="alert" className="mt-6">
          <p className="text-body1 text-ink-secondary">We couldn’t load your tickets.</p>
          <button type="button" onClick={load} className="mt-3 rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Try again</button>
        </div>
      )}
      {!tickets && !error && <div aria-busy="true" className="mt-6 h-40 animate-pulse rounded-lg bg-bg-secondary" />}
      {looking && <p role="status" className="mt-6 text-body1 text-ink-secondary">Looking for your tickets… new purchases can take a few seconds to appear.</p>}
      {tickets && tickets.length === 0 && !looking && (
        <div className="mt-8 rounded-lg bg-bg-secondary p-8 text-center">
          <p className="text-title3 text-ink">No tickets yet</p>
          <p className="mt-1 text-body2 text-ink-secondary">Tickets appear here a few seconds after you pay.</p>
          <Link to="/" className="mt-4 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Find an event</Link>
        </div>
      )}
      <div className="mt-6 space-y-8">
        {groups.map(([eventId, items]) => {
          const ev = byEvent[eventId];
          return (
            <section key={eventId} aria-labelledby={`e-${eventId}`}>
              <div className="flex items-center gap-4">
                {ev && <img src={ev.posterUrl} alt="" className="h-20 w-16 shrink-0 rounded-md object-cover" />}
                <div>
                  <h2 id={`e-${eventId}`} className="text-title1 text-ink">{ev?.title ?? "Your event"}</h2>
                  {ev && <p className="text-body2 text-ink-secondary">{formatRange(ev.startsAt, ev.endsAt)} · {ev.venue.name}</p>}
                </div>
              </div>
              <ul className="mt-3 space-y-3">
                {items.map((t) => (
                  <li key={t.id} className="rounded-lg border border-line-moderate p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-title3 text-ink">{t.seatLabel ?? "General admission"}</p>
                        <p className="text-body2 text-ink-secondary">Holder: {t.holderName}</p>
                      </div>
                      <span className="inline-flex items-center gap-1 rounded-full bg-brand-surface px-2 py-1 text-label2 text-brand"><ShieldCheck width={14} height={14} /> {t.status === "used" ? "Used" : "Verified entry"}</span>
                    </div>
                    {t.status === "active" ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button type="button" onClick={() => setDialog({ kind: "qr", ticket: t })} className="h-11 rounded-full bg-brand px-5 text-title4 text-brand-on">Show entry code</button>
                        <button type="button" onClick={() => setDialog({ kind: "transfer", ticket: t })} disabled={!t.transferable} className="h-11 rounded-full border border-line-moderate px-5 text-title4 text-ink disabled:opacity-50">Transfer</button>
                        {!t.transferable && <span className="self-center text-body3 text-ink-tertiary">Transfer limit reached</span>}
                      </div>
                    ) : (
                      <p className="mt-3 text-body2 text-ink-secondary">Used{t.usedAt ? ` at ${new Date(t.usedAt).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })}` : ""}.</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {dialog?.kind === "qr" && <QrDialog ticket={dialog.ticket} event={byEvent[dialog.ticket.eventId]} onClose={close} onGone={gone} />}
      {dialog?.kind === "transfer" && <TransferDialog ticket={dialog.ticket} event={byEvent[dialog.ticket.eventId]} onClose={close} onDone={load} />}
    </div>
  );
}
