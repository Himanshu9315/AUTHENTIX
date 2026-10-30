import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-20 text-center">
      <h1 className="text-headline2 text-ink">We couldn’t find that page</h1>
      <p className="mt-2 text-body1 text-ink-secondary">The event may have ended or the link may be wrong.</p>
      <Link to="/" className="mt-6 inline-block rounded-full bg-brand px-6 py-3 text-title3 text-brand-on">Back to home</Link>
    </div>
  );
}
