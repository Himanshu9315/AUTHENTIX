import { useEffect, useRef } from "react";

/** Accessible modal: Escape closes, focus moves in and returns to where it came from, Tab stays inside. */
export default function Modal({ title, onClose, children }) {
  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    (box.current?.querySelector("[data-autofocus]") ?? box.current?.querySelector("button, input"))?.focus(); // data-autofocus wins, whatever the document order
    const onKey = (e) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      const items = [...box.current.querySelectorAll("button:not([disabled]), input:not([disabled]), a[href]")];
      if (items.length === 0) return;
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
      else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-overlay p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title} className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-xl bg-bg-primary p-5 shadow-lg sm:rounded-xl">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-title1 text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="h-10 w-10 shrink-0 rounded-full text-title2 text-ink-secondary hover:bg-bg-secondary">×</button>
        </div>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
