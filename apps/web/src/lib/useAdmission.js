import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./auth.jsx";

/**
 * Where does this person stand for a high-demand event? Returns { state: "unknown" | "none" | "waiting" | "admitted",
 * position, token, expiresAt, secondsLeft }. The token is held in memory only: asking the server again returns the same
 * one (it is derived, not stored), so a reload loses nothing and nothing sensitive sits in storage.
 */
export function useAdmission(event) {
  const { signedIn, call } = useAuth();
  const [st, setSt] = useState({ state: "unknown", offset: 0 });
  const [now, setNow] = useState(() => Date.now());
  const watch = !!event?.hotSale && signedIn;

  const refresh = useCallback(async () => {
    if (!watch) return;
    try {
      const { status, body } = await call(`/queue/events/${event.id}/me`);
      if (status === 200) setSt({ ...body, offset: Date.parse(body.serverTime) - Date.now() });
    } catch {
      /* keep the last known state */
    }
  }, [watch, call, event?.id]);

  useEffect(() => {
    if (!watch) return;
    refresh();
    const poll = setInterval(refresh, 20_000); // also counts as "still here", which keeps a place in line
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [watch, refresh]);

  if (!watch) return { state: "none", refresh };
  if (st.state === "admitted") {
    const secondsLeft = Math.floor((Date.parse(st.expiresAt) - (now + st.offset)) / 1000);
    if (secondsLeft <= 0) return { state: "none", expired: true, refresh };
    return { state: "admitted", token: st.admissionToken, expiresAt: st.expiresAt, secondsLeft, refresh };
  }
  return { state: st.state, position: st.position, refresh };
}
