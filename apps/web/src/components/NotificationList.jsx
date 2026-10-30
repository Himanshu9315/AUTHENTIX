import { ago } from "../lib/inbox.js";

/** A list of inbox entries. Unread ones are marked with more than colour: a dot and the word "unread" for screen readers. */
export default function NotificationList({ items, onOpen }) {
  return (
    <ul className="divide-y divide-line-subtle">
      {items.map((n) => (
        <li key={n.id}>
          <button type="button" onClick={() => onOpen(n)} className="flex w-full items-start gap-3 px-1 py-3 text-left hover:bg-bg-secondary">
            <span aria-hidden="true" className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-brand"}`} />
            <span className="min-w-0 flex-1">
              <span className="block text-title4 text-ink">{n.readAt ? "" : <span className="sr-only">Unread: </span>}{n.title}</span>
              <span className="block text-body2 text-ink-secondary">{n.body}</span>
              <span className="block text-body3 text-ink-tertiary">{ago(n.createdAt)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
