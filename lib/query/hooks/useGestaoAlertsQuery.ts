/**
 * TanStack Query hooks dos alertas do gestor (ARK Onda 3 / 3.4).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../queryKeys';
import { gestaoAlertsService } from '@/lib/supabase/gestaoAlerts';
import { useAuth } from '@/context/AuthContext';
import type { GestaoAlertLogEntry, GestaoAlertSettings } from '@/types';

export const useGestaoAlertSettings = () => {
  const { user, profile, loading: authLoading } = useAuth();
  const orgId = profile?.organization_id ?? '';
  return useQuery<GestaoAlertSettings | null>({
    queryKey: queryKeys.gestao.alertSettings(orgId),
    queryFn: async () => {
      const { data, error } = await gestaoAlertsService.getSettings();
      if (error) throw error;
      return data;
    },
    staleTime: 60 * 1000,
    enabled: !authLoading && !!user && !!orgId && profile?.role === 'admin',
  });
};

export const useSaveGestaoAlertSettings = () => {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const orgId = profile?.organization_id ?? '';
  return useMutation({
    mutationFn: async (input: Omit<GestaoAlertSettings, 'organizationId' | 'updatedAt'>) => {
      const { error } = await gestaoAlertsService.saveSettings(input);
      if (error) throw error;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gestao.alertSettings(orgId) });
    },
  });
};

export const useGestaoAlertLog = (limit = 15) => {
  const { user, profile, loading: authLoading } = useAuth();
  const orgId = profile?.organization_id ?? '';
  return useQuery<GestaoAlertLogEntry[]>({
    queryKey: [...queryKeys.gestao.alertLog(orgId), limit] as const,
    queryFn: async () => {
      const { data, error } = await gestaoAlertsService.getLog(limit);
      if (error) throw error;
      return data || [];
    },
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
    enabled: !authLoading && !!user && !!orgId && profile?.role === 'admin',
  });
};

/** Dispara uma mensagem de teste para os destinatarios salvos (rota do servidor chama a edge function). */
export const useSendGestaoAlertTest = () => {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const orgId = profile?.organization_id ?? '';
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/gestao/alertas/test', { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `Falha ao enviar teste (HTTP ${res.status})`);
      return body as { ok: boolean; sent?: number; failed?: number; detail?: string };
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.gestao.alertLog(orgId) });
    },
  });
};
