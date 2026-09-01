'use client';

/**
 * "Puxar pro WhatsApp" — handoff do Instagram (ou de qualquer canal sem
 * telefone) para o WhatsApp, no momento em que o lead passa o número.
 *
 * Em um clique:
 *  1. grava o telefone no contato (ou oferece mesclar, se já existir alguém
 *     com aquele número — Instagram e WhatsApp viram a mesma pessoa);
 *  2. abre a conversa de WhatsApp no chip escolhido, já vinculada ao contato;
 *  3. DISPARA a primeira mensagem na hora (o lead recebe do número do chip);
 *  4. marca a tag de origem no contato.
 *
 * Só faz sentido depois que a pessoa deu o número — disparo para desconhecido
 * é caminho curto para o chip tomar bloqueio.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2, GitMerge, Send } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useConnectedChannelsQuery } from '@/lib/query/hooks/useChannelsQuery';
import { useUpdateContact } from '@/lib/query/hooks/useContactsQuery';
import { useMergeContactsMutation } from '@/lib/query/hooks/useDuplicateContactsQuery';
import { usePersistedState } from '@/hooks/usePersistedState';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/context/ToastContext';

interface PullToWhatsAppModalProps {
  isOpen: boolean;
  onClose: () => void;
  contactId: string;
  contactName: string;
  /** Tag de origem aplicada ao contato (ex.: origem:instagram). */
  originTag?: string;
  /** Chamado quando o handoff termina, com o id da conversa criada. */
  onDone?: (conversationId: string) => void;
}

const DEFAULT_TEMPLATE =
  'Oi {nome}, aqui é da Ark Academy 👋 vim do seu Direct no Instagram, vou te ajudar por aqui!';

/** Normaliza para +55DDDNNNNNNNN (formato que o espelho grava). */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 10) return null;
  return `+${digits.length <= 11 ? `55${digits}` : digits}`;
}

