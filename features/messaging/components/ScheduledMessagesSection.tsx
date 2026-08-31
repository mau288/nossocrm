'use client';

/**
 * Mensagens programadas (follow-up) da conversa.
 *
 * O operador escreve o texto e escolhe dia/horário; o envio real acontece pelo
 * pg_cron + edge function `scheduled-messages-dispatch`, saindo pelo canal da
 * conversa (Evolution/Zernio). A mensagem enviada aparece na conversa pelo
 * espelho do canal. Pendentes podem ser canceladas até o horário do envio.
 */

import React, { useState } from 'react';
import { CalendarClock, Plus, X, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import {
  useScheduledMessages,
  useCreateScheduledMessage,
  useCancelScheduledMessage,
} from '@/lib/query/hooks/useScheduledMessagesQuery';

interface ScheduledMessagesSectionProps {
  conversationId: string;
  channelId: string;
  contactId?: string | null;
}

const STATUS_META: Record<string, { label: string; icon: React.FC<{ className?: string }>; cls: string }> = {
  pending: { label: 'Agendada', icon: Clock, cls: 'text-amber-500' },
  sent: { label: 'Enviada', icon: CheckCircle2, cls: 'text-emerald-500' },
  failed: { label: 'Falhou', icon: AlertCircle, cls: 'text-red-500' },
  cancelled: { label: 'Cancelada', icon: X, cls: 'text-slate-400' },
};

export const ScheduledMessagesSection: React.FC<ScheduledMessagesSectionProps> = ({
  conversationId,
  channelId,
  contactId,
}) => {
  const { profile, organizationId } = useAuth();
  const { showToast } = useToast();
  const { data: scheduled = [] } = useScheduledMessages(conversationId);
  const createScheduled = useCreateScheduledMessage();
  const cancelScheduled = useCancelScheduledMessage();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [content, setContent] = useState('');
  const [when, setWhen] = useState('');

  const pending = scheduled.filter((s) => s.status === 'pending');
  const history = scheduled.filter((s) => s.status !== 'pending').slice(-3);

  const canSubmit =
    content.trim().length > 0 &&
    when.length > 0 &&
    new Date(when).getTime() > Date.now() &&
    !createScheduled.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit || !organizationId) return;

    createScheduled.mutate(
      {
        organizationId,
        conversationId,
        channelId,
        contactId: contactId ?? null,
        content: content.trim(),
        scheduledAt: new Date(when).toISOString(),
        createdBy: profile?.id ?? null,
      },
      {
        onSuccess: () => {
          showToast('Mensagem programada!', 'success');
          setContent('');
          setWhen('');
          setIsFormOpen(false);
        },
        onError: (err) => {
          showToast(err instanceof Error ? err.message : 'Falha ao programar.', 'error');
        },
      }
    );
  };

  const inputClass =
    'w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all';

  return (
    <div className="space-y-2">
      {scheduled.length === 0 && !isFormOpen && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Nenhum follow-up programado.
        </p>
      )}

      {[...pending, ...history].map((s) => {
        const meta = STATUS_META[s.status] ?? STATUS_META.pending;
        const Icon = meta.icon;
        return (
          <div
            key={s.id}
            className="rounded-lg border border-slate-200 dark:border-white/10 p-2 text-xs space-y-1"
          >
            <div className="flex items-center justify-between gap-2">
              <span className={cn('inline-flex items-center gap-1 font-medium', meta.cls)}>
                <Icon className="w-3.5 h-3.5" />
                {meta.label}
              </span>
              {s.status === 'pending' && (
                <button
                  type="button"
                  onClick={() =>
                    cancelScheduled.mutate(
                      { id: s.id, conversationId },
                      { onSuccess: () => showToast('Programação cancelada.', 'success') }
                    )
                  }
                  className="text-slate-400 hover:text-red-500 transition-colors"
                  aria-label="Cancelar mensagem programada"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <p className="text-slate-700 dark:text-slate-200 whitespace-pre-wrap break-words">
              {s.content}
            </p>
            <p className="text-slate-500 dark:text-slate-400 inline-flex items-center gap-1">
              <CalendarClock className="w-3 h-3" />
              {format(new Date(s.scheduledAt), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
            </p>
            {s.status === 'failed' && s.error && (
              <p className="text-red-500">{s.error}</p>
            )}
          </div>
        );
      })}

      {isFormOpen ? (
        <form onSubmit={handleSubmit} className="space-y-2">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Texto do follow-up…"
            rows={3}
            className={inputClass}
          />
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className={inputClass}
          />
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={() => setIsFormOpen(false)}
              className="px-2.5 py-1.5 rounded-lg text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {createScheduled.isPending ? 'Salvando…' : 'Programar'}
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setIsFormOpen(true)}
          className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Programar mensagem
        </button>
      )}
    </div>
  );
};

export default ScheduledMessagesSection;
