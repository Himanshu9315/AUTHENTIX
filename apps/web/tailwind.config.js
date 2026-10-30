import plugin from "tailwindcss/plugin";
import { borderRadius, brand, fontFamily, spacing, themes, typography } from "./src/design/tokens.js";

const vars = (theme) => Object.fromEntries(Object.entries(theme).map(([k, v]) => [`--${k}`, v]));

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
      },
    },
  },
  plugins: [
    // Light/dark CSS variables are generated from tokens.js so there is one source of truth.
    plugin(({ addBase }) =>
      addBase({
        ':root, [data-theme="light"]': vars(themes.light),
        '[data-theme="dark"]': vars(themes.dark),
      }),
    ),
  ],
};
