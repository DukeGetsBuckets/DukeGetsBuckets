"use client";

import * as React from "react";
import { DEFAULT_SETTINGS, type UserSettingsDTO } from "@/lib/settings";
import { useTheme } from "./ThemeProvider";

interface SettingsContextValue {
  settings: UserSettingsDTO;
  update: (patch: Partial<UserSettingsDTO>) => Promise<void>;
  saving: boolean;
}
const SettingsContext = React.createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ initial, authenticated, children }: { initial: UserSettingsDTO | null; authenticated: boolean; children: React.ReactNode }) {
  const [settings, setSettings] = React.useState<UserSettingsDTO>(initial ?? DEFAULT_SETTINGS);
  const [saving, setSaving] = React.useState(false);
  const { setPreference } = useTheme();

  React.useEffect(() => {
    document.documentElement.dataset.reducedMotion = settings.reducedMotion ? "true" : "false";
  }, [settings.reducedMotion]);

  // Guests keep settings in localStorage.
  React.useEffect(() => {
    if (authenticated) return;
    try {
      const raw = localStorage.getItem("tempo-settings");
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<UserSettingsDTO>) });
    } catch {
      /* ignore */
    }
  }, [authenticated]);

  const update = React.useCallback(
    async (patch: Partial<UserSettingsDTO>) => {
      setSettings((s) => ({ ...s, ...patch }));
      if (patch.theme) setPreference(patch.theme);
      if (!authenticated) {
        try {
          localStorage.setItem("tempo-settings", JSON.stringify({ ...settings, ...patch }));
        } catch {
          /* ignore */
        }
        return;
      }
      setSaving(true);
      try {
        const res = await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
        if (res.ok) setSettings(await res.json());
      } finally {
        setSaving(false);
      }
    },
    [authenticated, setPreference, settings],
  );

  const value = React.useMemo(() => ({ settings, update, saving }), [settings, update, saving]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = React.useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings outside SettingsProvider");
  return ctx;
}
