import { useEffect, useState } from "react";
import { publicGet } from "../lib/api.js";

const when = (iso) => new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

export default function Setup({ user, onStart, onLogout }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState(false);
  const [gate, setGate] = useState(() => {
    try {
      return localStorage.getItem("gate-name") ?? "Gate 1";
    } catch {
      return "Gate 1";
    }
  });
  const load = () => {
    setError(false);
    publicGet("/catalog/events?limit=50").then(({ status, body }) => (status === 200 ? setEvents(body.items) : setError(true))).catch(() => setError(true));
  };
  useEffect(load, []);

  const start = (event) => {
    const gateId = gate.trim().slice(0, 32) || "Gate 1";
    try {
      localStorage.setItem("gate-name", gateId);
    } catch {}
    onStart({ event: { id: event.id, title: event.title, startsAt: event.startsAt }, gateId });
  };

  return (
    <div className="px-5 py-6">
      <div className="flex items-center justify-between">
        <p className="text-body2 text-ink-secondary">Signed in as {user.name}</p>
        <button type="button" onClick={onLogout} className="h-11 rounded-full px-4 text-label1 text-ink-secondary underline">Sign out</button>
      </div>
      <h1 className="mt-4 text-headline3 text-ink">Choose your event</h1>
      <div className="mt-4">
        <label htmlFor="gate" className="text-label1 text-ink">This gate’s name</label>
        <input id="gate" value={gate} onChange={(e) => setGate(e.target.value)} maxLength={32} className="mt-1 h-14 w-full rounded-lg border border-line-moderate bg-bg-primary px-4 text-body1 text-ink" />
      </div>
      {error && (
        <div role="alert" className="mt-6">
          <p className="text-body1 text-ink">Couldn’t load events.</p>
          <button type="button" onClick={load} className="mt-3 h-12 rounded-full bg-brand px-6 text-title3 text-brand-on">Try again</button>
        </div>
      )}
      {!events && !error && <div aria-busy="true" className="mt-6 h-40 animate-pulse rounded-lg bg-bg-secondary" />}
      <ul className="mt-5 space-y-3">
        {[...(events ?? [])].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)).map((e) => (
          <li key={e.id}>
            <button type="button" onClick={() => start(e)} className="w-full rounded-lg border border-line-moderate p-4 text-left active:bg-bg-secondary">
              <span className="block text-title3 text-ink">{e.title}</span>
              <span className="block text-body2 text-ink-secondary">{e.venue.name} · {when(e.startsAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
