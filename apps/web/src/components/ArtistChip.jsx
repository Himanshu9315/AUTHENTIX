import { Link } from "react-router-dom";

/** Circular avatar with the name underneath. Links to a search for that artist. */
export default function ArtistChip({ artist }) {
  return (
    <Link to={`/search?q=${encodeURIComponent(artist.name)}`} className="group flex w-24 flex-col items-center gap-2 rounded-lg text-center sm:w-28">
      <img src={artist.imageUrl} alt="" width={96} height={96} loading="lazy" className="h-20 w-20 rounded-full object-cover transition group-hover:scale-105 sm:h-24 sm:w-24" />
      <span className="line-clamp-2 text-label1 text-ink">{artist.name}</span>
    </Link>
  );
}
