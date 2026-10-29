/**
 * @fileoverview Histórico de metas dos funis (ARK #53).
 *
 * Quando a meta de um board é trocada na tela, a anterior é guardada aqui com o resultado
 * final — é o que alimenta "Metas anteriores" no board e o bloco de histórico da Visão Geral.
 */

import { supabase } from './client';
import type { BoardGoal, BoardGoalHistoryEntry } from '@/types';
import { sanitizeUUID } from './utils';
import type { GoalProgress } from '@/lib/boards/goal-progress';

type DbBoardGoalHistory = {
  id: string;
  board_id: string;
  board_name: string;
  kpi: string | null;
  target_value: string | null;
  goal_type: string | null;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  achieved_value: number | string | null;
  achieved_display: string | null;
  won_count: number | null;
  won_value: number | string | null;
  archived_at: string;
};

function transform(db: DbBoardGoalHistory): BoardGoalHistoryEntry {
  return {
    id: db.id,
    boardId: db.board_id,
    boardName: db.board_name,
    kpi: db.kpi || '',
    targetValue: db.target_value || '',
    goalType: (db.goal_type as BoardGoal['type']) || undefined,
    description: db.description || undefined,
    startDate: db.start_date || undefined,
    endDate: db.end_date || undefined,
    achievedValue: Number(db.achieved_value ?? 0),
    achievedDisplay: db.achieved_display || String(db.achieved_value ?? 0),
    wonCount: db.won_count ?? 0,
    wonValue: Number(db.won_value ?? 0),
    archivedAt: db.archived_at,
  };
}

async function getCurrentOrganizationId(): Promise<string | null> {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('organization_id').eq('id', user.id).maybeSingle();
  return sanitizeUUID((profile as any)?.organization_id);
}

const SELECT = 'id, board_id, board_name, kpi, target_value, goal_type, description, start_date, end_date, achieved_value, achieved_display, won_count, won_value, archived_at';

export interface ArchiveBoardGoalInput {
  boardId: string;
  boardName: string;
  goal: BoardGoal;
  progress: GoalProgress;
}

export const boardGoalHistoryService = {
  /** Todas as metas arquivadas da organização (ou só de um board), mais recentes primeiro. */
  async getAll(boardId?: string): Promise<{ data: BoardGoalHistoryEntry[]; error: Error | null }> {
    try {
      if (!supabase) return { data: [], error: new Error('Supabase não configurado') };
      let query = supabase.from('board_goal_history').select(SELECT).order('archived_at', { ascending: false });
      if (boardId) query = query.eq('board_id', boardId);
      const { data, error } = await query;
      if (error) throw error;
      return { data: ((data || []) as DbBoardGoalHistory[]).map(transform), error: null };
    } catch (error) {
      return { data: [], error: error as Error };
    }
  },

  /**
   * Guarda a meta que está saindo. Idempotente: a mesma meta (board + KPI + alvo + período)
   * não entra duas vezes — salvar o formulário sem trocar a meta não gera linha.
   */
  async archive(input: ArchiveBoardGoalInput): Promise<{ data: BoardGoalHistoryEntry | null; error: Error | null }> {
    try {
      if (!supabase) return { data: null, error: new Error('Supabase não configurado') };
      const organizationId = await getCurrentOrganizationId();
      const { goal, progress } = input;

      let dupQuery = supabase.from('board_goal_history').select('id').eq('board_id', input.boardId);
      dupQuery = goal.kpi ? dupQuery.eq('kpi', goal.kpi) : dupQuery.is('kpi', null);
      dupQuery = goal.targetValue ? dupQuery.eq('target_value', goal.targetValue) : dupQuery.is('target_value', null);
      dupQuery = goal.startDate ? dupQuery.eq('start_date', goal.startDate) : dupQuery.is('start_date', null);
      const { data: existing } = await dupQuery.limit(1);
      if ((existing || []).length > 0) return { data: null, error: null };

      const { data, error } = await supabase
        .from('board_goal_history')
        .insert({
          organization_id: organizationId,
          board_id: input.boardId,
          board_name: input.boardName,
          kpi: goal.kpi || null,
          target_value: goal.targetValue || null,
          goal_type: goal.type || null,
          description: goal.description || null,
          start_date: goal.startDate || null,
          end_date: goal.endDate || null,
          achieved_value: progress.value,
          achieved_display: progress.display,
          won_count: progress.wonCount,
          won_value: progress.wonValue,
        })
        .select(SELECT)
        .single();
      if (error) throw error;
      return { data: transform(data as DbBoardGoalHistory), error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  },
};
