"use client";

import * as React from "react";

export type ThemePreference = "system" | "dark" | "light";
interface ThemeContextValue {
  preference: ThemePreference;
  resolved: "dark" | "light";
  setPreference: (p: ThemePreference) => void;
}
const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function applyTheme(preference: ThemePreference): "dark" | "light" {
  const resolved = preference === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  document.cookie = `tempo-theme=${preference}; path=/; max-age=31536000; samesite=lax`;
  return resolved;
}

export function ThemeProvider({ initial, children }: { initial: ThemePreference; children: React.ReactNode }) {
  const [preference, setPref] = React.useState<ThemePreference>(initial);
  const [resolved, setResolved] = React.useState<"dark" | "light">("dark");

  React.useEffect(() => {
    setResolved(applyTheme(preference));
    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const value = React.useMemo(() => ({ preference, resolved, setPreference: setPref }), [preference, resolved]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}
