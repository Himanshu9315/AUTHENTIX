import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "../components/Icons.jsx";
import { useAuth } from "../lib/auth.jsx";

/**
 * The page the emailed link opens: /verify-email#token=...
 * The token is in the #fragment, so it never reaches a web server's log. We read it once, remove it from the address bar
 * straight away, keep it in memory only, and send it once.
 */
export default function VerifyEmail() {
  const { signedIn, publicCall } = useAuth();
  const token = useRef(null);
  const started = useRef(false);
  const [state, setState] = useState("verifying"); // verifying | done | expired | missing | network

  const submit = useCallback(async () => {
    setState("verifying");
    try {
      const { status, body } = await publicCall("/auth/verify-email", { method: "POST", body: { token: token.current } });
      if (status === 200) {
        token.current = null;
        setState("done");
      } else if (status === 400 && body.error === "invalid_or_expired_token") setState("expired");
      else setState("network");
    } catch {
      setState("network"); // the token stays in memory so "Try again" works
    }
  }, [publicCall]);

  useEffect(() => {
    // React's StrictMode runs effects twice in development. The first run removes the token from the address bar, so a
    // second run would find nothing and a second request would show a false "expired". This guard runs it once.
    if (started.current) return;
    started.current = true;
    const m = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
    if (!m) return setState("missing");
    try {
      token.current = decodeURIComponent(m[1]);
    } catch {
      return setState("missing");
    }
    window.history.replaceState(null, "", "/verify-email");
    submit();
  }, [submit]);

  const button = "mt-4 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on";
  return (
    <div className="mx-auto max-w-md px-4 py-12 text-center">
      {state === "verifying" && (
        <>
          <h1 className="text-headline3 text-ink">Confirming your email…</h1>
          <p role="status" className="mt-3 text-body1 text-ink-secondary">One moment.</p>
        </>
      )}
      {state === "done" && (
        <>
          <ShieldCheck className="mx-auto text-brand" width={40} height={40} />
          <h1 className="mt-2 text-headline3 text-ink">Email confirmed</h1>
          <p role="status" className="mt-3 text-body1 text-ink-secondary">Next, verify your identity so you can book tickets.</p>
          <Link to={signedIn ? "/verify" : `/login?next=${encodeURIComponent("/verify")}`} className={button}>{signedIn ? "Continue" : "Sign in to continue"}</Link>
        </>
      )}
      {state === "expired" && (
        <>
          <h1 className="text-headline3 text-ink">This link has expired or was already used</h1>
          <p role="alert" className="mt-3 text-body1 text-ink-secondary">You can ask for a new one from your account page.</p>
          <Link to={signedIn ? "/verify" : `/login?next=${encodeURIComponent("/verify")}`} className={button}>{signedIn ? "Send a new link" : "Sign in to get a new link"}</Link>
        </>
      )}
      {state === "missing" && (
        <>
          <h1 className="text-headline3 text-ink">That link is incomplete</h1>
          <p role="alert" className="mt-3 text-body1 text-ink-secondary">Open the link from your email again, or ask for a new one.</p>
          <Link to="/verify" className={button}>Go to verification</Link>
        </>
      )}
      {state === "network" && (
        <>
          <h1 className="text-headline3 text-ink">We couldn’t reach Authentix</h1>
          <p role="alert" className="mt-3 text-body1 text-ink-secondary">Check your connection and try again.</p>
          <button type="button" onClick={submit} className={button}>Try again</button>
        </>
      )}
    </div>
  );
}
