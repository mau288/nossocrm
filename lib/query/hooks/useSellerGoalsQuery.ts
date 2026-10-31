/**
 * TanStack Query hooks das metas por vendedor (ARK Onda 3 / 3.3).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../queryKeys';
import { sellerGoalsService } from '@/lib/supabase/sellerGoals';
import { useAuth } from '@/context/AuthContext';
import type { SellerGoalInput, SellerGoalProgress } from '@/types';

export const useSellerGoals = (includeArchived = false) => {
  const { user, profile, loading: authLoading } = useAuth();
  const orgId = profile?.organization_id ?? '';

  return useQuery<SellerGoalProgress[]>({
    queryKey: [...queryKeys.gestao.sellerGoals(orgId), includeArchived ? 'com-arquivadas' : 'ativas'] as const,
    queryFn: async () => {
      const { data, error } = await sellerGoalsService.getProgress(includeArchived);
      if (error) throw error;
      return data || [];
    },
    staleTime: 60 * 1000,
    enabled: !authLoading && !!user && !!orgId,
  });
};

function useInvalidateSellerGoals() {
  const queryClient = useQueryClient();
  const { profile } = useAuth();
  const orgId = profile?.organization_id ?? '';
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.gestao.sellerGoals(orgId) });
}

export const useCreateSellerGoal = () => {
  const invalidate = useInvalidateSellerGoals();
  return useMutation({
    mutationFn: async (input: SellerGoalInput) => {
      const { data, error } = await sellerGoalsService.create(input);
      if (error) throw error;
      return data;
    },
    onSettled: () => void invalidate(),
  });
};

export const useUpdateSellerGoal = () => {
  const invalidate = useInvalidateSellerGoals();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<SellerGoalInput> }) => {
      const { error } = await sellerGoalsService.update(id, patch);
      if (error) throw error;
    },
    onSettled: () => void invalidate(),
  });
};

export const useArchiveSellerGoal = () => {
  const invalidate = useInvalidateSellerGoals();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sellerGoalsService.archive(id);
      if (error) throw error;
    },
    onSettled: () => void invalidate(),
  });
};

export const useDeleteSellerGoal = () => {
  const invalidate = useInvalidateSellerGoals();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await sellerGoalsService.remove(id);
      if (error) throw error;
    },
    onSettled: () => void invalidate(),
  });
};
