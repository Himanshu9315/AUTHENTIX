import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const STORE = "auth";
// The refresh token lives in localStorage so a reload keeps you signed in. Trade-off: script injected into
// the page could read it. The access token (15 min) is only ever held in memory.
const load = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE));
  } catch {
    return null;
  }
};
const save = (v) => {
  try {
    if (v) localStorage.setItem(STORE, JSON.stringify(v));
    else localStorage.removeItem(STORE);
  } catch {}
};

/** Plain request to the gateway. Returns { status, body } and never throws on HTTP errors. */
async function raw(path, { method = "GET", body, token, headers = {} } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined || method === "POST" ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : method === "POST" ? "{}" : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => load()); // { user, refreshToken }
  const [devVerificationToken, setDevVerificationToken] = useState(null);
  const access = useRef(null);
  const refreshing = useRef(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const setAll = useCallback((next) => {
    sessionRef.current = next;
    setSession(next);
    save(next);
  }, []);

  // One refresh at a time, even if several requests hit a 401 together.
  const refresh = useCallback(() => {
    if (refreshing.current) return refreshing.current;
    const current = sessionRef.current;
    if (!current?.refreshToken) return Promise.resolve(false);
    const started = current.refreshToken;
    refreshing.current = raw("/auth/refresh", { method: "POST", body: { refreshToken: started } })
      .then(({ status, body }) => {
        // The user may have signed out (or in as someone else) while this was in flight: drop the result.
        if (sessionRef.current?.refreshToken !== started) return false;
        if (status === 200) {
          access.current = body.accessToken;
          setAll({ ...sessionRef.current, refreshToken: body.refreshToken });
          return true;
        }
        // Only a definite "no" ends the session. A 5xx or a restart must not log anyone out.
        if (status === 401 || status === 403) {
          access.current = null;
          setAll(null);
        }
        return false;
      })
      .catch(() => false)
      .finally(() => {
        refreshing.current = null;
      });
    return refreshing.current;
  }, [setAll]);

  /** Authenticated request: adds the token and retries once after a refresh. */
  const call = useCallback(
    async (path, opts = {}) => {
      if (!sessionRef.current) return { status: 401, body: { error: "unauthorized" } };
      if (!access.current && !(await refresh())) return { status: 401, body: { error: "unauthorized" } };
      let res = await raw(path, { ...opts, token: access.current });
      // Only the gateway's "unauthorized" means the token expired. A service's own 401-style answer must not trigger a retry.
      if (res.status === 401 && res.body?.error === "unauthorized" && (await refresh())) res = await raw(path, { ...opts, token: access.current });
      return res;
    },
    [refresh],
  );

  const finish = useCallback(
    ({ status, body }) => {
      if (status !== 200 && status !== 201) return { ok: false, status, error: body.error };
      access.current = body.accessToken;
      setAll({ user: body.user, refreshToken: body.refreshToken });
      setDevVerificationToken(body.verificationToken ?? null); // only present when the dev flag is on
      return { ok: true };
    },
    [setAll],
  );

  const login = useCallback(async (email, password) => finish(await raw("/auth/login", { method: "POST", body: { email, password } })), [finish]);
  const register = useCallback(async (email, password, name) => finish(await raw("/auth/register", { method: "POST", body: { email, password, name } })), [finish]);
  const logout = useCallback(async () => {
    const rt = sessionRef.current?.refreshToken;
    access.current = null;
    setAll(null);
    setDevVerificationToken(null);
    if (rt) raw("/auth/logout", { method: "POST", body: { refreshToken: rt } }).catch(() => {});
  }, [setAll]);

  const value = useMemo(
    () => ({ user: session?.user ?? null, signedIn: !!session, call, login, register, logout, devVerificationToken, clearDevToken: () => setDevVerificationToken(null), publicCall: raw }),
    [session, call, login, register, logout, devVerificationToken],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
