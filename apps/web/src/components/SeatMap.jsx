import { useRef, useState } from "react";
import { formatPrice } from "../lib/format.js";

/**
 * SVG seat map. Seats are drawn from the x/y the inventory service returns. Each available seat is a
 * keyboard-focusable button; held and sold seats are shown but not selectable.
 */
export default function SeatMap({ seatMap, seats, tiers, selected, onToggle, maxSeats }) {
  const priceOf = Object.fromEntries(tiers.map((t) => [t.id, t]));
  const full = selected.size >= maxSeats;
  const R = 11;
  const els = useRef(new Map());
  const pickable = (s) => s.status === "available" && (selected.has(s.id) || !full);
  const order = seats.filter(pickable); // arrow keys move through the seats you can actually choose
  const [focusId, setFocusId] = useState(null);
  const tabStop = order.find((s) => s.id === focusId)?.id ?? order.find((s) => selected.has(s.id))?.id ?? order[0]?.id;
  const move = (from, delta) => {
    const i = order.findIndex((s) => s.id === from);
    const target = order[Math.max(0, Math.min(order.length - 1, i + delta))];
    if (target) els.current.get(target.id)?.focus();
  };
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line-subtle bg-bg-secondary p-2">
        <svg viewBox={seatMap.viewBox} className="mx-auto h-auto w-full min-w-[520px] max-w-3xl" role="group" aria-label="Seat map. Choose your seats.">
          <rect {...seatMap.stage} rx="8" className="fill-line-moderate" />
          <text x={seatMap.stage.x + seatMap.stage.width / 2} y={seatMap.stage.y + seatMap.stage.height / 2 + 5} textAnchor="middle" className="fill-ink-secondary text-[14px]">{seatMap.stage.label}</text>
          {seats.map((s) => {
            const isSel = selected.has(s.id);
            const tier = priceOf[s.tierId];
            const canPick = pickable(s);
            const label = `${s.section} row ${s.row} seat ${s.number}, ${tier ? formatPrice(tier.priceInr) : ""}, ${isSel ? "selected" : s.status}`;
            const toggle = () => canPick && onToggle(s);
            return (
              <g
                key={s.id}
                role="button"
                ref={(el) => (el ? els.current.set(s.id, el) : els.current.delete(s.id))}
                tabIndex={s.id === tabStop ? 0 : -1}
                onFocus={() => canPick && setFocusId(s.id)}
                aria-label={label}
                aria-pressed={isSel}
                aria-disabled={!canPick}
                onClick={toggle}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") return e.preventDefault(), toggle();
                  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
                  if (step) return e.preventDefault(), move(s.id, step);
                  if (e.key === "Home") return e.preventDefault(), move(s.id, -Infinity);
                  if (e.key === "End") return e.preventDefault(), move(s.id, Infinity);
                }}
                className={`group outline-none ${canPick ? "cursor-pointer" : "cursor-not-allowed"}`}
              >
                <circle cx={s.x} cy={s.y} r={R + 6} className="fill-transparent" />
                <circle
                  cx={s.x}
                  cy={s.y}
                  r={R}
                  className={`group-focus-visible:stroke-ink group-focus-visible:[stroke-width:4] ${isSel ? "fill-brand stroke-brand" : s.status === "available" ? "fill-bg-primary stroke-ink-secondary hover:fill-brand-surface" : "fill-line-moderate stroke-line-moderate"}`}
                  strokeWidth="1.5"
                />
                {isSel && <path d={`M${s.x - 5} ${s.y} l3.5 3.5 l6.5 -7`} fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="stroke-brand-on" />}
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-body3 text-ink-secondary" aria-label="Legend">
        <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full border-2 border-ink-secondary bg-bg-primary" /> Available</li>
        <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-brand" /> Selected</li>
        <li className="flex items-center gap-2"><span className="h-3 w-3 rounded-full bg-line-moderate" /> Taken</li>
        {tiers.map((t) => <li key={t.id}>{t.name}: {formatPrice(t.priceInr)}</li>)}
      </ul>
      <p className="sr-only" role="status">{selected.size} {selected.size === 1 ? "seat" : "seats"} selected</p>
      <p className="mt-2 text-body3 text-ink-tertiary">Use the arrow keys to move between seats, and Enter to select.</p>
      {full && <p role="status" className="mt-2 text-body2 text-ink-secondary">You can select up to {maxSeats} seats.</p>}
    </div>
  );
}
