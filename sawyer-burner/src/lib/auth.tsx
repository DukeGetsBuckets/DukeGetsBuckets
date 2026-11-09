import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Me } from "../../shared/types";
import { api, setUnauthorizedHandler } from "./api";

interface AuthState {
  me: Me | null;
  loading: boolean;
  setMe: (me: Me | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>(null as unknown as AuthState);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { user } = await api.get<{ user: Me | null }>("/api/auth/me");
      setMe(user);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.post("/api/auth/logout").catch(() => {});
    sessionStorage.clear();
    setMe(null);
  }, []);

  useEffect(() => {
    refresh();
    setUnauthorizedHandler(() => setMe(null)); // session expired/revoked mid-use
  }, [refresh]);

  return <AuthCtx.Provider value={{ me, loading, setMe, refresh, logout }}>{children}</AuthCtx.Provider>;
}

export const useAuth = () => useContext(AuthCtx);
