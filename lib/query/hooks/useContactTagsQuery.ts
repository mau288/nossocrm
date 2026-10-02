/**
 * ARK: tags em uso nos contatos da organizacao, com contagem — alimenta o filtro de
 * conversas. Agregado no cliente (centenas de contatos; cada linha so traz o array de tags).
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
      const { data, error } = await supabase
        .from('contacts')
        .select('tags')
        .eq('organization_id', orgId!)
        .is('deleted_at', null)
        .not('tags', 'eq', '{}');
      if (error) throw error;
      const counts = new Map<string, number>();
      for (const row of (data ?? []) as Array<{ tags: string[] | null }>) {
        for (const t of row.tags ?? []) {
          const tag = t.trim();
          if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
      return Array.from(counts, ([tag, count]) => ({ tag, count })).sort(
        (a, b) => b.count - a.count || a.tag.localeCompare(b.tag),
      );
    },
    enabled: !!orgId,
    staleTime: 60 * 1000,
  });
}
