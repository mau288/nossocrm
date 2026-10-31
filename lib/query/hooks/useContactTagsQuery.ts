/**
 * ARK: tags em uso nos contatos da organizacao, com contagem — alimenta o filtro de
 * conversas. Agregado no banco pela RPC get_contact_tag_counts (Onda 1).
 */
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabase';

export interface ContactTagCount {
  tag: string;
  count: number;
}

export function useContactTagsQuery() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  return useQuery({
    queryKey: ['contactTags', orgId ?? ''],
    queryFn: async (): Promise<ContactTagCount[]> => {
      // ARK (Onda 1 / 1.6): agregado no banco (unnest + group by) — antes baixava `tags`
      // de todos os contatos e contava no navegador.
      const { data, error } = await supabase.rpc('get_contact_tag_counts');
      if (error) throw error;
      return ((data ?? []) as Array<{ tag: string; count: number | string }>).map((r) => ({
        tag: r.tag,
        count: Number(r.count) || 0,
      }));
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });
}
