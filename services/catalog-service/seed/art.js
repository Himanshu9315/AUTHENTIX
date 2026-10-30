import { createHash } from "node:crypto";

// Original placeholder art generated from the title, so no third-party images or likenesses are used.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hue = (s, salt = "") => parseInt(createHash("sha1").update(salt + s).digest("hex").slice(0, 4), 16) % 360;

function wrap(text, max) {
  const lines = [];
  let line = "";
  for (const w of text.split(" ")) {
    if ((line + " " + w).trim().length > max && line) {
      lines.push(line);
      line = w;
    } else line = (line + " " + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

/** 3:4 poster with gradient, soft shapes, title and category. */
export function posterSvg(title, category) {
  const h1 = hue(title);
  const h2 = (h1 + 55) % 360;
  const lines = wrap(title, 14);
  const text = lines
    .map((l, i) => `<text x="40" y="${470 + i * 64}" font-family="Be Vietnam Pro, Helvetica, Arial, sans-serif" font-size="54" font-weight="700" fill="#fff" letter-spacing="-1.5">${esc(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 800" role="img" aria-label="${esc(title)} poster">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1} 70% 42%)"/><stop offset="1" stop-color="hsl(${h2} 75% 22%)"/></linearGradient></defs>
<rect width="600" height="800" fill="url(#g)"/>
<circle cx="470" cy="150" r="170" fill="hsl(${h2} 85% 60%)" opacity=".35"/>
<circle cx="120" cy="330" r="110" fill="hsl(${h1} 90% 70%)" opacity=".25"/>
<rect x="40" y="70" width="${category.length * 15 + 36}" height="34" rx="17" fill="#fff" opacity=".9"/>
<text x="58" y="93" font-family="Be Vietnam Pro, Helvetica, Arial, sans-serif" font-size="16" font-weight="600" fill="#131316" text-transform="uppercase">${esc(category.toUpperCase())}</text>
${text}</svg>`;
}

/** Circular avatar with initials. */
export function avatarSvg(name) {
  const h = hue(name, "a");
  const initials = name.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" role="img" aria-label="${esc(name)}">
<circle cx="100" cy="100" r="100" fill="hsl(${h} 60% 40%)"/>
<text x="100" y="124" text-anchor="middle" font-family="Be Vietnam Pro, Helvetica, Arial, sans-serif" font-size="72" font-weight="700" fill="#fff">${esc(initials)}</text></svg>`;
}
