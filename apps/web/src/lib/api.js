// All calls go through the gateway under /api (Vite proxies it in dev, nginx in Docker).
export async function api(path, { signal } = {}) {
  const res = await fetch(`/api/catalog${path}`, { signal });
  if (!res.ok) {
    const err = new Error(`request failed: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
