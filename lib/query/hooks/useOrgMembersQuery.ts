/**
 * @fileoverview Org Members Query Hook
 *
 * Lista membros da organização para uso em dropdowns/filtros.
 * staleTime alto (5min) pois profiles mudam raramente.
 *
 * @module lib/query/hooks/useOrgMembersQuery
 */

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { queryKeys } from '../queryKeys';
import { supabase } from '@/lib/supabase';
import { displayNameFromProfile } from '@/lib/supabase/deals';

export interface OrgMember {
  id: string;
  name: string;
}

export function useOrgMembersQuery() {
  const { profile } = useAuth();
  const orgId = profile?.organization_id;

  return useQuery({
    queryKey: queryKeys.orgMembers.list(orgId ?? ''),
    queryFn: async (): Promise<OrgMember[]> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, name, nickname, first_name, last_name')
        .eq('organization_id', orgId!)
        .order('name');

      if (error) throw error;
      // Mesma regra de nome do card/relatorio: apelido > nome + sobrenome > nome do cadastro
      return (data ?? []).map((p) => ({
        id: p.id,
        name: displayNameFromProfile(p),
      }));
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000, // 5 minutos
    gcTime: 30 * 60 * 1000, // 30 minutos
  });
}
