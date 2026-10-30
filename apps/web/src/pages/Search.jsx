import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import EventCard, { EventCardSkeleton } from "../components/EventCard.jsx";
import { qs } from "../lib/api.js";
import { useFetch } from "../lib/useFetch.js";
import { useLocationCtx } from "../lib/location.jsx";

const CATS = [["", "All"], ["concerts", "Concerts"], ["festivals", "Festivals"], ["comedy", "Comedy"]];

export default function Search() {
  const [params, setParams] = useSearchParams();
  const { city, coords } = useLocationCtx();
  const q = params.get("q") ?? "";
  const category = params.get("category") ?? "";
  const allCities = params.get("all") === "1";

  const path = useMemo(
    () => `/events${qs({ q, category, city: allCities ? undefined : city, lat: coords?.lat, lng: coords?.lng, limit: 50 })}`,
    [q, category, allCities, city, coords],
  );
  const { data, loading, error } = useFetch(path);

  const set = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const where = allCities ? "all cities" : city;
  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <h1 className="text-headline3 text-ink">{q ? <>Results for “{q}”</> : "Browse events"}</h1>
      <p className="mt-1 text-body2 text-ink-secondary" role="status">
        {loading ? "Searching…" : error ? "" : `${data.items.length} ${data.items.length === 1 ? "event" : "events"} in ${where}`}
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filter by category">
        {CATS.map(([value, label]) => (
          <button key={label} type="button" aria-pressed={category === value} onClick={() => set("category", value)} className={`rounded-full border px-4 py-2 text-label1 ${category === value ? "border-brand bg-brand-surface text-brand" : "border-line-moderate text-ink hover:bg-bg-secondary"}`}>
            {label}
          </button>
        ))}
        <button type="button" aria-pressed={allCities} onClick={() => set("all", allCities ? "" : "1")} className={`ml-auto rounded-full border px-4 py-2 text-label1 ${allCities ? "border-brand bg-brand-surface text-brand" : "border-line-moderate text-ink hover:bg-bg-secondary"}`}>
          All cities
        </button>
      </div>

      {error && <p className="mt-8 text-body1 text-ink-secondary">Couldn’t load events right now. Please try again in a moment.</p>}
      {!loading && !error && data.items.length === 0 && (
        <div className="mt-10 rounded-lg bg-bg-secondary p-8 text-center">
          <p className="text-title3 text-ink">No events found</p>
          <p className="mt-1 text-body2 text-ink-secondary">Try a different search or <Link className="text-brand underline" to="/search?all=1">look in all cities</Link>.</p>
        </div>
      )}
      <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {loading ? [0, 1, 2, 3, 4, 5, 6, 7].map((i) => <li key={i}><EventCardSkeleton className="w-full" /></li>) : data?.items.map((e) => <li key={e.id}><EventCard event={e} className="w-full" /></li>)}
      </ul>
    </div>
  );
}
