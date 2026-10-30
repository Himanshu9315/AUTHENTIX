import { useState } from "react";
import { MoonIcon, SunIcon } from "./Icons.jsx";

export default function ThemeToggle() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? "light");
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {}
  };
  return (
    <button type="button" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} className="flex h-10 w-10 items-center justify-center rounded-full text-ink hover:bg-bg-secondary">
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
