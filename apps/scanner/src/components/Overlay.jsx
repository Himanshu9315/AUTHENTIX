import { useEffect } from "react";

const BG = { go: "bg-go", stop: "bg-stop", wait: "bg-wait" };

/** Full-screen result you can read from arm's length at a dark gate. Tap to dismiss; it also clears itself. */
export default function Overlay({ overlay, onDone }) {
  useEffect(() => {
    if (!overlay) return;
    try {
      navigator.vibrate?.(overlay.kind === "go" ? 120 : [200, 100, 200]);
    } catch {}
    const t = setTimeout(onDone, overlay.kind === "wait" ? 1800 : 2500);
    return () => clearTimeout(t);
  }, [overlay, onDone]);
  if (!overlay) return null;
  return (
    <div role="alert" aria-live="assertive" onClick={onDone} className={`fixed inset-0 z-50 flex flex-col items-center justify-center px-6 text-center text-white ${BG[overlay.kind]}`}>
      <p className="text-display1" aria-hidden="true">{overlay.kind === "go" ? "✓" : overlay.kind === "stop" ? "✕" : "…"}</p>
      <p className="mt-2 text-display3">{overlay.title}</p>
      {overlay.detail && <p className="mt-3 text-headline3">{overlay.detail}</p>}
      {overlay.sub && <p className="mt-2 text-title2">{overlay.sub}</p>}
      <p className="mt-10 text-title4">Tap to continue</p>
    </div>
  );
}
