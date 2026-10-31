'use client';

/**
 * Alertas do gestor no WhatsApp (ARK Onda 3 / 3.4) — so admin, dentro de Relatorios > Gestao.
 *
 * Configura quem recebe (nome + telefone), por qual chip da Evolution, quais gatilhos
 * (aguardando resposta · erro de webhook · meta em risco), limites e horario comercial.
 * A verificacao roda no banco/edge function a cada 10 min; aqui so a configuracao,
 * o botao de teste e o historico dos ultimos envios.
 */

import React, { useEffect, useState } from 'react';
import { Bell, Plus, Trash2, Send, CheckCircle2, XCircle } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { useMessagingChannels } from '@/lib/query/hooks/useMessagingChannelsQuery';
import {
  useGestaoAlertSettings,
  useSaveGestaoAlertSettings,
  useGestaoAlertLog,
  useSendGestaoAlertTest,
} from '@/lib/query/hooks/useGestaoAlertsQuery';
import { DEFAULT_ALERT_SETTINGS } from '@/lib/supabase/gestaoAlerts';
import type { GestaoAlertSettings, GestaoAlertRecipient } from '@/types';

type Form = Omit<GestaoAlertSettings, 'organizationId' | 'updatedAt'>;

const TIPO_LABEL: Record<string, string> = {
  waiting: 'Aguardando resposta',
  webhook: 'Erro de webhook',
  goals: 'Meta em risco',
  test: 'Teste',
};

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: string; hint?: string }> = ({ on, onChange, label, hint }) => (
  <label className="flex items-center gap-3 cursor-pointer">
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative w-10 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-primary-600' : 'bg-slate-200 dark:bg-white/10'}`}
    >
      <span className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${on ? 'left-5' : 'left-1'}`} />
    </button>
    <span>
      <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
      {hint && <span className="block text-[11px] text-slate-400">{hint}</span>}
    </span>
  </label>
);

export const AlertSettingsSection: React.FC = () => {
  const { addToast, showToast } = useToast();
  const toast = addToast || showToast;
  const { data: saved, isLoading } = useGestaoAlertSettings();
  const { data: channels = [] } = useMessagingChannels();
  const { data: log = [] } = useGestaoAlertLog(12);
  const salvar = useSaveGestaoAlertSettings();
  const testar = useSendGestaoAlertTest();

  const [form, setForm] = useState<Form>({ ...DEFAULT_ALERT_SETTINGS });
  const [sujo, setSujo] = useState(false);

  useEffect(() => {
    if (saved) {
      const { organizationId: _o, updatedAt: _u, ...rest } = saved;
      setForm(rest);
      setSujo(false);
    }
  }, [saved]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSujo(true);
  };

  const chips = channels.filter((c) => c.channelType === 'whatsapp' && c.provider === 'evolution');

  const addRecipient = () => set('recipients', [...form.recipients, { name: '', phone: '' }]);
  const updRecipient = (i: number, patch: Partial<GestaoAlertRecipient>) =>
    set(
      'recipients',
      form.recipients.map((r, j) => (j === i ? { ...r, ...patch } : r))
    );
  const delRecipient = (i: number) => set('recipients', form.recipients.filter((_, j) => j !== i));

  const onSave = async () => {
    if (form.enabled && !form.channelId) return toast?.('Escolha o chip que envia os alertas.', 'error');
    if (form.enabled && form.recipients.filter((r) => r.phone.replace(/\D/g, '').length >= 10).length === 0)
      return toast?.('Informe ao menos um telefone com DDI+DDD (ex.: 5511999999999).', 'error');
    if (form.hoursEnd <= form.hoursStart) return toast?.('Horário comercial inválido.', 'error');
    try {
      await salvar.mutateAsync(form);
      setSujo(false);
      toast?.('Alertas salvos.', 'success');
    } catch (e) {
      toast?.((e as Error).message || 'Erro ao salvar.', 'error');
    }
  };

  const onTest = async () => {
    if (sujo) return toast?.('Salve as alterações antes de testar.', 'warning');
    try {
      const r = await testar.mutateAsync();
      toast?.(r.sent ? `Teste enviado para ${r.sent} número(s).` : `Nada enviado: ${r.detail || 'verifique chip e destinatários'}.`, r.sent ? 'success' : 'warning');
    } catch (e) {
      toast?.((e as Error).message || 'Erro ao enviar teste.', 'error');
    }
  };

  const inputCls =
    'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500';
  const numCls = 'w-20 px-2 py-1.5 bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg text-sm text-right';

  return (
    <div className="glass p-4 rounded-xl border border-slate-200 dark:border-white/5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Bell size={16} className="text-red-500" />
          Alertas no WhatsApp
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onTest()}
            disabled={testar.isPending || !saved?.channelId}
            title={!saved?.channelId ? 'Salve com um chip escolhido para testar' : 'Manda uma mensagem de teste para os destinatários salvos'}
            className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg glass border border-slate-200/50 dark:border-white/10 text-slate-600 dark:text-slate-300 disabled:opacity-50"
          >
            <Send size={13} /> {testar.isPending ? 'Enviando…' : 'Enviar teste'}
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={salvar.isPending || !sujo}
            className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 disabled:opacity-50"
          >
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-500 mb-3">
        A verificação roda a cada 10 min. Resumo de conversas paradas no máximo 1 por hora em horário comercial; erro de webhook quando passar do limite; meta em risco 1 vez por dia.
      </p>

      {isLoading ? (
        <p className="py-4 text-center text-xs text-slate-400">Carregando…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Coluna 1: liga/desliga + chip + destinatarios */}
          <div className="space-y-3">
            <Toggle on={form.enabled} onChange={(v) => set('enabled', v)} label="Alertas ligados" />
            <label className="block">
              <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Chip que envia (Evolution)</span>
              <select value={form.channelId || ''} onChange={(e) => set('channelId', e.target.value || null)} className={inputCls}>
                <option value="">Selecione</option>
                {chips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.externalIdentifier}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Quem recebe</span>
                <button type="button" onClick={addRecipient} className="flex items-center gap-1 text-xs text-primary-600 hover:underline">
                  <Plus size={12} /> adicionar
                </button>
              </div>
              <div className="space-y-1.5 mt-1">
                {form.recipients.length === 0 && <p className="text-xs text-slate-400">Nenhum destinatário.</p>}
                {form.recipients.map((r, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={r.name || ''}
                      onChange={(e) => updRecipient(i, { name: e.target.value })}
                      placeholder="Nome"
                      className={inputCls}
                    />
                    <input
                      type="tel"
                      value={r.phone}
                      onChange={(e) => updRecipient(i, { phone: e.target.value })}
                      placeholder="5511999999999"
                      className={inputCls}
                    />
                    <button type="button" onClick={() => delRecipient(i)} className="p-1.5 text-slate-400 hover:text-red-600" title="Remover">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Coluna 2: gatilhos e limites */}
          <div className="space-y-3">
            <Toggle
              on={form.alertWaiting}
              onChange={(v) => set('alertWaiting', v)}
              label="Conversa aguardando resposta"
              hint="resumo por canal, em horário comercial"
            />
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>parada há mais de</span>
              <input type="number" min={5} max={1440} value={form.slaMinutes} onChange={(e) => set('slaMinutes', Number(e.target.value))} className={numCls} />
              <span>min · ignora paradas há mais de</span>
              <input type="number" min={1} max={720} value={form.maxHours} onChange={(e) => set('maxHours', Number(e.target.value))} className={numCls} />
              <span>h</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>horário comercial</span>
              <input type="number" min={0} max={23} value={form.hoursStart} onChange={(e) => set('hoursStart', Number(e.target.value))} className={numCls} />
              <span>h às</span>
              <input type="number" min={1} max={24} value={form.hoursEnd} onChange={(e) => set('hoursEnd', Number(e.target.value))} className={numCls} />
              <span>h</span>
              <label className="flex items-center gap-1 ml-2">
                <input type="checkbox" checked={form.weekdaysOnly} onChange={(e) => set('weekdaysOnly', e.target.checked)} /> só dias úteis
              </label>
            </div>
            <Toggle on={form.alertWebhook} onChange={(v) => set('alertWebhook', v)} label="Erro de webhook" hint="Evolution / Zernio / captação" />
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>a partir de</span>
              <input
                type="number"
                min={1}
                max={100}
                value={form.webhookErrorThreshold}
                onChange={(e) => set('webhookErrorThreshold', Number(e.target.value))}
                className={numCls}
              />
              <span>erros em 10 min</span>
            </div>
            <Toggle on={form.alertGoals} onChange={(v) => set('alertGoals', v)} label="Meta em risco" hint="funil ou vendedor abaixo de 80% do ritmo esperado" />
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <span>1 vez por dia às</span>
              <input type="number" min={0} max={23} value={form.goalsHour} onChange={(e) => set('goalsHour', Number(e.target.value))} className={numCls} />
              <span>h · intervalo mínimo entre alertas</span>
              <input type="number" min={10} max={1440} value={form.cooldownMinutes} onChange={(e) => set('cooldownMinutes', Number(e.target.value))} className={numCls} />
              <span>min</span>
            </div>
          </div>

          {/* Coluna 3: ultimos envios */}
          <div>
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Últimos envios</span>
            <div className="mt-1 max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5">
              {log.length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">Nenhum alerta enviado ainda.</p>
              ) : (
                log.map((l) => (
                  <div key={l.id} className="py-1.5">
                    <div className="flex items-center gap-1.5 text-xs">
                      {l.sentOk ? <CheckCircle2 size={12} className="text-emerald-500" /> : <XCircle size={12} className="text-red-500" />}
                      <span className="font-medium text-slate-700 dark:text-slate-200">{TIPO_LABEL[l.alertType] || l.alertType}</span>
                      <span className="text-slate-400 ml-auto">{new Date(l.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    <p className="text-[11px] text-slate-500 truncate" title={l.message}>
                      {l.message.split('\n').slice(0, 2).join(' · ')}
                    </p>
                    {l.error && <p className="text-[11px] text-red-500 truncate" title={l.error}>{l.error}</p>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AlertSettingsSection;
