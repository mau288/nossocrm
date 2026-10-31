/**
 * @fileoverview ARK (Onda 2B) — Produtos comprados pelo contato.
 *
 * Lê a RPC `get_contact_purchases(contact_id)`: negócios GANHOS do contato, com o
 * produto resolvido pela tag `produto:<x>` do negócio (senão item do negócio, senão o
 * nome do funil), valor, data de fechamento e forma de pagamento (carga dos gateways).
 *
 * @module lib/query/hooks/useContactPurchasesQuery
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';
import { queryKeys } from '../queryKeys';

export interface ContactPurchase {
  deal_id: string;
  title: string;
  product: string | null;
  board: string | null;
  value: number | null;
  closed_at: string | null;
  payment_method: string | null;
  gateway: boolean;
}

export function useContactPurchases(contactId: string | undefined) {
  const { user, loading: authLoading } = useAuth();
  return useQuery({
    queryKey: [...queryKeys.contacts.detail(contactId || ''), 'purchases'] as const,
    queryFn: async (): Promise<ContactPurchase[]> => {
      if (!supabase) return [];
      const { data, error } = await supabase.rpc('get_contact_purchases', { p_contact_id: contactId! });
      if (error) throw error;
      return Array.isArray(data) ? (data as ContactPurchase[]) : [];
    },
    enabled: !authLoading && !!user && !!contactId,
    staleTime: 60_000,
  });
}
