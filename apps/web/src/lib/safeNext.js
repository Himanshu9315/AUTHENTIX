/**
 * Returns a same-origin path (path + query + hash) for a ?next= value, or the fallback.
 * Browsers treat "\" like "/" and strip tabs/newlines, so "/\evil.com" and "/\t/evil.com" would
 * otherwise leave the site. Parsing against our own origin and comparing origins catches all of them.
 */
export function safeNext(next, fallback = "/") {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]|%5c|%2f%2f/i.test(next)) return fallback; // backslashes, control chars and their encoded forms
  try {
    const u = new URL(next, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search + u.hash : fallback;
  } catch {
    return fallback;
  }
}

/** Demo hints (test cards, the fixed OTP) only show in dev builds or when the build sets VITE_DEMO_HINTS=true. */
export const DEMO_HINTS = import.meta.env.DEV || import.meta.env.VITE_DEMO_HINTS === "true";
