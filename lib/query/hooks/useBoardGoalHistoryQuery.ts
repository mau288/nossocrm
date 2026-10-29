/**
 * TanStack Query hooks do histórico de metas dos funis (ARK #53).
 *
 * O cabeçalho do board lista as metas anteriores daquele funil; a Visão Geral mostra
 * o histórico de todos os funis (base do gráfico de metas que vem depois).
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../queryKeys';
import { boardGoalHistoryService, type ArchiveBoardGoalInput } from '@/lib/supabase/boardGoals';
import { useAuth } from '@/context/AuthContext';
import type { BoardGoalHistoryEntry } from '@/types';

export const useBoardGoalHistory = (boardId?: string) => {
  const { user, loading: authLoading } = useAuth();

  return useQuery<BoardGoalHistoryEntry[]>({
    queryKey: [...queryKeys.boardGoalHistory.lists(), boardId ?? 'all'] as const,
    queryFn: async () => {
      const { data, error } = await boardGoalHistoryService.getAll(boardId);
      if (error) throw error;
      return data || [];
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: !authLoading && !!user,
  });
};

export const useArchiveBoardGoal = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: ArchiveBoardGoalInput) => {
      const { data, error } = await boardGoalHistoryService.archive(input);
      if (error) throw error;
      return data;
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.boardGoalHistory.all });
    },
  });
};
