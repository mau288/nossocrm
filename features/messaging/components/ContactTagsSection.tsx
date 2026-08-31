'use client';

/**
 * Tags do lead, editáveis direto na conversa.
 *
 * As tags têm nome livre, ACUMULAM no contato (rastro dos funis/processos que
 * o lead percorreu) e valem em qualquer canal/conversa da mesma pessoa.
 * Sugestões vêm do catálogo compartilhado `crm_tags` (o mesmo das tags de
 * negócio); digitar um nome novo cria a tag na hora.
 */

import React, { useMemo, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useContact, useUpdateContact } from '@/lib/query/hooks/useContactsQuery';
import { usePersistedState } from '@/hooks/usePersistedState';

interface ContactTagsSectionProps {
  contactId: string;
}

const TAG_COLORS = [
  'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30',
  'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  'bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400 border-fuchsia-500/30',
  'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30',
  'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
];

const colorFor = (tag: string) => {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
};

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ');

export const ContactTagsSection: React.FC<ContactTagsSectionProps> = ({ contactId }) => {
  const { data: contact } = useContact(contactId);
  const updateContact = useUpdateContact();
  const [catalog, setCatalog] = usePersistedState<string[]>('crm_tags', []);
  const [query, setQuery] = useState('');

  const tags = contact?.tags ?? [];

  const suggestions = useMemo(() => {
    const q = normalize(query).toLowerCase();
    if (!q) return [];
    return catalog
      .filter((t) => t.toLowerCase().includes(q) && !tags.includes(t))
      .slice(0, 5);
  }, [query, catalog, tags]);

  const queryNorm = normalize(query);
  const isNewTag =
    queryNorm.length > 0 &&
    !catalog.some((t) => t.toLowerCase() === queryNorm.toLowerCase()) &&
    !tags.some((t) => t.toLowerCase() === queryNorm.toLowerCase());

  const applyTag = (raw: string) => {
    const tag = normalize(raw);
    if (!tag || tags.includes(tag)) {
      setQuery('');
      return;
    }
    updateContact.mutate({ id: contactId, updates: { tags: [...tags, tag] } });
    if (!catalog.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setCatalog([...catalog, tag]);
    }
    setQuery('');
  };

  const removeTag = (tag: string) => {
    updateContact.mutate({
      id: contactId,
      updates: { tags: tags.filter((t) => t !== tag) },
    });
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {tags.length === 0 && (
          <span className="px-2 py-0.5 text-xs bg-slate-100 dark:bg-white/10 text-slate-500 dark:text-slate-400 rounded-full">
            Nenhuma tag
          </span>
        )}
        {tags.map((tag) => (
          <span
            key={tag}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border',
              colorFor(tag)
            )}
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              className="opacity-60 hover:opacity-100 transition-opacity"
              aria-label={`Remover tag ${tag}`}
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>

      <div className="relative mt-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              applyTag(suggestions[0] && !isNewTag ? suggestions[0] : query);
            }
          }}
          placeholder="Adicionar tag…"
          className="w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-slate-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all"
        />
        {(suggestions.length > 0 || isNewTag) && (
          <div className="absolute z-20 mt-1 w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg shadow-lg overflow-hidden">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => applyTag(s)}
                className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/5"
              >
                {s}
              </button>
            ))}
            {isNewTag && (
              <button
                type="button"
                onClick={() => applyTag(queryNorm)}
                className="w-full text-left px-2.5 py-1.5 text-xs font-medium text-primary-600 dark:text-primary-400 hover:bg-slate-100 dark:hover:bg-white/5 inline-flex items-center gap-1"
              >
                <Plus className="w-3 h-3" />
                Criar tag &quot;{queryNorm}&quot;
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ContactTagsSection;
