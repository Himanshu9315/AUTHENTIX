import { useRef, useState } from "react";
import { useAuth } from "../lib/auth.jsx";
import Modal from "./Modal.jsx";

// Deliberately vague about the recipient: whether an email has an account, or is verified, is never revealed.
const ERRORS = {
  recipient_not_eligible: "We couldn’t send the ticket to that email. The person needs a verified Authentix account (email and Aadhaar verified).",
  cannot_transfer_to_self: "That’s your own email address.",
  transfer_limit_reached: "This ticket has already been transferred twice, which is the limit.",
  transfer_window_closed: "Transfers close 24 hours before the event.",
  ticket_used: "This ticket has already been used.",
  ticket_changed: "This ticket just changed, so the transfer was cancelled. Please refresh and try again.",
  transfer_in_progress: "A transfer for this ticket is already in progress.",
  rate_limited: "Too many transfers in the last hour. Please try again later.",
  service_unavailable: "We couldn’t complete that right now. Please try again in a moment.",
  try_again: "That took too long to confirm. Press the button again; it won’t send twice.",
  idempotency_key_reused: "Please press the button again.",
};

export default function TransferDialog({ ticket, event, onClose, onDone }) {
  const { call } = useAuth();
  const [email, setEmail] = useState("");
  const [step, setStep] = useState("form"); // form -> confirm -> done
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(null);
  const key = useRef(null); // kept until the server gives a definite answer, so a retry can't transfer twice
  const inFlight = useRef(false);

  const send = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    key.current ??= crypto.randomUUID();
    try {
      const { status, body } = await call(`/tickets/${ticket.id}/transfer`, { method: "POST", body: { recipientEmail: email.trim() }, headers: { "idempotency-key": key.current } });
      if (status === 200) {
        key.current = null;
        setStep("done");
        onDone();
        return;
      }
      if (status === 202 || status >= 500) return setProblem(ERRORS[body.error] ?? ERRORS.try_again); // unknown outcome: keep the key
      key.current = null;
      setProblem(status === 429 ? ERRORS.rate_limited : (ERRORS[body.error] ?? "We couldn’t transfer this ticket."));
      if (status === 422 || status === 409) setStep("form");
    } catch {
      setProblem("Network problem. Press the button again; it won’t send twice.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const input = "mt-1 h-12 w-full rounded-lg border border-line-moderate bg-bg-primary px-4 text-body1 text-ink";
  return (
    <Modal title="Transfer this ticket" onClose={onClose}>
      <p className="text-body2 text-ink-secondary">{event?.title ?? "Event"} · {ticket.seatLabel ?? "General admission"}</p>
      {step === "form" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setProblem(null);
            key.current = null; // a new recipient is a new request
            setStep("confirm");
          }}
          className="mt-4 space-y-4"
        >
          <div>
            <label htmlFor="to" className="text-label1 text-ink">Their email</label>
            <input id="to" type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} className={input} data-autofocus />
            <p className="mt-1 text-body3 text-ink-tertiary">They must have a verified Authentix account. Tickets can’t be sold or resold, only passed to a friend.</p>
          </div>
          {problem && <p role="alert" className="text-body2 text-ink">{problem}</p>}
          <button type="submit" className="h-12 w-full rounded-full bg-brand text-title3 text-brand-on">Continue</button>
        </form>
      )}
      {step === "confirm" && (
        <div className="mt-4 space-y-3">
          <p className="text-body1 text-ink">Send this ticket to <strong>{email.trim()}</strong>?</p>
          <ul className="list-disc space-y-1 pl-5 text-body2 text-ink-secondary">
            <li>Your entry code stops working straight away, and they get a new one.</li>
            <li>Each ticket can be transferred twice in total ({ticket.transfersLeft} left), and not in the last 24 hours before the event.</li>
            <li>It counts toward their limit of tickets for this event.</li>
          </ul>
          {problem && <p role="alert" className="text-body2 text-ink">{problem}</p>}
          <div className="flex gap-3">
            <button type="button" onClick={() => setStep("form")} disabled={busy} className="h-12 flex-1 rounded-full border border-line-moderate text-title3 text-ink disabled:opacity-60">Back</button>
            <button type="button" onClick={send} disabled={busy} className="h-12 flex-1 rounded-full bg-brand text-title3 text-brand-on disabled:opacity-60" data-autofocus>{busy ? "Sending…" : "Transfer ticket"}</button>
          </div>
        </div>
      )}
      {step === "done" && (
        <div className="mt-4 space-y-3" role="status">
          <p className="text-body1 text-ink">Done. The ticket is now with {email.trim()} and your old entry code no longer works.</p>
          <button type="button" onClick={onClose} className="h-12 w-full rounded-full bg-brand text-title3 text-brand-on" data-autofocus>Close</button>
        </div>
      )}
    </Modal>
  );
}
