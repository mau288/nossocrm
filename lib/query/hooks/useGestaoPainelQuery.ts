/**
 * @fileoverview Painel do gestor (ARK Onda 3 / 3.1).
 *
 * Chama a RPC `get_gestao_painel()` — um JSON so com: conversas aguardando resposta
 * (snapshot de agora, por canal / vendedor / 20 mais antigas), tempo de 1a resposta
 * no periodo, abertas x resolvidas por dia e leads por origem/campanha x conversao.
 * Admin ve tudo e filtra por vendedor; vendedor so recebe o proprio recorte (a RPC
 * ignora `userId` quando o chamador nao e admin).
 *
 * @module lib/query/hooks/useGestaoPainelQuery
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { queryKeys } from '../queryKeys';
import { supabase } from '@/lib/supabase';
import type { PeriodFilter } from '@/features/dashboard/hooks/useDashboardMetrics';
import { periodToDateRange } from '@/lib/utils/periodToDateRange';

export interface GestaoPorCanal {
  channelId: string;
  channelName: string;
  channelType: string;
  count: number;
  oldestMinutes?: number;
  medianSeconds?: number;
  avgSeconds?: number;
}

export interface GestaoPorVendedor {
  userId: string | null;
  name: string;
  count: number;
  oldestMinutes?: number;
  medianSeconds?: number;
  avgSeconds?: number;
}

export interface GestaoConversaAguardando {
  conversationId: string;
  contactName: string | null;
  channelName: string;
  channelType: string;
  assignedName: string | null;
  minutes: number;
  preview: string | null;
}

export interface GestaoOrigem {
  origem?: string;
  campanha?: string;
  contatos: number;
  comNegocio: number;
  ganhos: number;
  valorGanho: number;
}

export interface GestaoPainel {
  aguardando: {
    total: number;
    oldestMinutes: number;
    porCanal: GestaoPorCanal[];
    porVendedor: GestaoPorVendedor[];
    lista: GestaoConversaAguardando[];
  };
  frt: {
    count: number;
    medianSeconds: number;
    avgSeconds: number;
    porCanal: GestaoPorCanal[];
    porVendedor: GestaoPorVendedor[];
  };
  porDia: Array<{ dia: string; abertas: number; resolvidas: number }>;
  origem: GestaoOrigem[];
  campanha: GestaoOrigem[];
  slaMinutes: number;
  maxHours: number;
  scopeUserId: string | null;
  isAdmin: boolean;
  geradoEm: string;
}

export function useGestaoPainelQuery(period: PeriodFilter, slaMinutes: number, userId?: string, maxHours = 168) {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  return useQuery({
    queryKey: queryKeys.gestao.painel(orgId ?? '', period, slaMinutes, userId, maxHours),
    queryFn: async (): Promise<GestaoPainel> => {
      const { start, end } = periodToDateRange(period);
      const { data, error } = await supabase.rpc('get_gestao_painel', {
        p_org_id: orgId!,
        p_start: start,
        p_end: end,
        p_sla_minutes: slaMinutes,
        p_user_id: userId ?? null,
        p_max_hours: maxHours,
      });
      if (error) throw error;
      return data as GestaoPainel;
    },
    enabled: !!orgId,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchInterval: 2 * 60_000, // a fila "aguardando" e um snapshot: renova sozinha a cada 2 min
  });
}