export const PullToWhatsAppModal: React.FC<PullToWhatsAppModalProps> = ({
  isOpen,
  onClose,
  contactId,
  contactName,
  originTag = 'origem:instagram',
  onDone,
}) => {
  const { data: channels = [] } = useConnectedChannelsQuery();
  const updateContact = useUpdateContact();
  const mergeContacts = useMergeContactsMutation();
  const { showToast } = useToast();

  const whatsappChannels = useMemo(
    () => channels.filter((c) => c.channelType === 'whatsapp'),
    [channels]
  );

  const [phone, setPhone] = useState('');
  const [channelId, setChannelId] = usePersistedState<string>('crm_handoff_channel', '');
  const [template, setTemplate] = usePersistedState<string>('crm_handoff_template', DEFAULT_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [match, setMatch] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPhone('');
    setMatch(null);
    if (!channelId && whatsappChannels[0]) setChannelId(whatsappChannels[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, whatsappChannels.length]);

  const firstName = (contactName || '').split(' ')[0] || 'tudo bem';
  const message = template.replace(/\{nome\}/g, firstName);
  const canSubmit = Boolean(normalizePhone(phone) && channelId && message.trim()) && !busy;

  /** Se o número já pertence a outro contato, pergunta antes de seguir. */
  const findExisting = async (normalized: string) => {
    const { data } = await supabase
      .from('contacts')
      .select('id, name')
      .eq('phone', normalized)
      .neq('id', contactId)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    return (data as { id: string; name: string } | null) ?? null;
  };

  /** Grava telefone + tag, abre a conversa no chip e dispara a mensagem. */
  const runHandoff = async (targetContactId: string, normalized: string) => {
    // 1. telefone + tag de origem no contato
    const { data: current } = await supabase
      .from('contacts')
      .select('tags')
      .eq('id', targetContactId)
      .maybeSingle();
    const tags: string[] = Array.isArray(current?.tags) ? (current!.tags as string[]) : [];
    if (originTag && !tags.includes(originTag)) tags.push(originTag);

    await updateContact.mutateAsync({
      id: targetContactId,
      updates: { phone: normalized, tags },
    });

    // 2. conversa de WhatsApp no chip escolhido (o endpoint reaproveita se já existir)
    const convRes = await fetch('/api/messaging/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId,
        externalContactId: normalized,
        externalContactName: contactName,
        contactId: targetContactId,
      }),
    });
    const convBody = await convRes.json().catch(() => ({}));
    // 409 = já existe conversa com esse número neste chip; o id vem no corpo.
    const conversationId: string | undefined =
      convBody.conversation?.id ?? convBody.conversationId ?? convBody.id;

    if (!conversationId) {
      throw new Error(convBody.error || 'Não consegui abrir a conversa de WhatsApp.');
    }

    // 3. dispara a primeira mensagem agora
    const msgRes = await fetch('/api/messaging/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        content: { type: 'text', text: message },
      }),
    });
    if (!msgRes.ok) {
      const err = await msgRes.json().catch(() => ({}));
      throw new Error(err.message || 'Contato salvo, mas a mensagem não saiu.');
    }

    return conversationId;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizePhone(phone);
    if (!normalized) {
      showToast('Número inválido — use DDD + número.', 'error');
      return;
    }

    setBusy(true);
    try {
      const existing = await findExisting(normalized);
      if (existing) {
        setMatch(existing);
        return; // pede confirmação de mesclagem antes de seguir
      }
      const conversationId = await runHandoff(contactId, normalized);
      showToast('Mensagem enviada no WhatsApp!', 'success');
      onDone?.(conversationId);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Falha no handoff.', 'error');
    } finally {
      setBusy(false);
    }
  };

  /** Mescla os dois cadastros e segue com o handoff no contato resultante. */
  const handleMergeAndSend = async () => {
    const normalized = normalizePhone(phone);
    if (!match || !normalized) return;
    setBusy(true);
    try {
      await mergeContacts.mutateAsync({ sourceId: contactId, targetId: match.id });
      const conversationId = await runHandoff(match.id, normalized);
      showToast(`Contatos unidos e mensagem enviada para ${match.name}.`, 'success');
      onDone?.(conversationId);
      onClose();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Falha ao mesclar.', 'error');
    } finally {
      setBusy(false);
      setMatch(null);
    }
  };

  const inputClass =
    'w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all';
  const labelClass = 'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Puxar pro WhatsApp" size="sm">
      {match ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-400/40 bg-amber-500/10 p-3 text-sm text-slate-700 dark:text-slate-200">
            Esse número já é de <span className="font-semibold">{match.name}</span>. Unir com{' '}
            <span className="font-semibold">{contactName}</span> e enviar a mensagem? As conversas,
            tags e negócios dos dois viram um contato só.
          </div>
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={() => setMatch(null)}
              className="px-4 py-2 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5"
            >
              Voltar
            </button>
            <button
              type="button"
              onClick={handleMergeAndSend}
              disabled={busy}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitMerge className="w-4 h-4" />}
              Unir e enviar
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Use quando <span className="font-semibold">{contactName}</span> passar o número: o CRM
            salva o telefone, abre a conversa no chip e já manda a primeira mensagem.
          </p>

          <div>
            <label className={labelClass} htmlFor="handoff-phone">Telefone que a pessoa passou</label>
            <input
              id="handoff-phone"
              className={inputClass}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="DDD + número (ex: 11 91234-5678)"
              inputMode="tel"
              autoFocus
            />
          </div>

          <div>
            <label className={labelClass} htmlFor="handoff-channel">Enviar pelo chip</label>
            <select
              id="handoff-channel"
              className={inputClass}
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
            >
              {whatsappChannels.length === 0 && <option value="">Nenhum chip conectado</option>}
              {whatsappChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={labelClass} htmlFor="handoff-message">
              Primeira mensagem — <code className="text-[11px]">{'{nome}'}</code> vira o primeiro nome
            </label>
            <textarea
              id="handoff-message"
              className={inputClass}
              rows={3}
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
            />
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
              Vai sair assim: <span className="italic">{message}</span>
            </p>
          </div>

          <div className="flex gap-3 justify-end pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Enviar e vincular
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
};

export default PullToWhatsAppModal;
