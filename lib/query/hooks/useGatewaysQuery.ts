/**
 * TanStack Query hooks para os gateways de pagamento.
 *
 * O card do negócio precisa da lista para preencher a taxa sozinho ao escolher o gateway,
 * e a Visão Geral precisa dela para calcular o resultado depois das taxas.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../queryKeys';
import { gatewaysService, financeiroSettingsService } from '@/lib/supabase';
import { useAuth } from '@/context/AuthContext';
import type { Gateway } from '@/types';

/** Todos os gateways, inclusive inativos (tela de configuração). */
export const useGateways = (options?: { enabled?: boolean }) => {
  const { user, loading: authLoading } = useAuth();
  const externalEnabled = options?.enabled ?? true;

  return useQuery<Gateway[]>({
    queryKey: queryKeys.gateways.lists(),
    queryFn: async () => {
      const { data, error } = await gatewaysService.getAll();
      if (error) throw error;
      return data || [];
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: !authLoading && !!user && externalEnabled,
  });
};

/** Só os ativos — é o que aparece no seletor do negócio. */
export const useActiveGateways = (options?: { enabled?: boolean }) => {
  const { user, loading: authLoading } = useAuth();
  const externalEnabled = options?.enabled ?? true;

  return useQuery<Gateway[]>({
    queryKey: [...queryKeys.gateways.lists(), 'active'] as const,
    queryFn: async () => {
      const { data, error } = await gatewaysService.getActive();
      if (error) throw error;
      return data || [];
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: !authLoading && !!user && externalEnabled,
  });
};

/** Imposto padrão da organização, em %. */
export const useDefaultTaxPct = (options?: { enabled?: boolean }) => {
  const { user, loading: authLoading } = useAuth();
  const externalEnabled = options?.enabled ?? true;

  return useQuery<number>({
    queryKey: [...queryKeys.gateways.all, 'defaultTaxPct'] as const,
    queryFn: () => financeiroSettingsService.getDefaultTaxPct(),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: !authLoading && !!user && externalEnabled,
  });
};

export const useSetGatewayFee = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ gatewayId, paymentMethod, feePct }: { gatewayId: string; paymentMethod: string; feePct: number | null }) => {
      const { error } = await gatewaysService.setFee(gatewayId, paymentMethod, feePct);
      if (error) throw error;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.gateways.all });
    },
  });
};
