import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth.jsx";

/** If you left mid-checkout, offer a way back while the hold is still alive. */
export default function ActiveOrderBanner() {
  const { signedIn, call } = useAuth();
  const { pathname } = useLocation();
  const [order, setOrder] = useState(null);
  useEffect(() => {
    if (!signedIn || pathname.startsWith("/checkout")) return setOrder(null);
    let live = true;
    call("/booking/orders?active=true")
      .then(({ status, body }) => live && setOrder(status === 200 ? body.order : null))
      .catch(() => live && setOrder(null));
    return () => {
      live = false;
    };
  }, [signedIn, pathname, call]);
  if (!order || !["HELD", "PAYMENT_PENDING", "PAID"].includes(order.state)) return null;
  return (
    <div className="bg-brand-surface">
      <p className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2 text-body2 text-ink" role="status">
        <span>You have tickets waiting to be paid for.</span>
        <Link to={`/checkout/${order.id}`} className="shrink-0 font-medium text-brand underline">Resume checkout</Link>
      </p>
    </div>
  );
}
