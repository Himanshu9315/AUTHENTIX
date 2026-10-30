import { useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import LocationSelector from "./LocationSelector.jsx";
import ThemeToggle from "./ThemeToggle.jsx";
import { useAuth } from "../lib/auth.jsx";
import { SearchIcon, ShieldCheck } from "./Icons.jsx";

const TABS = [
  { label: "For you", to: "/", match: (loc) => loc.pathname === "/" },
  { label: "Concerts", to: "/search?category=concerts", match: (loc, p) => loc.pathname === "/search" && p.get("category") === "concerts" },
  { label: "Festivals", to: "/search?category=festivals", match: (loc, p) => loc.pathname === "/search" && p.get("category") === "festivals" },
  { label: "Comedy", to: "/search?category=comedy", match: (loc, p) => loc.pathname === "/search" && p.get("category") === "comedy" },
];

export default function TopBar() {
  const navigate = useNavigate();
  const { user, signedIn, logout } = useAuth();
  const loc = useLocation();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  useEffect(() => setQ(loc.pathname === "/search" ? (params.get("q") ?? "") : ""), [loc.pathname, params]);

  const submit = (e) => {
    e.preventDefault();
    const term = q.trim();
    navigate(term ? `/search?q=${encodeURIComponent(term)}` : "/search");
  };

  return (
    <header className="sticky top-0 z-30 border-b border-line-subtle bg-bg-primary/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <Link to="/" className="flex items-center gap-2 rounded-md text-title2 text-ink" aria-label="Authentix home">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-brand-on"><ShieldCheck width={18} height={18} /></span>
          <span className="hidden sm:inline">Authentix</span>
        </Link>
        <LocationSelector />
        <form role="search" onSubmit={submit} className="order-last flex min-w-0 basis-full items-center gap-2 rounded-full bg-bg-secondary px-4 md:order-none md:basis-auto md:flex-1">
          <SearchIcon className="shrink-0 text-ink-secondary" />
          <label htmlFor="site-search" className="sr-only">Search for events, artists and venues</label>
          <input id="site-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search for events, artists and venues" className="h-11 w-full min-w-0 bg-transparent text-body2 text-ink placeholder:text-ink-tertiary focus:outline-none" />
        </form>
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          {signedIn ? (
            <>
              <Link to="/tickets" className="rounded-full px-3 py-2 text-label1 text-ink hover:bg-bg-secondary">My tickets</Link>
              <Link to="/verify" className="hidden rounded-full px-3 py-2 text-label1 text-ink hover:bg-bg-secondary sm:block">{user?.name?.split(" ")[0] ?? "Account"}</Link>
              <button type="button" onClick={logout} className="rounded-full px-3 py-2 text-label1 text-ink-secondary hover:bg-bg-secondary">Sign out</button>
            </>
          ) : (
            <Link to="/login" className="rounded-full px-3 py-2 text-label1 text-ink hover:bg-bg-secondary">Sign in</Link>
          )}
          <ThemeToggle />
        </div>
      </div>
      <nav aria-label="Categories" className="mx-auto max-w-7xl px-4">
        <ul className="no-scrollbar flex gap-6 overflow-x-auto">
          {TABS.map((t) => {
            const active = t.match(loc, params);
            return (
              <li key={t.label}>
                <NavLink to={t.to} aria-current={active ? "page" : undefined} className={`block border-b-2 py-3 text-label1 ${active ? "border-brand text-ink" : "border-transparent text-ink-secondary hover:text-ink"}`}>
                  {t.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
