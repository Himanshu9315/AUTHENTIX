import { useMemo } from "react";
import Carousel from "../components/Carousel.jsx";
import EventCard, { EventCardSkeleton } from "../components/EventCard.jsx";
import ArtistChip from "../components/ArtistChip.jsx";
import { qs } from "../lib/api.js";
import { useFetch } from "../lib/useFetch.js";
import { useLocationCtx } from "../lib/location.jsx";

function EventRow({ title, subtitle, path }) {
  const { data, loading, error } = useFetch(path);
  if (!loading && (error || data?.items.length === 0)) return null; // hide empty sections
  return (
    <Carousel title={title} subtitle={subtitle}>
      {loading ? [0, 1, 2, 3, 4].map((i) => <EventCardSkeleton key={i} />) : data.items.map((e) => <EventCard key={e.id} event={e} />)}
    </Carousel>
  );
}

export default function Home() {
  const { city, coords } = useLocationCtx();
  const near = useMemo(() => ({ lat: coords?.lat, lng: coords?.lng }), [coords]);
  const here = (category, extra = {}) => `/events${qs({ city, category, ...near, limit: 12, ...extra })}`;
  const artists = useFetch(`/artists${qs({ city })}`);

  return (
    <div className="pb-4">
      <section className="mx-auto max-w-7xl px-4 pt-6">
        <div className="rounded-xl bg-brand-surface p-6 md:p-10">
          <h1 className="text-headline2 text-ink md:text-headline1">Live events. Real fans. Verified entry.</h1>
          <p className="mt-2 max-w-xl text-body1 text-ink-secondary">Every ticket is tied to one verified person, so the seats go to people who actually want to be there.</p>
        </div>
      </section>

      {artists.data?.items.length > 0 && (
        <Carousel title="Artists in your city">
          {artists.data.items.map((a) => <ArtistChip key={a.slug} artist={a} />)}
        </Carousel>
      )}
      <EventRow title="Concerts near you" path={here("concerts")} />
      <EventRow title="Festivals this season" path={here("festivals")} />
      <EventRow title="Laugh out loud" path={here("comedy")} />
      <EventRow title="Explore music events near you" subtitle="Across all cities" path={`/events${qs({ ...near, category: "concerts", limit: 12 })}`} />
    </div>
  );
}
