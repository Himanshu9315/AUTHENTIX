import { Link } from "react-router-dom";
import { ShieldCheck } from "./Icons.jsx";

// Social, help and legal destinations are placeholders until those pages exist.
const COLUMNS = [
  { title: "Quick links", links: [["List your event", "/"], ["Concerts", "/search?category=concerts"], ["Festivals", "/search?category=festivals"], ["Comedy", "/search?category=comedy"]] },
  { title: "Help", links: [["Help centre", "/"], ["How verified entry works", "/"], ["Transfer a ticket", "/"], ["Contact us", "/"]] },
  { title: "Legal", links: [["Terms of use", "/"], ["Privacy policy", "/"], ["Refund policy", "/"]] },
];
const SOCIAL = ["Instagram", "X", "YouTube", "LinkedIn"];

export default function Footer() {
  return (
    <footer className="mt-12 border-t border-line-subtle bg-bg-secondary">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 md:grid-cols-[1.5fr_1fr_1fr_1fr_1.2fr]">
        <div>
          <p className="flex items-center gap-2 text-title2 text-ink"><ShieldCheck className="text-brand" /> Authentix</p>
          <p className="mt-3 max-w-xs text-body2 text-ink-secondary">Tickets tied to real, verified people. No bots, no hoarding, no scalpers.</p>
          <ul className="mt-4 flex flex-wrap gap-2">
            {SOCIAL.map((s) => (
              <li key={s}><a href="#main" aria-label={`Authentix on ${s}`} className="rounded-full border border-line-moderate px-3 py-1 text-label2 text-ink hover:bg-bg-primary">{s}</a></li>
            ))}
          </ul>
        </div>
        {COLUMNS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <h2 className="text-title4 text-ink">{c.title}</h2>
            <ul className="mt-3 space-y-2">
              {c.links.map(([label, to]) => (
                <li key={label}><Link to={to} className="text-body2 text-ink-secondary hover:text-ink">{label}</Link></li>
              ))}
            </ul>
          </nav>
        ))}
        <div>
          <h2 className="text-title4 text-ink">Get the app</h2>
          <p className="mt-3 text-body2 text-ink-secondary">Mobile apps are coming soon.</p>
          <div className="mt-3 flex flex-col gap-2">
            <span aria-disabled="true" className="rounded-md border border-line-moderate px-3 py-2 text-label1 text-ink-tertiary">App Store · coming soon</span>
            <span aria-disabled="true" className="rounded-md border border-line-moderate px-3 py-2 text-label1 text-ink-tertiary">Google Play · coming soon</span>
          </div>
        </div>
      </div>
      <p className="border-t border-line-subtle px-4 py-4 text-center text-body3 text-ink-tertiary">© {new Date().getFullYear()} Authentix. A university project: all events, artists and venues are fictional.</p>
    </footer>
  );
}
