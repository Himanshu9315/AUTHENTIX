import { useEffect, useRef, useState } from "react";
import { useLocationCtx } from "../lib/location.jsx";
import { ChevronDown, CrosshairIcon, PinIcon } from "./Icons.jsx";

export default function LocationSelector() {
  const { cities, city, setCity, useMyLocation, usingMyLocation } = useLocationCtx();
  const [open, setOpen] = useState(false);
  const root = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => !root.current?.contains(e.target) && setOpen(false);
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Location: ${city}. Change location`} className="flex h-10 items-center gap-1 rounded-full px-3 text-label1 text-ink hover:bg-bg-secondary">
        <PinIcon width={18} height={18} />
        <span className="max-w-[7rem] truncate">{city}</span>
        <ChevronDown width={16} height={16} />
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-2 w-60 rounded-lg border border-line-moderate bg-bg-primary p-2 shadow-lg">
          <ul aria-label="Cities">
            {cities.map((c) => (
              <li key={c.city}>
                <button type="button" aria-current={c.city === city ? "true" : undefined} onClick={() => { setCity(c.city); setOpen(false); }} className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-body2 hover:bg-bg-secondary ${c.city === city ? "text-brand" : "text-ink"}`}>
                  <span>{c.city}</span>
                  <span className="text-body3 text-ink-tertiary">{c.events} events</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => { useMyLocation(); setOpen(false); }} className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-body2 text-ink hover:bg-bg-secondary">
            <CrosshairIcon width={16} height={16} />
            {usingMyLocation ? "Using your location" : "Use my location for distances"}
          </button>
        </div>
      )}
    </div>
  );
}
