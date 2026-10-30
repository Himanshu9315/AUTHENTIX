// Design tokens. Structure values (type scale, spacing, radii, greys, light/dark surface roles)
// were read from district.in's published CSS variables on 2026-10-30. Brand colour and fonts are
// Authentix's own: District's purple and PassengerSerif are not reused.

export const fontFamily = {
  sans: ["Be Vietnam Pro", "ui-sans-serif", "system-ui", "sans-serif"], // open licence (OFL), loaded from Google Fonts
};

// size / line-height / weight / letter-spacing, copied from District's typography scale
export const typography = {
  display1: ["64px", { lineHeight: "72px", letterSpacing: "-0.05rem", fontWeight: "700" }],
  display2: ["48px", { lineHeight: "56px", letterSpacing: "-0.04rem", fontWeight: "700" }],
  display3: ["36px", { lineHeight: "42px", letterSpacing: "-0.04rem", fontWeight: "700" }],
  headline1: ["32px", { lineHeight: "40px", letterSpacing: "-0.04rem", fontWeight: "700" }],
  headline2: ["28px", { lineHeight: "34px", letterSpacing: "-0.03rem", fontWeight: "700" }],
  headline3: ["24px", { lineHeight: "30px", letterSpacing: "-0.02rem", fontWeight: "700" }],
  title1: ["22px", { lineHeight: "28px", letterSpacing: "-0.01rem", fontWeight: "600" }],
  title2: ["18px", { lineHeight: "22px", letterSpacing: "-0.01rem", fontWeight: "600" }],
  title3: ["16px", { lineHeight: "20px", letterSpacing: "-0.01rem", fontWeight: "600" }],
  title4: ["14px", { lineHeight: "18px", letterSpacing: "0", fontWeight: "600" }],
  body1: ["16px", { lineHeight: "24px", fontWeight: "400" }],
  body2: ["14px", { lineHeight: "22px", fontWeight: "400" }],
  body3: ["12px", { lineHeight: "18px", fontWeight: "400" }],
  label1: ["14px", { lineHeight: "18px", fontWeight: "500" }],
  label2: ["12px", { lineHeight: "16px", fontWeight: "500" }],
  label3: ["11px", { lineHeight: "14px", fontWeight: "500" }],
};

// 4px base scale (District: space-4 ... space-80)
export const spacing = {
  1: "4px", 2: "8px", 3: "12px", 4: "16px", 5: "20px", 6: "24px",
  8: "32px", 10: "40px", 12: "48px", 14: "56px", 16: "64px", 18: "72px", 20: "80px",
};

export const borderRadius = {
  sm: "6px", DEFAULT: "8px", md: "12px", lg: "16px", xl: "24px", full: "9999px",
};

// District's neutral scale, used as-is
export const grey = {
  50: "#f7f7f7", 100: "#f1f1f2", 150: "#cfcfd3", 200: "#bfbfc4", 250: "#a5a5ac", 300: "#8b8b93",
  400: "#77777e", 500: "#545459", 600: "#3b3b3f", 700: "#2c2c2e", 800: "#1e1e20", 900: "#131316",
};

// Authentix brand: a teal that reads as "verified". 600 is the text/button shade (>= 4.5:1 on white).
export const brand = {
  50: "#effaf8", 100: "#d4f3ee", 200: "#a9e6dc", 300: "#6fd1c2", 400: "#34b8a6",
  500: "#12998a", 600: "#0c7c70", 700: "#0b645b", 800: "#0b4f48", 900: "#0a3a35",
};

// Semantic roles. Same names District uses (background-primary/secondary, border-subtle/moderate, ...),
// resolved per theme and exposed as CSS variables in index.css.
export const themes = {
  light: {
    "bg-primary": "#ffffff",
    "bg-secondary": grey[100],
    "text-primary": grey[900],
    "text-secondary": grey[500],
    "text-tertiary": "#65656c", // darker than District's grey-400 (#77777e), which is 3.9:1 on bg-secondary and fails AA
    "border-subtle": "rgba(0,0,0,0.08)",
    "border-moderate": "rgba(0,0,0,0.16)",
    "brand": brand[600],
    "on-brand": "#ffffff",
    "brand-surface": brand[50],
    "overlay": "rgba(0,0,0,0.4)",
  },
  dark: {
    "bg-primary": grey[900],
    "bg-secondary": grey[800],
    "text-primary": "#ffffff",
    "text-secondary": "rgba(255,255,255,0.72)",
    "text-tertiary": "rgba(255,255,255,0.56)",
    "border-subtle": "rgba(255,255,255,0.08)",
    "border-moderate": "rgba(255,255,255,0.16)",
    "brand": brand[300],
    "on-brand": grey[900],
    "brand-surface": brand[900],
    "overlay": "rgba(0,0,0,0.6)",
  },
};
