import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import NotificationList from "../components/NotificationList.jsx";
import { useAuth } from "../lib/auth.jsx";
import { safeNext } from "../lib/safeNext.js";

export default function Notifications() {
  const { signedIn, call } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(false);
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (cursor) => {
      try {
        const { status, body } = await call(`/notifications?limit=20${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`);
        if (status !== 200) throw new Error("load failed");
        setItems((cur) => (cursor ? [...(cur ?? []), ...body.items] : body.items));
        setNext(body.nextBefore);
        setError(false);
      } catch {
        setError(true);
      }
    },
    [call],
  );
  useEffect(() => {
    if (signedIn) load(null);
  }, [signedIn, load]);

  if (!signedIn) return <Navigate to={`/login?next=${encodeURIComponent("/notifications")}`} replace />;

  const open = async (n) => {
    if (!n.readAt) {
      setItems((list) => list.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      call(`/notifications/${n.id}/read`, { method: "POST", body: {} }).catch(() => {});
    }
    if (n.link) navigate(safeNext(n.link, "/"));
  };
  const readAll = async () => {
    setItems((list) => list.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    const ok = await call("/notifications/read-all", { method: "POST", body: {} }).then(() => true, () => false);
    if (!ok) load(null); // it didn't go through: show the real state again
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-headline3 text-ink">Notifications</h1>
        {items?.some((n) => !n.readAt) && <button type="button" onClick={readAll} className="text-label1 text-brand underline">Mark all as read</button>}
      </div>
      {error && !items && (
        <div role="alert" className="mt-6">
          <p className="text-body1 text-ink-secondary">We couldn’t load your notifications.</p>
          <button type="button" onClick={() => load(null)} className="mt-3 rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Try again</button>
        </div>
      )}
      {!items && !error && <div aria-busy="true" className="mt-6 h-40 animate-pulse rounded-lg bg-bg-secondary" />}
      {items && items.length === 0 && <p className="mt-8 rounded-lg bg-bg-secondary p-8 text-center text-body1 text-ink-secondary">No notifications yet. We’ll tell you here when something happens with your account or tickets.</p>}
      {items && items.length > 0 && <div className="mt-4"><NotificationList items={items} onOpen={open} /></div>}
      {next && (
        <button type="button" disabled={more} onClick={async () => { setMore(true); await load(next); setMore(false); }} className="mt-4 h-12 w-full rounded-full border border-line-moderate text-title3 text-ink disabled:opacity-60">{more ? "Loading…" : "Load more"}</button>
      )}
    </div>
  );
}
