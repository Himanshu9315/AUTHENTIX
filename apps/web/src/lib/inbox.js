import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./auth.jsx";

/** Unread badge number for the bell: refreshed every minute and whenever the tab comes back into view. */
export function useUnread() {
  const { signedIn, call } = useAuth();
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(async () => {
    if (!signedIn) return;
    try {
      const { status, body } = await call("/notifications/unread-count");
      if (status === 200) setUnread(body.unread);
    } catch {
      /* keep the last number */
    }
  }, [signedIn, call]);
  useEffect(() => {
    if (!signedIn) return setUnread(0);
    refresh();
    const t = setInterval(refresh, 60_000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [signedIn, refresh]);
  return { unread, refresh, setUnread };
}

export const ago = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
};
