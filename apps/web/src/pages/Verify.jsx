import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { ShieldCheck } from "../components/Icons.jsx";
import { useAuth } from "../lib/auth.jsx";
import { DEMO_HINTS, safeNext } from "../lib/safeNext.js";

const OTP_ERRORS = {
  aadhaar_invalid: "We couldn't find that number. In this demo, use one of the test numbers below.",
  uidai_unavailable: "The identity service isn't responding. Please try again shortly.",
  too_soon: "Please wait a few seconds before asking for another code.",
  already_verified: "You're already verified.",
  otp_invalid: "That code isn't right.",
  otp_expired: "That code expired. Request a new one.",
  no_active_otp: "Request a code first.",
  aadhaar_already_linked: "That Aadhaar is already linked to another account. Each person can have one account.",
  locked: "Too many wrong codes. Please try again in a few minutes.",
};

/** Two steps before anyone can book: confirm the email, then prove identity with an Aadhaar OTP. */
export default function Verify() {
  const { signedIn, call, devVerificationToken, clearDevToken, publicCall } = useAuth();
  const [params] = useSearchParams();
  const next = params.get("next");
  const back = safeNext(next);
  const [me, setMe] = useState(null);
  const [aad, setAad] = useState(null);
  const [step, setStep] = useState("number"); // number -> otp
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const [loadError, setLoadError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const [m, a] = await Promise.all([call("/auth/me"), call("/aadhaar/status")]);
      if (m.status !== 200 || a.status !== 200) throw new Error("load failed");
      setMe(m.body);
      setAad(a.body);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [call]);
  useEffect(() => {
    if (signedIn) refresh();
  }, [signedIn, refresh]);

  if (!signedIn) return <Navigate to={`/login?next=${encodeURIComponent(`/verify${next ? `?next=${encodeURIComponent(back)}` : ""}`)}`} replace />;
  if (loadError && (!me || !aad)) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <p role="alert" className="text-body1 text-ink">We couldn’t load your verification status.</p>
        <button type="button" onClick={refresh} className="mt-3 rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Try again</button>
      </div>
    );
  }
  if (!me || !aad) return <p className="mx-auto max-w-md px-4 py-10 text-body1 text-ink-secondary" aria-busy="true">Loading…</p>;

  const run = async (fn) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const verifyEmail = () =>
    run(async () => {
      const { status } = await publicCall("/auth/verify-email", { method: "POST", body: { token: devVerificationToken } });
      if (status === 200) clearDevToken();
      else setMsg("That link has expired. Request a new one.");
      await refresh();
    });
  const resend = () =>
    run(async () => {
      const { status } = await call("/auth/resend-verification", { method: "POST", body: {} });
      setMsg(status === 202 ? "We've sent a new verification email." : status === 429 ? "Please wait a minute before asking again." : "Couldn't send the email right now.");
    });
  const sendOtp = (ev) => {
    ev.preventDefault();
    const aadhaar = new FormData(ev.currentTarget).get("aadhaar").replace(/\s/g, "");
    return run(async () => {
      const { status, body } = await call("/aadhaar/otp", { method: "POST", body: { aadhaar } });
      if (status === 202) setStep("otp");
      else setMsg(OTP_ERRORS[body.error] ?? (status === 400 ? "Enter the 12-digit number." : "Something went wrong."));
    });
  };
  const submitOtp = (ev) => {
    ev.preventDefault();
    const otp = new FormData(ev.currentTarget).get("otp");
    return run(async () => {
      const { status, body } = await call("/aadhaar/verify", { method: "POST", body: { otp } });
      if (status === 200) await refresh();
      else setMsg(`${OTP_ERRORS[body.error] ?? "Couldn't verify."}${body.attemptsLeft !== undefined ? ` ${body.attemptsLeft} attempts left.` : ""}`);
    });
  };

  const done = me.email_verified && aad.verified;
  const input = "mt-1 h-12 w-full rounded-lg border border-line-moderate bg-bg-primary px-4 text-body1 text-ink";
  const btn = "h-12 rounded-full bg-brand px-6 text-title3 text-brand-on disabled:opacity-60";
  return (
    <div className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-headline3 text-ink">Verify your identity</h1>
      <p className="mt-1 text-body2 text-ink-secondary">Every ticket is tied to one verified person. It takes about a minute.</p>
      {msg && <p role="alert" className="mt-4 rounded-md bg-bg-secondary p-3 text-body2 text-ink">{msg}</p>}

      <section aria-labelledby="s1" className="mt-6 rounded-lg border border-line-moderate p-4">
        <h2 id="s1" className="flex items-center gap-2 text-title3 text-ink">1. Confirm your email {me.email_verified && <ShieldCheck className="text-brand" aria-label="done" />}</h2>
        {me.email_verified ? (
          <p className="mt-1 text-body2 text-ink-secondary">{me.email} is confirmed.</p>
        ) : (
          <div className="mt-2 space-y-3">
            <p className="text-body2 text-ink-secondary">We sent a link to {me.email}.</p>
            {devVerificationToken && (
              <div className="rounded-md bg-brand-surface p-3">
                <p className="text-body3 text-ink">Demo mode: emails aren't sent yet, so you can confirm from here.</p>
                <button type="button" onClick={verifyEmail} disabled={busy} className={`${btn} mt-2 h-10`}>Confirm my email</button>
              </div>
            )}
            <button type="button" onClick={resend} disabled={busy} className="text-label1 text-brand underline">Send the email again</button>
          </div>
        )}
      </section>

      <section aria-labelledby="s2" className="mt-4 rounded-lg border border-line-moderate p-4">
        <h2 id="s2" className="flex items-center gap-2 text-title3 text-ink">2. Verify with Aadhaar {aad.verified && <ShieldCheck className="text-brand" aria-label="done" />}</h2>
        {aad.verified ? (
          <p className="mt-1 text-body2 text-ink-secondary">Verified: Aadhaar ending {aad.last4}. We never store the full number.</p>
        ) : !me.email_verified ? (
          <p className="mt-1 text-body2 text-ink-tertiary">Confirm your email first.</p>
        ) : step === "number" ? (
          <form onSubmit={sendOtp} className="mt-2 space-y-3">
            <div>
              <label htmlFor="aadhaar" className="text-label1 text-ink">Aadhaar number</label>
              <input id="aadhaar" name="aadhaar" inputMode="numeric" autoComplete="off" required pattern="[0-9 ]{12,14}" placeholder="12 digits" className={input} />
              {DEMO_HINTS && <p className="mt-1 text-body3 text-ink-tertiary">Demo only: use a test number such as 1000 0000 0010. Real numbers are never accepted.</p>}
            </div>
            <button type="submit" disabled={busy} className={btn}>Send code</button>
          </form>
        ) : (
          <form onSubmit={submitOtp} className="mt-2 space-y-3">
            <div>
              <label htmlFor="otp" className="text-label1 text-ink">6-digit code</label>
              <input id="otp" name="otp" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9]{6}" maxLength={6} className={input} />
              {DEMO_HINTS && <p className="mt-1 text-body3 text-ink-tertiary">Demo only: the code is 123456.</p>}
            </div>
            <div className="flex items-center gap-4">
              <button type="submit" disabled={busy} className={btn}>Verify</button>
              <button type="button" onClick={() => { setStep("number"); setMsg(null); }} className="text-label1 text-brand underline">Use a different number</button>
            </div>
          </form>
        )}
      </section>

      {done && (
        <div className="mt-6 rounded-lg bg-brand-surface p-4">
          <p className="text-title3 text-ink">You're verified. You can book tickets now.</p>
          <Link to={back} className="mt-3 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Continue</Link>
        </div>
      )}
    </div>
  );
}
