import { useState } from "react";
import { login } from "../lib/api.js";

export default function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await login(f.get("email"), f.get("password"));
      if (!r.ok) setError(r.status === 403 ? "This account can’t scan tickets." : r.status === 429 ? "Too many attempts. Wait a minute." : "Wrong email or password.");
    } catch {
      setError("No connection. Check the network and try again.");
    } finally {
      setBusy(false);
    }
  };
  const field = "mt-1 h-14 w-full rounded-lg border border-line-moderate bg-bg-primary px-4 text-body1 text-ink";
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-headline2 text-ink">Gate staff sign in</h1>
      <p className="mt-1 text-body2 text-ink-secondary">Authentix entry scanner</p>
      <form onSubmit={submit} className="mt-8 space-y-4">
        <div><label htmlFor="email" className="text-label1 text-ink">Email</label><input id="email" name="email" type="email" required autoComplete="username" className={field} /></div>
        <div><label htmlFor="password" className="text-label1 text-ink">Password</label><input id="password" name="password" type="password" required autoComplete="current-password" className={field} /></div>
        {error && <p role="alert" className="text-body1 text-ink">{error}</p>}
        <button type="submit" disabled={busy} className="h-14 w-full rounded-full bg-brand text-title2 text-brand-on disabled:opacity-60">{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
