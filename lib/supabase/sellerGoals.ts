/**
 * @fileoverview Metas por vendedor (ARK Onda 3 / 3.3).
 *
 * Tabela `seller_goals` (uma linha por meta; arquivar = `archived_at`) e RPC
 * `get_seller_goals_progress` (ganhos/perdas na janela, ritmo esperado e status).
 * Escrita so para admin (RLS); leitura para a org, a RPC recorta o vendedor.
 */

import { supabase } from './client';
import { sanitizeUUID } from './utils';
import type { SellerGoalInput, SellerGoalProgress } from '@/types';

async function getCurrentOrganizationId(): Promise<string | null> {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('organization_id').eq('id', user.id).maybeSingle();
  return sanitizeUUID((profile as any)?.organization_id);
}

export const sellerGoalsService = {
  async getProgress(includeArchived = false): Promise<{ data: SellerGoalProgress[] | null; error: Error | null }> {
    try {
      if (!supabase) return { data: null, error: new Error('Supabase não configurado') };
      const orgId = await getCurrentOrganizationId();
      if (!orgId) return { data: null, error: new Error('Organização não encontrada') };
      const { data, error } = await supabase.rpc('get_seller_goals_progress', {
        p_org_id: orgId,
        p_include_archived: includeArchived,
      });
      if (error) return { data: null, error: new Error(error.message) };
      return { data: (data || []) as SellerGoalProgress[], error: null };
    } catch (e) {
      return { data: null, error: e as Error };
    }
  },

  async create(input: SellerGoalInput): Promise<{ data: { id: string } | null; error: Error | null }> {
    try {
      if (!supabase) return { data: null, error: new Error('Supabase não configurado') };
      const orgId = await getCurrentOrganizationId();
      if (!orgId) return { data: null, error: new Error('Organização não encontrada') };
      const { data: { user } } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from('seller_goals')
        .insert({
          organization_id: orgId,
          user_id: input.userId,
          board_id: input.boardId || null,
          kpi: input.kpi?.trim() || 'Meta do vendedor',
          goal_type: input.goalType,
          target_value: input.targetValue,
          start_date: input.startDate,
          end_date: input.endDate,
          description: input.description?.trim() || null,
          created_by: user?.id ?? null,
        })
        .select('id')
        .single();
      if (error) return { data: null, error: new Error(error.message) };
      return { data: { id: (data as { id: string }).id }, error: null };
    } catch (e) {
      return { data: null, error: e as Error };
    }
  },

  async update(id: string, patch: Partial<SellerGoalInput>): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase não configurado') };
      const row: Record<string, unknown> = {};
      if (patch.userId !== undefined) row.user_id = patch.userId;
      if (patch.boardId !== undefined) row.board_id = patch.boardId || null;
      if (patch.kpi !== undefined) row.kpi = patch.kpi?.trim() || 'Meta do vendedor';
      if (patch.goalType !== undefined) row.goal_type = patch.goalType;
      if (patch.targetValue !== undefined) row.target_value = patch.targetValue;
      if (patch.startDate !== undefined) row.start_date = patch.startDate;
      if (patch.endDate !== undefined) row.end_date = patch.endDate;
      if (patch.description !== undefined) row.description = patch.description?.trim() || null;
      const { error } = await supabase.from('seller_goals').update(row).eq('id', id);
      return { error: error ? new Error(error.message) : null };
    } catch (e) {
      return { error: e as Error };
    }
  },

  async archive(id: string): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase não configurado') };
      const { error } = await supabase.from('seller_goals').update({ archived_at: new Date().toISOString() }).eq('id', id);
      return { error: error ? new Error(error.message) : null };
    } catch (e) {
      return { error: e as Error };
    }
  },

  async remove(id: string): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase não configurado') };
      const { error } = await supabase.from('seller_goals').delete().eq('id', id);
      return { error: error ? new Error(error.message) : null };
    } catch (e) {
      return { error: e as Error };
    }
  },
};
