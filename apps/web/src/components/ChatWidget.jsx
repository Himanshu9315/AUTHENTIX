import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { safeNext } from "../lib/safeNext.js";

const MAX = 500;
const GREETING = "Hi! I can help with booking, verification, transfers and entry. For prices and availability I'll check the event page for you.";

/** Slug of the event page the visitor is on, so "how much is it?" means THIS event. */
const slugOf = (pathname) => /^\/events\/([a-z0-9][a-z0-9-]*)$/.exec(pathname)?.[1] ?? null;

const price = (n) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
const when = (iso) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

const NOTES = {
  no_api_key: "Showing the closest help article, as the assistant is limited right now.",
  rate_limited: "Showing the closest help article while the assistant catches its breath.",
  unavailable: "Showing the closest help article, as the assistant isn't available right now.",
  budget: "Showing the closest help article, as the assistant is limited right now.",
};

/** Floating help button and chat panel. Anonymous: nothing about you is sent, and nothing is stored. */
export default function ChatWidget() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState([]); // { role: "user" | "model", text, sources?, liveData?, degraded? }
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const box = useRef(null);
  const log = useRef(null);
  const opener = useRef(null);
  const input = useRef(null);
  const inFlight = useRef(false);
  const titleId = useId();

  const close = useCallback(() => {
    setOpen(false);
    opener.current?.focus();
  }, []);

  // Focus moves into the panel, Escape closes it, and Tab stays inside while it is open.
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") return close();
      if (e.key !== "Tab") return;
      const items = [...box.current.querySelectorAll("button:not([disabled]), textarea:not([disabled]), a[href]")];
      if (!items.length) return;
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [turns, busy, open]);

  const send = async () => {
    const text = draft.trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    // Only the last few turns are sent, and only the words, never anything about the person.
    const history = turns.filter((t) => !t.refused).slice(-6).map((t) => ({ role: t.role, text: t.text.slice(0, MAX) }));
    setTurns((t) => [...t, { role: "user", text }]);
    setDraft("");
    try {
      const slug = slugOf(pathname);
      const res = await fetch("/api/chat/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text, history, ...(slug ? { context: { eventSlug: slug } } : {}) }),
      });
      if (res.status === 429) throw new Error("slow_down");
      if (!res.ok) throw new Error("failed");
      const b = await res.json();
      // A message that was refused (personal data) is not kept in the history sent next time.
      if (b.flags.refused) setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, refused: true } : x)));
      setTurns((t) => [...t, { role: "model", text: b.answer, sources: b.sources, liveData: b.liveData, degraded: b.flags.degraded, refused: !!b.flags.refused }]);
    } catch (err) {
      setError(err.message === "slow_down" ? "You're sending messages quickly. Please try again in a minute." : "I couldn't reach the help service. Please try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <>
      <button
        ref={opener}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="fixed bottom-24 right-4 z-40 flex h-12 items-center gap-2 rounded-full bg-brand px-5 text-title4 text-brand-on shadow-lg hover:opacity-90 sm:bottom-6"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
        Help
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay sm:items-end sm:justify-end sm:bg-transparent sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId} className="flex h-[85vh] w-full flex-col overflow-hidden rounded-t-xl border border-line-moderate bg-bg-primary shadow-lg sm:h-[34rem] sm:w-96 sm:rounded-xl">
            <div className="flex items-start justify-between gap-3 border-b border-line-subtle px-4 py-3">
              <div>
                <h2 id={titleId} className="text-title2 text-ink">Help</h2>
                <p className="text-body3 text-ink-secondary">Don’t share Aadhaar, one-time codes, card or contact details here.</p>
              </div>
              <button type="button" onClick={close} aria-label="Close help" className="h-10 w-10 shrink-0 rounded-full text-title2 text-ink-secondary hover:bg-bg-secondary">×</button>
            </div>

            <div ref={log} role="log" aria-live="polite" aria-label="Conversation" className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
              <p className="rounded-lg bg-bg-secondary p-3 text-body2 text-ink">{GREETING}</p>
              {turns.map((t, i) => (
                <div key={i} className={t.role === "user" ? "flex justify-end" : ""}>
                  <div className={`max-w-[90%] rounded-lg p-3 text-body2 ${t.role === "user" ? "bg-brand text-brand-on" : "bg-bg-secondary text-ink"}`}>
                    <p className="whitespace-pre-wrap">{t.text}</p>
                    {t.liveData && (
                      <div className="mt-2 rounded-md border border-line-moderate bg-bg-primary p-2 text-ink">
                        <p className="text-title4">{t.liveData.event.title}</p>
                        <p className="text-body3 text-ink-secondary">{when(t.liveData.event.startsAt)} · {t.liveData.event.venueName}, {t.liveData.event.city}</p>
                        <ul className="mt-1 space-y-0.5">
                          {t.liveData.tiers.map((tier) => (
                            <li key={tier.name} className="flex justify-between gap-3 text-body3"><span>{tier.name}</span><span>{price(tier.priceInr)}{tier.available === null ? "" : tier.available === 0 ? " · sold out" : ` · ${tier.available} left`}</span></li>
                          ))}
                        </ul>
                        <Link to={`/events/${t.liveData.event.slug}`} onClick={close} className="mt-1 inline-block text-label2 text-brand underline">Open event page</Link>
                      </div>
                    )}
                    {t.sources?.length > 0 && (
                      <p className="mt-2 text-body3 text-ink-secondary">
                        From:{" "}
                        {[...new Map(t.sources.map((s) => [s.title.split(":")[0], s])).values()].map((s, n) => (
                          <span key={s.id}>
                            {n > 0 && ", "}
                            <button type="button" onClick={() => { navigate(safeNext(s.path, "/")); close(); }} className="text-brand underline">{s.title.split(":")[0]}</button>
                          </span>
                        ))}
                      </p>
                    )}
                    {t.degraded && NOTES[t.degraded] && <p className="mt-2 text-body3 text-ink-tertiary">{NOTES[t.degraded]}</p>}
                  </div>
                </div>
              ))}
              {busy && <p role="status" className="text-body3 text-ink-secondary">Thinking…</p>}
              {error && <p role="alert" className="text-body2 text-ink">{error}</p>}
            </div>

            <form onSubmit={(e) => { e.preventDefault(); send(); }} className="border-t border-line-subtle p-3">
              <label htmlFor="chat-input" className="sr-only">Ask a question</label>
              <div className="flex items-end gap-2">
                <textarea id="chat-input" ref={input} value={draft} onChange={(e) => setDraft(e.target.value.slice(0, MAX))} onKeyDown={onKeyDown} rows={2} maxLength={MAX} placeholder="Ask about booking, transfers, entry…" className="min-h-12 flex-1 resize-none rounded-lg border border-line-moderate bg-bg-primary px-3 py-2 text-body2 text-ink" />
                <button type="submit" disabled={busy || !draft.trim()} className="h-12 rounded-full bg-brand px-5 text-title4 text-brand-on disabled:opacity-50">Send</button>
              </div>
              <p className="mt-1 text-right text-body3 text-ink-tertiary" aria-live="off">{draft.length}/{MAX}</p>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
