import { formatPrice } from "../lib/format.js";
import SeatMap from "./SeatMap.jsx";

/** Seat map for reserved events, quantity steppers per tier for general admission. */
export default function TicketPicker({ event, inventory, selection, setSelection }) {
  const max = Math.min(event.ticketCap, 10);
  const availableOf = Object.fromEntries(inventory.tiers.map((t) => [t.tierId, t.available]));

  if (inventory.seatMap) {
    const selected = new Set(selection.seats.map((s) => s.id));
    const toggle = (seat) =>
      setSelection((sel) => ({ ...sel, seats: selected.has(seat.id) ? sel.seats.filter((s) => s.id !== seat.id) : [...sel.seats, seat] }));
    const tierById = Object.fromEntries(event.tiers.map((t) => [t.id, t]));
    return (
      <div>
        <SeatMap seatMap={inventory.seatMap} seats={inventory.seats} tiers={event.tiers} selected={selected} onToggle={toggle} maxSeats={max} />
        {selection.seats.length > 0 && (
          <ul className="mt-4 space-y-1" aria-label="Selected seats">
            {selection.seats.map((s) => (
              <li key={s.id} className="flex justify-between text-body2 text-ink">
                <span>{s.section} {s.row}-{s.number}</span>
                <span>{formatPrice(tierById[s.tierId].priceInr)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const total = Object.values(selection.qty).reduce((a, b) => a + b, 0);
  const step = (tierId, delta) =>
    setSelection((sel) => {
      const next = Math.max(0, (sel.qty[tierId] ?? 0) + delta);
      return { ...sel, qty: { ...sel.qty, [tierId]: next } };
    });
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {event.tiers.map((t) => {
        const qty = selection.qty[t.id] ?? 0;
        const left = availableOf[t.id] ?? 0;
        const canAdd = total < max && qty < left;
        return (
          <li key={t.id} className="flex items-center justify-between gap-4 rounded-lg border border-line-moderate p-4">
            <div>
              <h3 className="text-title3 text-ink">{t.name}</h3>
              {t.description && <p className="text-body3 text-ink-secondary">{t.description}</p>}
              <p className="mt-1 text-title4 text-ink">{formatPrice(t.priceInr)}</p>
              <p className="text-body3 text-ink-tertiary">{left === 0 ? "Sold out" : left <= 20 ? `Only ${left} left` : "Available"}</p>
            </div>
            <div className="flex items-center gap-3" role="group" aria-label={`${t.name} quantity`}>
              <button type="button" onClick={() => step(t.id, -1)} disabled={qty === 0} aria-label={`Remove one ${t.name} ticket`} className="h-10 w-10 rounded-full border border-line-moderate text-title3 text-ink disabled:opacity-40">−</button>
              <span className="w-6 text-center text-title3 text-ink" aria-live="polite">{qty}</span>
              <button type="button" onClick={() => step(t.id, 1)} disabled={!canAdd} aria-label={`Add one ${t.name} ticket`} className="h-10 w-10 rounded-full border border-line-moderate text-title3 text-ink disabled:opacity-40">+</button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
