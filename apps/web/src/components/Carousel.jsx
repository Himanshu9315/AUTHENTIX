import { useRef } from "react";
import { ChevronLeft, ChevronRight } from "./Icons.jsx";

/** Titled horizontal scroller with snap points. Arrow buttons appear on wide screens. */
export default function Carousel({ title, subtitle, children }) {
  const ref = useRef(null);
  const scroll = (dir) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.8, behavior: "smooth" });
  const arrow = "hidden h-9 w-9 items-center justify-center rounded-full border border-line-moderate bg-bg-primary text-ink transition hover:bg-bg-secondary md:flex";
  return (
    <section aria-label={title} className="py-4">
      <div className="mx-auto flex max-w-7xl items-end justify-between px-4 pb-3">
        <div>
          <h2 className="text-title1 text-ink">{title}</h2>
          {subtitle && <p className="text-body2 text-ink-secondary">{subtitle}</p>}
        </div>
        <div className="flex gap-2">
          <button type="button" className={arrow} onClick={() => scroll(-1)} aria-label={`Scroll ${title} left`}><ChevronLeft /></button>
          <button type="button" className={arrow} onClick={() => scroll(1)} aria-label={`Scroll ${title} right`}><ChevronRight /></button>
        </div>
      </div>
      <div className="mx-auto max-w-7xl">
        <ul ref={ref} className="no-scrollbar flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth px-4 pb-2">
          {Array.isArray(children) ? children.map((c, i) => <li key={c.key ?? i} className="shrink-0 snap-start">{c}</li>) : <li className="shrink-0 snap-start">{children}</li>}
        </ul>
      </div>
    </section>
  );
}
