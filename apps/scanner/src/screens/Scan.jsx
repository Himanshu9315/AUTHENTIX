import { useCallback, useEffect, useRef, useState } from "react";
import Overlay from "../components/Overlay.jsx";
import { call } from "../lib/api.js";
import * as queue from "../lib/queue.js";

const REASONS = {
  invalid_qr: "Not a valid ticket code",
  qr_expired: "Code expired",
  scan_stale: "Scan was too old: scan again",
  wrong_event: "Ticket is for a different event",
  already_used: "Already used",
  ticket_replaced: "Ticket was transferred",
  ticket_void: "Ticket cancelled",
  event_not_open: "Gate isn’t open for this event",
};
const HINTS = {
  qr_expired: "Ask them to open the ticket fresh. Screenshots don’t work.",
  ticket_replaced: "This code was replaced. The new owner has a new code.",
  invalid_qr: "Ask them to reopen their ticket in the app.",
};
const time = (iso) => new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

/** Turns the server's answer into what the big screen shows. */
export function verdict(b) {
  if (b.result === "admitted") return { kind: "go", title: "ALLOW", detail: b.holderName, sub: b.seatLabel ?? "General admission" };
  const sub = b.reason === "already_used" ? `${b.holderName ? `${b.holderName}, ` : ""}at ${b.usedAt ? time(b.usedAt) : "?"}${b.usedGate ? `, ${b.usedGate}` : ""}` : HINTS[b.reason];
  return { kind: "stop", title: "STOP", detail: REASONS[b.reason] ?? "Not accepted", sub };
}

