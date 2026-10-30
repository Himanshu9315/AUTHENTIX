// Scans that could not reach the server wait here and are retried with the SAME scanId, so the server answers each
// exactly once. The QR token sits in localStorage only while queued and is deleted as soon as there is an answer.
const KEY = "gate-scan-queue";
export const MAX_AGE_MS = 120_000; // matches the server's grace period: older scans must be re-scanned
const BACKOFF_MS = [1000, 2000, 4000, 8000];

export function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? [];
  } catch {
    return [];
  }
}
function write(items) {
  try {
    if (items.length) localStorage.setItem(KEY, JSON.stringify(items));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** Returns false if the scan could not be stored (storage full or blocked): the caller must ask for a rescan instead of promising a retry. */
export const enqueue = (scan, now = Date.now()) => {
  write([...read().filter((s) => s.scanId !== scan.scanId), { ...scan, firstAt: now, attempt: 0, nextAt: now + BACKOFF_MS[0] }]);
  return read().some((s) => s.scanId === scan.scanId);
};
/** Forget everything waiting (sign-out, or leaving with scans unsent). QR tokens must not outlive the shift. */
export const clear = () => write([]);
/** Drop entries that are too old to be accepted anyway, e.g. left behind by a closed tab. */
export const purgeExpired = (now = Date.now()) => write(read().filter((s) => !expired(s, now)));
export const remove = (scanId) => write(read().filter((s) => s.scanId !== scanId));
export const bump = (scanId, now = Date.now()) =>
  write(read().map((s) => (s.scanId === scanId ? { ...s, attempt: s.attempt + 1, nextAt: now + BACKOFF_MS[Math.min(s.attempt + 1, BACKOFF_MS.length - 1)] } : s)));
export const due = (now = Date.now()) => read().filter((s) => s.nextAt <= now);
export const expired = (s, now = Date.now()) => now - s.firstAt > MAX_AGE_MS;
