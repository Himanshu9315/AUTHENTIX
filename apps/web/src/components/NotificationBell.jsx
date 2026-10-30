import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth.jsx";
import { useUnread } from "../lib/inbox.js";
import { safeNext } from "../lib/safeNext.js";
import Modal from "./Modal.jsx";
import NotificationList from "./NotificationList.jsx";

/** Bell with an unread badge. Opens the latest few notifications; "See all" goes to the full page. */
export default function NotificationBell() {
  const { call } = useAuth();
  const navigate = useNavigate();
  const { unread, refresh, setUnread } = useUnread();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [error, setError] = useState(false);

  const show = async () => {
    setOpen(true);
    setItems(null);
    setError(false);
    try {
      const { status, body } = await call("/notifications?limit=10");
      if (status !== 200) throw new Error("load failed");
      setItems(body.items);
    } catch {
      setError(true);
    }
  };
  const close = useCallback(() => setOpen(false), []);

  const openItem = async (n) => {
    if (!n.readAt) {
      setItems((list) => list.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      setUnread((u) => Math.max(0, u - 1));
      // If it fails, the next refresh brings the true count back, so there is nothing stale to roll back by hand.
      call(`/notifications/${n.id}/read`, { method: "POST", body: {} })
        .catch(() => {})
        .finally(refresh);
    }
    setOpen(false);
    if (n.link) navigate(safeNext(n.link, "/")); // links are app paths; anything else falls back to home
  };
  const readAll = async () => {
    setItems((list) => list.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })));
    setUnread(0);
    try {
      await call("/notifications/read-all", { method: "POST", body: {} });
    } catch {
      /* the refresh below restores the real count if this didn't go through */
    } finally {
      refresh();
    }
  };

  return (
    <>
      <button type="button" onClick={show} aria-haspopup="dialog" aria-label={unread > 0 ? `Notifications, ${unread}${unread === 99 ? "+" : ""} unread` : "Notifications"} className="relative flex h-10 w-10 items-center justify-center rounded-full text-ink hover:bg-bg-secondary">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 01-3.4 0" /></svg>
        {unread > 0 && <span aria-hidden="true" className="absolute right-0 top-0 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-label3 text-brand-on">{unread}{unread === 99 ? "+" : ""}</span>}
      </button>
      {open && (
        <Modal title="Notifications" onClose={close}>
          {error && <p role="alert" className="text-body1 text-ink-secondary">We couldn’t load your notifications.</p>}
          {!items && !error && <div aria-busy="true" className="h-32 animate-pulse rounded-lg bg-bg-secondary" />}
          {items && items.length === 0 && <p className="py-6 text-center text-body1 text-ink-secondary">Nothing here yet.</p>}
          {items && items.length > 0 && <NotificationList items={items} onOpen={openItem} />}
          <div className="mt-3 flex items-center justify-between">
            <button type="button" onClick={readAll} className="text-label1 text-brand underline">Mark all as read</button>
            <Link to="/notifications" onClick={close} className="text-label1 text-brand underline">See all</Link>
          </div>
        </Modal>
      )}
    </>
  );
}
