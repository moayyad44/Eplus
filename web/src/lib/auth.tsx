import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, authEvents } from './api';
import type { Me } from './types';

interface AuthValue {
  me: Me | null;
  loading: boolean;
  can: (perm: string) => boolean;
  canAny: (...perms: string[]) => boolean;
  logout: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const s = await api.get<Me | { needsRefresh: true } | null>('/auth/session').catch(() => null);
      if (s && 'needsRefresh' in s) {
        const ok = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'EmergencyPlus' } }).then((r) => r.ok).catch(() => false);
        return ok ? api.get<Me>('/auth/me').catch(() => null) : null;
      }
      return s as Me | null;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const me = q.data ?? null;
  const perms = useMemo(() => new Set(me?.permissions ?? []), [me]);

  useEffect(() => {
    const onUnauthorized = () => {
      qc.setQueryData(['me'], null);
    };
    authEvents.addEventListener('unauthorized', onUnauthorized);
    return () => authEvents.removeEventListener('unauthorized', onUnauthorized);
  }, [qc]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    qc.clear();
    qc.setQueryData(['me'], null);
  }, [qc]);

  const value = useMemo<AuthValue>(
    () => ({
      me,
      loading: q.isLoading,
      can: (p) => perms.has(p),
      canAny: (...ps) => ps.some((p) => perms.has(p)),
      logout,
      refresh: () => q.refetch(),
    }),
    [me, perms, q, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
};

/** Renders children only when the user holds (any of) the permission(s). UI convenience only — the API enforces. */
export function Can({ perm, any, children, fallback = null }: { perm?: string; any?: string[]; children: ReactNode; fallback?: ReactNode }) {
  const { can, canAny } = useAuth();
  const ok = perm ? can(perm) : any ? canAny(...any) : true;
  return <>{ok ? children : fallback}</>;
}
