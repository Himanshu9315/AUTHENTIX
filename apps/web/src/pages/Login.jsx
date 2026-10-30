import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth.jsx";
import { safeNext } from "../lib/safeNext.js";

const ERRORS = {
  invalid_credentials: "That email and password don't match.",
  email_taken: "An account with that email already exists. Try signing in.",
  validation_error: "Check your details: the password needs at least 10 characters.",
};

export default function Login({ mode = "login" }) {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next");
  const dest = safeNext(next);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signup = mode === "register";

  const submit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.currentTarget);
    setBusy(true);
    setError(null);
    const res = signup ? await register(f.get("email"), f.get("password"), f.get("name")) : await login(f.get("email"), f.get("password"));
    setBusy(false);
    if (!res.ok) return setError(ERRORS[res.error] ?? (res.status === 429 ? "Too many attempts. Please wait a minute." : "Something went wrong. Please try again."));
    // New accounts go straight to verification, because nobody can book until they are verified.
    navigate(signup ? `/verify?next=${encodeURIComponent(dest)}` : dest);
  };

  const field = "mt-1 h-12 w-full rounded-lg border border-line-moderate bg-bg-primary px-4 text-body1 text-ink";
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-headline3 text-ink">{signup ? "Create your account" : "Welcome back"}</h1>
      <p className="mt-1 text-body2 text-ink-secondary">{signup ? "One verified person, one account. That's how we keep tickets fair." : "Sign in to book and manage your tickets."}</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        {signup && (
          <div><label htmlFor="name" className="text-label1 text-ink">Full name</label><input id="name" name="name" required maxLength={100} autoComplete="name" className={field} /></div>
        )}
        <div><label htmlFor="email" className="text-label1 text-ink">Email</label><input id="email" name="email" type="email" required autoComplete="email" className={field} /></div>
        <div><label htmlFor="password" className="text-label1 text-ink">Password</label><input id="password" name="password" type="password" required minLength={signup ? 10 : 1} autoComplete={signup ? "new-password" : "current-password"} className={field} />{signup && <p className="mt-1 text-body3 text-ink-tertiary">At least 10 characters.</p>}</div>
        {error && <p role="alert" className="text-body2 text-ink">{error}</p>}
        <button type="submit" disabled={busy} className="h-12 w-full rounded-full bg-brand text-title3 text-brand-on disabled:opacity-60">{busy ? "Please wait…" : signup ? "Create account" : "Sign in"}</button>
      </form>
      <p className="mt-6 text-body2 text-ink-secondary">
        {signup ? "Already have an account? " : "New to Authentix? "}
        <Link className="text-brand underline" to={`${signup ? "/login" : "/register"}${next ? `?next=${encodeURIComponent(dest)}` : ""}`}>{signup ? "Sign in" : "Create an account"}</Link>
      </p>
    </div>
  );
}
