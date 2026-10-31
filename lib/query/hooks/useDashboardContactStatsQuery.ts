/**
 * ARK (Onda 1 / 1.4): estatísticas de contatos da Visão Geral via RPC
 * `get_dashboard_contact_stats` — uma linha em vez dos 1.000 contatos (604 KB).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';

export interface DashboardContactStats {
  total: number;
  active: number;
  inactive: number;
  churned: number;
  totalLtv: number;
  byStage: Record<string, number>;
  createdCurrent: number;
  createdPrevious: number;
}

const EMPTY: DashboardContactStats = {
  total: 0, active: 0, inactive: 0, churned: 0, totalLtv: 0, byStage: {}, createdCurrent: 0, createdPrevious: 0,
};

export function useDashboardContactStats(
  range: { start: Date; end: Date },
  previousRange: { start: Date; end: Date }
) {
  const { user, profile, loading: authLoading } = useAuth();
  const args = {
    p_start: range.start.toISOString(),
    p_end: range.end.toISOString(),
    p_prev_start: previousRange.start.toISOString(),
    p_prev_end: previousRange.end.toISOString(),
  };

  return useQuery({
    queryKey: ['dashboard', 'contactStats', profile?.organization_id ?? '', args.p_start, args.p_end],
    queryFn: async (): Promise<DashboardContactStats> => {
      const { data, error } = await supabase.rpc('get_dashboard_contact_stats', args);
      if (error) throw error;
      const j = (data ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0) || 0);
      return {
        total: num(j.total),
        active: num(j.active),
        inactive: num(j.inactive),
        churned: num(j.churned),
        totalLtv: num(j.total_ltv),
        byStage: (j.by_stage && typeof j.by_stage === 'object' ? j.by_stage : {}) as Record<string, number>,
        createdCurrent: num(j.created_current),
        createdPrevious: num(j.created_previous),
      };
    },
    placeholderData: EMPTY,
    staleTime: 60 * 1000,
    enabled: !authLoading && !!user && !!profile?.organization_id,
  });
}
