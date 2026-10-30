import plugin from "tailwindcss/plugin";
import { borderRadius, brand, fontFamily, spacing, themes, typography } from "../web/src/design/tokens.js";

const vars = (theme) => Object.fromEntries(Object.entries(theme).map(([k, v]) => [`--${k}`, v]));

// Same design tokens as the customer app, so the two feel like one product.
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily,
      fontSize: typography,
      spacing,
      borderRadius,
      colors: {
        bg: { primary: "var(--bg-primary)", secondary: "var(--bg-secondary)" },
        ink: { DEFAULT: "var(--text-primary)", secondary: "var(--text-secondary)", tertiary: "var(--text-tertiary)" },
        line: { subtle: "var(--border-subtle)", moderate: "var(--border-moderate)" },
        brand: { ...brand, DEFAULT: "var(--brand)", surface: "var(--brand-surface)", on: "var(--on-brand)" },
        overlay: "var(--overlay)",
        // Result screens: fixed colours so a glance across a dark gate is unmistakable. White text on these is >= 4.5:1.
        go: "#0d7a3e",
        stop: "#b3261e",
        wait: "#8a5a00",
      },
    },
  },
  plugins: [
    plugin(({ addBase }) =>
      addBase({
        ':root, [data-theme="light"]': vars(themes.light),
        '[data-theme="dark"]': vars(themes.dark),
      }),
    ),
  ],
};
