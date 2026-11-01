/**
 * @fileoverview Alertas do gestor no WhatsApp (ARK Onda 3 / 3.4).
 *
 * `gestao_alert_settings` (1 linha por org: quem recebe, por qual chip, limites e horarios)
 * e `gestao_alert_log` (cada envio). Quem verifica e envia e a edge function `gestao-alertas`,
 * chamada pelo pg_cron a cada 10 min. Aqui so leitura/escrita da configuracao (admin).
 */

import { supabase } from './client';
import { sanitizeUUID } from './utils';
import type { GestaoAlertLogEntry, GestaoAlertSettings, GestaoAlertRecipient } from '@/types';

async function getCurrentOrganizationId(): Promise<string | null> {
  if (!supabase) return null;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase.from('profiles').select('organization_id').eq('id', user.id).maybeSingle();
  return sanitizeUUID((profile as any)?.organization_id);
}

export const DEFAULT_ALERT_SETTINGS: Omit<GestaoAlertSettings, 'organizationId'> = {
  enabled: false,
  channelId: null,
  recipients: [],
  alertWaiting: true,
  alertWebhook: true,
  alertGoals: true,
  slaMinutes: 30,
  maxHours: 24,
  hoursStart: 8,
  hoursEnd: 20,
  weekdaysOnly: false,
  webhookErrorThreshold: 3,
  cooldownMinutes: 60,
  goalsHour: 9,
  waitingHours: null,
};

type DbSettings = {
  organization_id: string;
  enabled: boolean;
  channel_id: string | null;
  recipients: GestaoAlertRecipient[] | null;
  alert_waiting: boolean;
  alert_webhook: boolean;
  alert_goals: boolean;
  sla_minutes: number;
  max_hours: number;
  hours_start: number;
  hours_end: number;
  weekdays_only: boolean;
  webhook_error_threshold: number;
  cooldown_minutes: number;
  goals_hour: number;
  waiting_hours: number[] | null;
  updated_at: string;
};

function transform(db: DbSettings): GestaoAlertSettings {
  return {
    organizationId: db.organization_id,
    enabled: !!db.enabled,
    channelId: db.channel_id,
    recipients: Array.isArray(db.recipients) ? db.recipients : [],
    alertWaiting: !!db.alert_waiting,
    alertWebhook: !!db.alert_webhook,
    alertGoals: !!db.alert_goals,
    slaMinutes: db.sla_minutes,
    maxHours: db.max_hours,
    hoursStart: db.hours_start,
    hoursEnd: db.hours_end,
    weekdaysOnly: !!db.weekdays_only,
    webhookErrorThreshold: db.webhook_error_threshold,
    cooldownMinutes: db.cooldown_minutes,
    goalsHour: db.goals_hour,
    waitingHours: Array.isArray(db.waiting_hours) && db.waiting_hours.length > 0 ? db.waiting_hours : null,
    updatedAt: db.updated_at,
  };
}

export const gestaoAlertsService = {
  /** null = ainda nao configurado (a tela mostra os padroes). */
  async getSettings(): Promise<{ data: GestaoAlertSettings | null; error: Error | null }> {
    try {
      if (!supabase) return { data: null, error: new Error('Supabase não configurado') };
      const orgId = await getCurrentOrganizationId();
      if (!orgId) return { data: null, error: new Error('Organização não encontrada') };
      const { data, error } = await supabase.from('gestao_alert_settings').select('*').eq('organization_id', orgId).maybeSingle();
      if (error) return { data: null, error: new Error(error.message) };
      return { data: data ? transform(data as DbSettings) : null, error: null };
    } catch (e) {
      return { data: null, error: e as Error };
    }
  },

  async saveSettings(input: Omit<GestaoAlertSettings, 'organizationId' | 'updatedAt'>): Promise<{ error: Error | null }> {
    try {
      if (!supabase) return { error: new Error('Supabase não configurado') };
      const orgId = await getCurrentOrganizationId();
      if (!orgId) return { error: new Error('Organização não encontrada') };
      const { data: { user } } = await supabase.auth.getUser();
      const recipients = input.recipients
        .map((r) => ({ name: (r.name || '').trim(), phone: String(r.phone || '').replace(/\D/g, '') }))
        .filter((r) => r.phone.length >= 10);
      const { error } = await supabase.from('gestao_alert_settings').upsert(
        {
          organization_id: orgId,
          enabled: input.enabled,
          channel_id: input.channelId || null,
          recipients,
          alert_waiting: input.alertWaiting,
          alert_webhook: input.alertWebhook,
          alert_goals: input.alertGoals,
          sla_minutes: input.slaMinutes,
          max_hours: input.maxHours,
          hours_start: input.hoursStart,
          hours_end: input.hoursEnd,
          weekdays_only: input.weekdaysOnly,
          webhook_error_threshold: input.webhookErrorThreshold,
          cooldown_minutes: input.cooldownMinutes,
          goals_hour: input.goalsHour,
          waiting_hours: input.waitingHours && input.waitingHours.length > 0 ? input.waitingHours : null,
          updated_by: user?.id ?? null,
        },
        { onConflict: 'organization_id' }
      );
      return { error: error ? new Error(error.message) : null };
    } catch (e) {
      return { error: e as Error };
    }
  },

  async getLog(limit = 15): Promise<{ data: GestaoAlertLogEntry[] | null; error: Error | null }> {
    try {
      if (!supabase) return { data: null, error: new Error('Supabase não configurado') };
      const { data, error } = await supabase
        .from('gestao_alert_log')
        .select('id, alert_type, fingerprint, message, recipients, sent_ok, error, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) return { data: null, error: new Error(error.message) };
      return {
        data: (data || []).map((r: any) => ({
          id: r.id,
          alertType: r.alert_type,
          fingerprint: r.fingerprint,
          message: r.message,
          recipients: Array.isArray(r.recipients) ? r.recipients : [],
          sentOk: !!r.sent_ok,
          error: r.error,
          createdAt: r.created_at,
        })),
        error: null,
      };
    } catch (e) {
      return { data: null, error: e as Error };
    }
  },
};
