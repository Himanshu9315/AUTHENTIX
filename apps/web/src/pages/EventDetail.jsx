import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CalendarIcon, PinIcon, ShieldCheck } from "../components/Icons.jsx";
import VerifiedBadge from "../components/VerifiedBadge.jsx";
import { useFetch } from "../lib/useFetch.js";
import { formatPrice, formatRange } from "../lib/format.js";
import NotFound from "./NotFound.jsx";

export default function EventDetail() {
  const { slug } = useParams();
  const { data: e, loading, error } = useFetch(`/events/${encodeURIComponent(slug)}`);
  const tiers = useRef(null);
  const [notice, setNotice] = useState(false);

  if (error?.status === 404) return <NotFound />;
  if (error) return <p className="mx-auto max-w-7xl px-4 py-16 text-body1 text-ink-secondary">Couldn’t load this event. Please try again in a moment.</p>;
  if (loading) return <div className="mx-auto max-w-7xl px-4 py-8" aria-busy="true"><div className="aspect-[16/7] animate-pulse rounded-xl bg-bg-secondary" /></div>;

  const book = () => {
    setNotice(true);
    tiers.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <article className="pb-28">
      <div className="relative overflow-hidden bg-bg-secondary">
        <img src={e.posterUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-30 blur-2xl" />
        <div className="relative mx-auto grid max-w-7xl gap-6 px-4 py-8 md:grid-cols-[18rem_1fr] md:items-end">
          <img src={e.posterUrl} alt={`${e.title} poster`} className="mx-auto aspect-[3/4] w-56 rounded-xl object-cover shadow-lg md:w-72" />
          <div>
            <p className="text-label1 capitalize text-ink-secondary"><Link className="hover:underline" to={`/search?category=${e.category}`}>{e.category}</Link></p>
            <h1 className="mt-1 text-headline2 text-ink md:text-headline1">{e.title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <VerifiedBadge />
              {e.hotSale && <span className="rounded-full bg-ink px-2 py-1 text-label2 text-bg-primary">Hot sale</span>}
            </div>
            <dl className="mt-5 space-y-3">
              <div className="flex items-start gap-3"><dt className="sr-only">When</dt><CalendarIcon className="mt-0.5 shrink-0 text-ink-secondary" /><dd className="text-body1 text-ink">{formatRange(e.startsAt, e.endsAt)}</dd></div>
              <div className="flex items-start gap-3"><dt className="sr-only">Where</dt><PinIcon className="mt-0.5 shrink-0 text-ink-secondary" /><dd className="text-body1 text-ink">{e.venue.name}<span className="block text-body2 text-ink-secondary">{e.venue.address}</span></dd></div>
            </dl>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-7xl space-y-10 px-4 pt-8">
        <section aria-labelledby="about">
          <h2 id="about" className="text-title1 text-ink">About</h2>
          <p className="mt-2 max-w-3xl text-body1 text-ink-secondary">{e.description}</p>
          <p className="mt-4 flex max-w-3xl items-start gap-2 rounded-lg bg-brand-surface p-4 text-body2 text-ink">
            <ShieldCheck className="mt-0.5 shrink-0 text-brand" />
            Entry is tied to a verified person. Up to {e.ticketCap} tickets per verified person for this event, and tickets can only be transferred to other verified users.
          </p>
        </section>

        {e.artists.length > 0 && (
          <section aria-labelledby="lineup">
            <h2 id="lineup" className="text-title1 text-ink">Line-up</h2>
            <ul className="mt-3 flex flex-wrap gap-6">
              {e.artists.map((a) => (
                <li key={a.slug}><Link to={`/search?q=${encodeURIComponent(a.name)}`} className="flex w-24 flex-col items-center gap-2 rounded-lg text-center"><img src={a.imageUrl} alt="" className="h-20 w-20 rounded-full" /><span className="text-label1 text-ink">{a.name}</span></Link></li>
              ))}
            </ul>
          </section>
        )}

        <section ref={tiers} aria-labelledby="tickets" className="scroll-mt-32">
          <h2 id="tickets" className="text-title1 text-ink">Tickets</h2>
          {notice && <p role="status" className="mt-2 rounded-md bg-bg-secondary p-3 text-body2 text-ink">Checkout isn’t available in this build yet. Booking opens with the next release.</p>}
          <ul className="mt-3 grid gap-3 md:grid-cols-2">
            {e.tiers.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 rounded-lg border border-line-moderate p-4">
                <div>
                  <h3 className="text-title3 text-ink">{t.name}</h3>
                  {t.description && <p className="text-body3 text-ink-secondary">{t.description}</p>}
                </div>
                <p className="text-title3 text-ink">{formatPrice(t.priceInr)}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line-subtle bg-bg-primary/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div>
            <p className="text-body3 text-ink-secondary">Starts from</p>
            <p className="text-title2 text-ink">{e.priceFrom !== null ? formatPrice(e.priceFrom) : "—"}</p>
          </div>
          <button type="button" onClick={book} className="h-12 rounded-full bg-brand px-8 text-title3 text-brand-on hover:opacity-90">Book tickets</button>
        </div>
      </div>
    </article>
  );
}
