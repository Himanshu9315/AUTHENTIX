// Deterministic fictional test instruments. Nothing here is a real card or UPI id.
// outcome "hang" never resolves on its own: it stays processing until cancelled or the auto-fail timeout.

const CARDS = {
  "4242424242424242": { outcome: "succeeded", delay: "normal" },
  "4000000000000002": { outcome: "failed", delay: "normal", reason: "declined" },
  "4000000000009999": { outcome: "hang" },
  "4000000000000077": { outcome: "succeeded", delay: "slow" },
};
const UPI = {
  "success@authentix": { outcome: "succeeded", delay: "normal" },
  "fail@authentix": { outcome: "failed", delay: "normal", reason: "declined" },
  "timeout@authentix": { outcome: "hang" },
};

/**
 * @param {"card"|"upi"} method
 * @param {{ number: string } | undefined} card
 * @param {{ vpa: string } | undefined} upi
 * @returns {{ outcome: string, delay?: string, reason?: string, hint: string } | null} null if not a known test instrument
 */
export function resolveInstrument(method, card, upi) {
  if (method === "card" && card) {
    const digits = card.number.replace(/\s/g, "");
    const hit = CARDS[digits];
    return hit ? { ...hit, hint: digits.slice(-4) } : null;
  }
  if (method === "upi" && upi) {
    const hit = UPI[upi.vpa.trim().toLowerCase()];
    return hit ? { ...hit, hint: "upi" } : null;
  }
  return null;
}
