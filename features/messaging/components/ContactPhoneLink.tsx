'use client';

/**
 * "Associar telefone" — para conversas cujo contato ainda não tem telefone
 * (típico de leads do Instagram que passam o número durante o papo).
 *
 * Ao informar o número:
 *  - se JÁ existe outro contato com esse telefone (ex.: a mesma pessoa no
 *    WhatsApp), oferece MESCLAR: o contato da conversa é fundido no contato
 *    do telefone (o RPC merge_contacts remapeia conversas, negócios,
 *    atividades etc.) — uma pessoa só, dois canais;
 *  - se não existe, apenas grava o telefone no contato atual. A partir daí,
 *    quando essa pessoa chamar no WhatsApp, o espelho encontra o contato pelo
 *    telefone e conecta no mesmo cadastro.
 */

import React, { useState } from 'react';
import { PhoneForwarded, GitMerge, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useUpdateContact } from '@/lib/query/hooks/useContactsQuery';
import { useMergeContactsMutation } from '@/lib/query/hooks/useDuplicateContactsQuery';
import { useToast } from '@/context/ToastContext';

interface ContactPhoneLinkProps {
  contactId: string;
  contactName: string;
}

/** Normaliza para o formato armazenado pelo espelho: +<DDI><numero>. */
function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 10) return null;
  // 10-11 dígitos = número BR sem DDI
  const withDdi = digits.length <= 11 ? `55${digits}` : digits;
  return `+${withDdi}`;
}

export const ContactPhoneLink: React.FC<ContactPhoneLinkProps> = ({ contactId, contactName }) => {
  const updateContact = useUpdateContact();
  const mergeContacts = useMergeContactsMutation();
  const { showToast } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [isChecking, setIsChecking] = useState(false);
  const [match, setMatch] = useState<{ id: string; name: string; phone: string } | null>(null);

  const reset = () => {
    setIsOpen(false);
    setPhone('');
    setMatch(null);
  };

  const handleCheck = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = normalizePhone(phone);
    if (!normalized) {
      showToast('Número inválido — use DDD + número.', 'error');
      return;
    }

    setIsChecking(true);
    try {
      const { data, error } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .eq('phone', normalized)
        .neq('id', contactId)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        // Mesma pessoa já existe pelo telefone → oferecer mesclagem
        setMatch(data as { id: string; name: string; phone: string });
      } else {
        updateContact.mutate(
          { id: contactId, updates: { phone: normalized } },
          {
            onSuccess: () => {
              showToast('Telefone associado ao contato!', 'success');
              reset();
            },
            onError: (err) =>
              showToast(err instanceof Error ? err.message : 'Falha ao salvar telefone.', 'error'),
          }
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Falha ao verificar o número.', 'error');
    } finally {
      setIsChecking(false);
    }
  };

  const handleMerge = () => {
    if (!match) return;
    mergeContacts.mutate(
      { sourceId: contactId, targetId: match.id },
      {
        onSuccess: () => {
          showToast(`Contatos mesclados: agora é tudo ${match.name}.`, 'success');
          reset();
        },
        onError: (err) =>
          showToast(err instanceof Error ? err.message : 'Falha ao mesclar contatos.', 'error'),
      }
    );
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="w-full mt-1 inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10 transition-colors"
      >
        <PhoneForwarded className="w-3.5 h-3.5" />
        Associar telefone
      </button>
    );
  }

  if (match) {
    return (
      <div className="mt-1 rounded-lg border border-amber-400/40 bg-amber-500/10 p-2.5 text-xs space-y-2">
        <p className="text-slate-700 dark:text-slate-200">
          Já existe <span className="font-semibold">{match.name}</span> com esse número.
          Mesclar com <span className="font-semibold">{contactName}</span>? As conversas,
          tags e negócios dos dois viram um contato só.
        </p>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={reset}
            className="px-2.5 py-1.5 rounded-lg text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleMerge}
            disabled={mergeContacts.isPending}
            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 transition-colors inline-flex items-center gap-1"
          >
            {mergeContacts.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <GitMerge className="w-3.5 h-3.5" />
            )}
            Mesclar
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleCheck} className="mt-1 space-y-2">
      <input
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder="DDD + número (ex: 11 91234-5678)"
        inputMode="tel"
        autoFocus
        className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all"
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={reset}
          className="px-2.5 py-1.5 rounded-lg text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
        >
          Cancelar
        </button>
        <button
          type="submit"
          disabled={isChecking || updateContact.isPending}
          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 transition-colors"
        >
          {isChecking ? 'Verificando…' : 'Associar'}
        </button>
      </div>
    </form>
  );
};

export default ContactPhoneLink;