export default function Scan({ event, gateId, onChange, onLogout }) {
  const video = useRef(null);
  const [camera, setCamera] = useState("starting"); // starting | on | denied | unsupported
  const [overlay, setOverlay] = useState(null);
  const [recent, setRecent] = useState([]);
  const [stats, setStats] = useState(null);
  const [queued, setQueued] = useState(queue.read().length);
  const [manual, setManual] = useState("");
  const offset = useRef(0); // server time minus device time, so queued scans carry a trustworthy timestamp
  const seen = useRef({ text: null, at: 0 });
  const overlayUp = useRef(false);
  overlayUp.current = !!overlay;

  const addRecent = useCallback((v, late) => setRecent((r) => [{ id: crypto.randomUUID(), at: Date.now(), late, ...v }, ...r].slice(0, 10)), []);

  /** One attempt to deliver a scan. Returns "done", or "retry" when the server could not be reached. */
  const send = useCallback(
    async (scan, direct) => {
      try {
        const { status, body } = await call("/gate/scans", { method: "POST", body: scan });
        if (status === 200) {
          queue.remove(scan.scanId);
          setQueued(queue.read().length);
          if (body.serverTime) offset.current = Date.parse(body.serverTime) - Date.now();
          const v = verdict(body);
          addRecent(v, !direct);
          if (direct) setOverlay(v);
          return "done";
        }
        if (status === 503 || status === 408 || status === 429 || status >= 500) return "retry"; // the same scanId makes a retry safe
        queue.remove(scan.scanId);
        setQueued(queue.read().length);
        const v = status === 403 || status === 401
          ? { kind: "stop", title: "STOP", detail: status === 403 ? "This account can’t scan" : "Signed out", sub: "Sign in again" }
          : { kind: "stop", title: "STOP", detail: "Couldn’t read that scan", sub: "Scan again" };
        addRecent(v, !direct);
        if (direct) setOverlay(v);
        return "done";
      } catch {
        return "retry"; // no network
      }
    },
    [addRecent],
  );

  const submit = useCallback(
    async (token) => {
      const scan = { scanId: crypto.randomUUID(), eventId: event.id, gateId, token, scannedAt: new Date(Date.now() + offset.current).toISOString() };
      if ((await send(scan, true)) === "retry") {
        if (queue.enqueue(scan)) {
          setQueued(queue.read().length);
          setOverlay({ kind: "wait", title: "NO CONNECTION", detail: "Keep the ticket here", sub: "Retrying for up to 2 minutes" });
        } else {
          // Nowhere to keep it, so don't promise a retry.
          setOverlay({ kind: "stop", title: "STOP", detail: "Rescan needed", sub: "No connection and nowhere to hold the scan" });
        }
      }
    },
    [event.id, gateId, send],
  );

  const onDecoded = useCallback(
    (text) => {
      const now = Date.now();
      // The same code still in front of the camera is one scan, however long it is held: every sighting refreshes the timer.
      const same = seen.current.text === text && now - seen.current.at < 1500;
      seen.current = { text, at: now };
      if (overlayUp.current || same) return;
      const token = text.trim();
      if (token.length === 0 || token.length > 100) return setOverlay({ kind: "stop", title: "STOP", detail: "Not a ticket code", sub: "Ask them to open their ticket" });
      submit(token);
    },
    [submit],
  );

  // Retry queue: same scanId each time, backing off 1, 2, 4, 8 s, giving up after 2 minutes.
  useEffect(() => {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        for (const s of queue.due()) {
          if (queue.expired(s)) {
            queue.remove(s.scanId);
            addRecent({ kind: "stop", title: "STOP", detail: "Rescan needed", sub: "No connection for 2 minutes" }, true);
          } else if ((await send(s, false)) === "retry") queue.bump(s.scanId);
        }
        setQueued(queue.read().length);
      } finally {
        running = false;
      }
    }, 1000);
    return () => clearInterval(t);
  }, [send, addRecent]);

  // Live count and a server clock reading.
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const { status, body } = await call(`/gate/events/${event.id}/stats`);
        if (live && status === 200) {
          setStats(body);
          offset.current = Date.parse(body.serverTime) - Date.now();
        }
      } catch {
        /* keep the last count */
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [event.id]);

  // Camera + decoder. BarcodeDetector where the browser has it, jsQR otherwise.
  useEffect(() => {
    let stream;
    let timer;
    let stopped = false;
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setCamera("unsupported");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      } catch {
        return setCamera("denied");
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const el = video.current;
      el.srcObject = stream;
      await el.play().catch(() => {});
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      setCamera("on");
      const detector = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null;
      const jsQR = detector ? null : (await import("jsqr")).default;
      if (stopped) return stream.getTracks().forEach((t) => t.stop()); // left the screen while jsQR was loading
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      timer = setInterval(async () => {
        if (el.readyState < 2 || !el.videoWidth) return;
        let text = null;
        if (detector) text = (await detector.detect(el).catch(() => []))[0]?.rawValue ?? null;
        else {
          canvas.width = Math.min(640, el.videoWidth);
          canvas.height = Math.round((canvas.width / el.videoWidth) * el.videoHeight);
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          text = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" })?.data ?? null;
        }
        if (text) onDecoded(text);
      }, 125);
    })();
    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onDecoded]);

  const clear = useCallback(() => setOverlay(null), []);
  // Leaving drops anything still waiting for a connection, so ask first.
  const leave = (action) => () => {
    const n = queue.read().length;
    if (n > 0 && !window.confirm(`${n} scan${n === 1 ? " is" : "s are"} still waiting to be sent and will be lost. Leave anyway?`)) return;
    queue.clear();
    action();
  };

  return (
    <div className="px-4 pb-10 pt-4">
      <Overlay overlay={overlay} onDone={clear} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-title2 text-ink">{event.title}</h1>
          <p className="text-body2 text-ink-secondary">{gateId}</p>
        </div>
        <div className="flex shrink-0 gap-1">
          <button type="button" onClick={leave(onChange)} className="h-11 min-w-11 rounded-full px-3 text-label1 text-ink underline">Change</button>
          <button type="button" onClick={leave(onLogout)} className="h-11 min-w-11 rounded-full px-3 text-label1 text-ink-secondary underline">Sign out</button>
        </div>
      </div>

      <p className="mt-3 rounded-lg bg-brand-surface p-3 text-center text-title3 text-ink" aria-live="polite">
        {stats ? `${stats.used ?? "–"} inside · ${stats.issued ?? "–"} tickets · ${stats.admitted} admitted here` : "Loading count…"}
      </p>
      {queued > 0 && <p role="status" className="mt-2 rounded-lg bg-wait p-3 text-center text-title4 text-white">{queued} scan{queued === 1 ? "" : "s"} waiting for a connection. Retrying…</p>}

      <div className="relative mt-4 overflow-hidden rounded-xl bg-black">
        <video ref={video} playsInline muted aria-label="Camera view for scanning ticket QR codes" className="aspect-square w-full object-cover" />
        {camera === "on" && <div aria-hidden="true" className="pointer-events-none absolute inset-8 rounded-xl border-4 border-white/80" />}
        {camera !== "on" && (
          <p role="status" className="absolute inset-0 flex items-center justify-center p-6 text-center text-body1 text-white">
            {camera === "starting" ? "Starting camera…" : camera === "denied" ? "Camera blocked. Allow camera access in the browser settings, or paste a code below." : "This browser can’t use the camera. Paste a code below."}
          </p>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const token = manual.trim();
          if (!token || overlayUp.current) return;
          setManual("");
          if (token.length > 100) setOverlay({ kind: "stop", title: "STOP", detail: "Not a ticket code", sub: "Ask them to open their ticket" });
          else submit(token); // typed on purpose, so the "same code held in view" filter does not apply
        }}
        className="mt-4 flex gap-2"
      >
        <label htmlFor="paste" className="sr-only">Paste a ticket code</label>
        <input id="paste" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Or paste a ticket code" autoComplete="off" className="h-12 min-w-0 flex-1 rounded-lg border border-line-moderate bg-bg-primary px-3 text-body2 text-ink" />
        <button type="submit" className="h-12 rounded-full bg-brand px-5 text-title4 text-brand-on">Check</button>
      </form>

      <h2 className="mt-6 text-title3 text-ink">Recent scans</h2>
      {recent.length === 0 && <p className="mt-1 text-body2 text-ink-secondary">Nothing scanned yet.</p>}
      <ul className="mt-2 space-y-2">
        {recent.map((r) => (
          <li key={r.id} className={`rounded-lg p-3 text-white ${r.kind === "go" ? "bg-go" : "bg-stop"}`}>
            <p className="text-title4">{r.kind === "go" ? "✓ Allowed" : "✕ Stopped"}: {r.detail}{r.late ? " (late result)" : ""}</p>
            {r.sub && <p className="text-body3">{r.sub}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
