import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { useAuth } from "../lib/auth.jsx";
import Modal from "./Modal.jsx";

const STEP_MS = 30_000;

/**
 * Shows a ticket's rotating QR. The phone holds the next 5 minutes of codes (fetched from the server, which keeps
 * the secret) and switches code every 30 seconds using the server's clock, so a wrong device clock doesn't matter.
 * Tokens live only in memory: never in storage, URLs or logs.
 */
export default function QrDialog({ ticket, event, onClose, onGone }) {
  const { call } = useAuth();
  const [batch, setBatch] = useState(null); // { tokens, offset }
  const [state, setState] = useState({ kind: "loading" });
  const [now, setNow] = useState(() => Date.now());
  const [img, setImg] = useState(null);
  const fetching = useRef(false);
  const dead = useRef(false);
  const haveCode = useRef(false); // is a usable code on screen right now?

  const load = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const { status, body } = await call(`/tickets/${ticket.id}/qr`);
      if (dead.current) return;
      if (status === 200) {
        setBatch({ tokens: body.tokens, offset: Date.parse(body.serverTime) - Date.now() });
        setState({ kind: "ok" });
      } else if (status === 409 && body.error === "ticket_used") setState({ kind: "used", usedAt: body.usedAt, usedGate: body.usedGate });
      else if (status === 409) setState({ kind: "void" });
      else if (status === 404) onGone(); // the ticket was transferred away
      else setState((s) => (haveCode.current ? s : { kind: "error" }));
    } catch {
      setState((s) => (haveCode.current ? s : { kind: "error" })); // out of codes and offline: say so, and keep trying
    } finally {
      fetching.current = false;
    }
  }, [call, ticket.id, onGone]);

  useEffect(() => {
    dead.current = false;
    load();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    // Notice quickly when the gate scans this ticket (or it is transferred) while the screen is open.
    const watch = setInterval(async () => {
      try {
        const { status, body } = await call(`/tickets/${ticket.id}`);
        if (dead.current) return;
        if (status === 404) onGone();
        else if (status === 200 && body.status === "used") setState({ kind: "used", usedAt: body.usedAt, usedGate: null });
      } catch {
        /* keep showing the current code */
      }
    }, 5000);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      dead.current = true;
      clearInterval(tick);
      clearInterval(watch);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, call, ticket.id, onGone]);

  const corrected = now + (batch?.offset ?? 0);
  const step = Math.floor(corrected / STEP_MS);
  const current = batch?.tokens.find((t) => t.step === step) ?? null;
  haveCode.current = !!current;
  const ahead = batch ? batch.tokens.filter((t) => t.step > step).length : 0;
  useEffect(() => {
    if (state.kind === "ok" && ahead <= 2) load(); // top up before we run out
  }, [state.kind, ahead, load]);

  // If we have no code (offline for longer than the 5-minute batch), retry on a timer instead of waiting for the user.
  useEffect(() => {
    if (state.kind !== "error" && !(state.kind === "ok" && !current)) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [state.kind, current, load]);

  useEffect(() => {
    let live = true;
    if (!current) return setImg(null);
    QRCode.toDataURL(current.token, { errorCorrectionLevel: "M", margin: 4, width: 280 }).then((url) => live && setImg(url));
    return () => {
      live = false;
    };
  }, [current?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const left = 30 - Math.floor((corrected % STEP_MS) / 1000);
  const fmt = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

  return (
    <Modal title="Your entry code" onClose={onClose}>
      <p className="text-body2 text-ink-secondary">{event?.title ?? "Your event"} · {ticket.seatLabel ?? "General admission"}</p>
      <p className="text-label1 text-ink">{ticket.holderName}</p>
      <div className="mt-4 flex flex-col items-center">
        {state.kind === "ok" && current && img && (
          <>
            <div className="relative rounded-lg bg-white p-1">
              <img src={img} alt={`QR entry code for ${ticket.holderName}. It changes every 30 seconds.`} width={280} height={280} className="block" />
            </div>
            <p className="mt-3 text-body2 text-ink-secondary" role="timer" aria-live="off">New code in {left}s</p>
            <div className="mt-2 h-1.5 w-56 overflow-hidden rounded-full bg-bg-secondary" aria-hidden="true"><div className="h-full rounded-full bg-brand transition-[width] duration-1000 ease-linear" style={{ width: `${(left / 30) * 100}%` }} /></div>
            <p className="mt-3 text-center text-body3 text-ink-tertiary">Screenshots won’t scan: the code changes every 30 seconds. Show this screen at the gate.</p>
          </>
        )}
        {state.kind === "ok" && (!current || !img) && (
          <div role="status" className="py-12 text-center">
            <p className="text-body1 text-ink-secondary">Getting your code…</p>
            <button type="button" onClick={load} className="mt-3 rounded-full border border-line-moderate px-5 py-2 text-title4 text-ink">Try again</button>
          </div>
        )}
        {state.kind === "loading" && <div aria-busy="true" className="h-[280px] w-[280px] animate-pulse rounded-lg bg-bg-secondary" />}
        {state.kind === "used" && (
          <p role="status" className="rounded-lg bg-bg-secondary p-4 text-center text-body1 text-ink">
            This ticket has been used{state.usedAt ? ` (${fmt(state.usedAt)}${state.usedGate ? `, gate ${state.usedGate}` : ""})` : ""}. Enjoy the show!
          </p>
        )}
        {state.kind === "void" && <p role="alert" className="rounded-lg bg-bg-secondary p-4 text-body1 text-ink">This ticket is no longer valid.</p>}
        {state.kind === "error" && (
          <div role="alert" className="text-center">
            <p className="text-body1 text-ink">We couldn’t get your code. Check your connection.</p>
            <button type="button" onClick={load} className="mt-3 rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Try again</button>
          </div>
        )}
      </div>
    </Modal>
  );
}
