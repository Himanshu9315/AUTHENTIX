import { Link } from "react-router-dom";
import { formatDistance, formatPrice, formatRange } from "../lib/format.js";
import { ShieldCheck } from "./Icons.jsx";

/** Image-led card: poster, title, venue + distance, date and time range. */
export default function EventCard({ event, className = "w-44 sm:w-52" }) {
  const distance = formatDistance(event.distanceKm);
  return (
    <Link to={`/events/${event.slug}`} className={`group block ${className} rounded-lg`}>
      <div className="relative aspect-[3/4] overflow-hidden rounded-lg bg-bg-secondary">
        <img src={event.posterUrl} alt={`${event.title} poster`} loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" />
        {event.hotSale && <span className="absolute left-2 top-2 rounded-full bg-ink px-2 py-1 text-label3 text-bg-primary">Hot sale</span>}
        <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-full bg-bg-primary/90 px-2 py-1 text-label3 text-brand">
          <ShieldCheck width={12} height={12} /> Verified entry
        </span>
      </div>
      <h3 className="mt-3 line-clamp-2 text-title3 text-ink">{event.title}</h3>
      <p className="mt-1 truncate text-body3 text-ink-secondary">
        {event.venue.name}{distance ? ` • ${distance}` : ""}
      </p>
      <p className="mt-1 text-body3 text-ink-secondary">{formatRange(event.startsAt, event.endsAt)}</p>
      {event.priceFrom !== null && <p className="mt-1 text-label1 text-ink">From {formatPrice(event.priceFrom)}</p>}
    </Link>
  );
}

export function EventCardSkeleton({ className = "w-44 sm:w-52" }) {
  return (
    <div className={className} aria-hidden="true">
      <div className="aspect-[3/4] animate-pulse rounded-lg bg-bg-secondary" />
      <div className="mt-3 h-4 w-3/4 animate-pulse rounded bg-bg-secondary" />
      <div className="mt-2 h-3 w-1/2 animate-pulse rounded bg-bg-secondary" />
    </div>
  );
}
