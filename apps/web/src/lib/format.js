const TZ = "Asia/Kolkata";
const dayFmt = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ });
const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

/** "Sat, 12 Nov • 7:00 pm – 11:00 pm" */
export const formatRange = (startsAt, endsAt) => {
  const s = new Date(startsAt);
  const e = new Date(endsAt);
  return `${dayFmt.format(s)} • ${timeFmt.format(s).toUpperCase()} – ${timeFmt.format(e).toUpperCase()}`;
};

export const formatPrice = (n) => inr.format(n);
export const formatDistance = (km) => (km === null || km === undefined ? null : `${km} km`);
