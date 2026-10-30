import { ShieldCheck } from "./Icons.jsx";

/** Authentix-specific: shown on every event, since entry is tied to a verified person. */
export default function VerifiedBadge({ className = "" }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full bg-brand-surface px-2 py-1 text-label2 text-brand ${className}`}>
      <ShieldCheck width={14} height={14} />
      Verified entry
    </span>
  );
}
