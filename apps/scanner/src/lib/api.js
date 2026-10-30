// Talks to the gateway. Access token in memory; refresh token in sessionStorage (staff devices are shared, so it
// is forgotten when the tab closes).
const STORE = "gate-session";
let access = null;
let session = load(); // { refreshToken, user }
let refreshing = null;
const listeners = new Set();

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE));
  } catch {
    return null;
  }
}
function setSession(next) {
  session = next;
  try {
    if (next) sessionStorage.setItem(STORE, JSON.stringify(next));
    else sessionStorage.removeItem(STORE);
  } catch {}
  listeners.forEach((fn) => fn(session));
}
export const getSession = () => session;
export const onSession = (fn) => (listeners.add(fn), () => listeners.delete(fn));

async function raw(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000), // a hung connection must fail, not freeze the retry loop; callers treat it as "retry"
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

export async function login(email, password) {
  const { status, body } = await raw("/auth/login", { method: "POST", body: { email, password } });
  if (status !== 200) return { ok: false, status };
  if (body.user.role !== "staff") {
    // A valid account, but not allowed to scan. Don't leave the session we were just handed alive.
    raw("/auth/logout", { method: "POST", body: { refreshToken: body.refreshToken } }).catch(() => {});
    return { ok: false, status: 403 };
  }
  access = body.accessToken;
  setSession({ refreshToken: body.refreshToken, user: body.user });
  return { ok: true };
}

export function logout() {
  const rt = session?.refreshToken;
  access = null;
  setSession(null);
  if (rt) raw("/auth/logout", { method: "POST", body: { refreshToken: rt } }).catch(() => {});
}

/** Resolves "ok", "denied" (the server said no: the shift is over) or "unreachable" (network or server trouble: keep the session). */
function refresh() {
  if (refreshing) return refreshing;
  const started = session?.refreshToken;
  if (!started) return Promise.resolve("denied");
  refreshing = raw("/auth/refresh", { method: "POST", body: { refreshToken: started } })
    .then(({ status, body }) => {
      if (session?.refreshToken !== started) return "denied";
      if (status === 200) {
        access = body.accessToken;
        setSession({ ...session, refreshToken: body.refreshToken });
        return "ok";
      }
      if (status === 401 || status === 403) {
        setSession(null);
        return "denied";
      }
      return "unreachable"; // 5xx, 429 and the like never end a shift
    })
    .catch(() => "unreachable")
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * Authenticated call. Returns { status, body }. THROWS when the network or the server is unreachable (including when a
 * token refresh could not be attempted), so callers queue and retry instead of treating it as a definite answer.
 */
export async function call(path, opts = {}) {
  if (!session) return { status: 401, body: { error: "unauthorized" } };
  if (!access) {
    const r = await refresh();
    if (r === "denied") return { status: 401, body: { error: "unauthorized" } };
    if (r === "unreachable") throw new Error("offline");
  }
  let res = await raw(path, { ...opts, token: access });
  if (res.status === 401 && res.body?.error === "unauthorized") {
    const r = await refresh();
    if (r === "unreachable") throw new Error("offline");
    if (r === "ok") res = await raw(path, { ...opts, token: access });
  }
  return res;
}

export const publicGet = (path) => raw(path);
