/**
 * @fileoverview Serviço Supabase para os gateways de pagamento e suas taxas.
 *
 * A taxa mora em dois níveis: `gateways.fee_pct` é o padrão do gateway e `gateway_fees`
 * guarda a taxa de cada forma de pagamento. Sem linha para a forma escolhida, vale o padrão.
 */

import { supabase } from './client';
import type { Gateway, GatewayFee } from '@/types';
import { sanitizeUUID } from './utils';

let cachedOrgId: string | null = null;
let cachedOrgUserId: string | null = null;

async function getCurrentOrganizationId(): Promise<string | null> {
  if (!supabase) return null;

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  if (cachedOrgUserId === user.id && cachedOrgId) return cachedOrgId;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .maybeSingle();

  if (error) return null;

  const orgId = sanitizeUUID((profile as any)?.organization_id);
  cachedOrgUserId = user.id;
  cachedOrgId = orgId;
  return orgId;
}

type DbGateway = {
  id: string;
  organization_id: string | null;
  name: string;
  fee_pct: number | string;
  active: boolean | null;
  gateway_fees?: DbGatewayFee[] | null;
};

type DbGatewayFee = {
  id: string;
  gateway_id: string;
  payment_method: string;
  fee_pct: number | string;
};

function transformFee(db: DbGatewayFee): GatewayFee {
  return {
    id: db.id,
    gatewayId: db.gateway_id,
    paymentMethod: db.payment_method,
    feePct: Number(db.fee_pct ?? 0),
  };
}

function transformGateway(db: DbGateway): Gateway {
  return {
    id: db.id,
    organizationId: db.organization_id || undefined,
    name: db.name,
    feePct: Number(db.fee_pct ?? 0),
    active: db.active ?? true,
    fees: (db.gateway_fees || []).map(transformFee),
  };
}

const SELECT = 'id, organization_id, name, fee_pct, active, gateway_fees(id, gateway_id, payment_method, fee_pct)';

export const gatewaysService = {
  async getAll(): Promise<{ data: Gateway[]; error: Error | null }> {
    try {
      if (!supabase) return { data: [], error: new Error('Supabase não configurado') };

      const { data, error } = await supabase
        .from('gateways')
        .select(SELECT)
        .order('name', { ascending: true });

      if (error) return { data: [], error };
      return { data: ((data || []) as DbGateway[]).map(transformGateway), error: null };
    } catch (e) {
      return { data: [], error: e as Error };
    }
  },

  async getActive(): Promise<{ data: Gateway[]; error: Error | null }> {
    try {
      if (!supabase) return { data: [], error: new Error('Supabase não configurado') };

      const { data, error } = await supabase
        .from('gateways')
        .select(SELECT)
        .eq('active', true)
        .order('name', { ascending: true });

      if (error) return { data: [], error };
      return { data: ((data || []) as DbGateway[]).map(transformGateway), error: null };
    } catch (e) {
      return { data: [], error: e as Error };
    }
  },

  async create(input: { name: string; feePct: number }): Promise<{ data: Gateway | null; error: Error | null }> {
    try {
      if (!supabase) return { data: null, error: new Error('Supabase não configurado') };

      const { data: { user } } = await supabase.auth.getUser();
      const organizationId = await getCurrentOrganizationId();

      const { data, error } = await supabase
        .from('gateways')
        .insert({
          name: input.name,
          fee_pct: input.feePct,
          active: true,
          owner_id: sanitizeUUID(user?.id),
          organization_id: organizationId,
        })
        .select(SELECT)
        .single();

      if (error) return { data: null, error };
      return { data: transformGateway(data as DbGateway), error: null };
    } catch (e) {
      return { data: null, error: e as Error };
    }
  },

  async update(id: string, updates: Partial<{ name: string; feePct: number; active: boolean }>): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase não configurado') };

      const payload: Record<string, unknown> = {};
      if (updates.name !== undefined) payload.name = updates.name;
      if (updates.feePct !== undefined) payload.fee_pct = updates.feePct;
      if (updates.active !== undefined) payload.active = updates.active;
      payload.updated_at = new Date().toISOString();

      const { error } = await supabase.from('gateways').update(payload).eq('id', sanitizeUUID(id));
      return { error: error ?? null };
    } catch (e) {
      return { error: e as Error };
    }
  },

  async delete(id: string): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase não configurado') };
      const { error } = await supabase.from('gateways').delete().eq('id', sanitizeUUID(id));
      return { error: error ?? null };
    } catch (e) {
      return { error: e as Error };
    }
  },

  /** Grava a taxa de uma forma de pagamento. Taxa vazia (null) apaga a linha e faz a
   *  forma voltar a usar a taxa padrão do gateway. */
  async setFee(gatewayId: string, paymentMethod: string, feePct: number | null): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase não configurado') };

      if (feePct === null) {
        const { error } = await supabase
          .from('gateway_fees')
          .delete()
          .eq('gateway_id', sanitizeUUID(gatewayId))
          .eq('payment_method', paymentMethod);
        return { error: error ?? null };
      }

      const organizationId = await getCurrentOrganizationId();
      const { error } = await supabase
        .from('gateway_fees')
        .upsert({
          gateway_id: sanitizeUUID(gatewayId),
          payment_method: paymentMethod,
          fee_pct: feePct,
          organization_id: organizationId,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'gateway_id,payment_method' });

      return { error: error ?? null };
    } catch (e) {
      return { error: e as Error };
    }
  },
};

/**
 * Imposto padrao da organizacao. Fica em organization_settings porque vale para a empresa
 * inteira, nao para um gateway — o gateway cobra taxa, o governo cobra imposto.
 */
export const financeiroSettingsService = {
  async getDefaultTaxPct(): Promise<number> {
    try {
      if (!supabase) return 0;
      const organizationId = await getCurrentOrganizationId();
      if (!organizationId) return 0;

      const { data, error } = await supabase
        .from('organization_settings')
        .select('default_tax_pct')
        .eq('organization_id', organizationId)
        .maybeSingle();

      if (error || !data) return 0;
      return Number((data as any).default_tax_pct ?? 0);
    } catch {
      return 0;
    }
  },

  async setDefaultTaxPct(taxPct: number): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase nao configurado') };
      const organizationId = await getCurrentOrganizationId();
      if (!organizationId) return { error: new Error('Organizacao nao encontrada') };

      const { error } = await supabase
        .from('organization_settings')
        .upsert({
          organization_id: organizationId,
          default_tax_pct: taxPct,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'organization_id' });

      return { error: error ?? null };
    } catch (e) {
      return { error: e as Error };
    }
  },
};
