'use client';

/**
 * Gaveta de figurinhas (ARK).
 *
 * O WhatsApp nao entrega a colecao de figurinhas da conta por API. A gaveta mostra as
 * figurinhas que ja passaram pelas conversas do CRM (recebidas ou enviadas), sem repetir.
 */
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { sanitizeUrl } from '@/lib/utils/sanitize';

interface StickerTrayProps {
  onPick: (mediaUrl: string) => void;
}

export function StickerTray({ onPick }: StickerTrayProps) {
  const { data: stickers = [], isLoading } = useQuery({
    queryKey: ['messagingStickers', 'recent'],
    queryFn: async (): Promise<string[]> => {
      const { data, error } = await supabase
        .from('messaging_messages')
        .select('content, created_at')
        .eq('content_type', 'sticker')
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      const seen = new Set<string>();
      for (const row of data ?? []) {
        const url = sanitizeUrl(String((row.content as { mediaUrl?: string } | null)?.mediaUrl ?? ''));
        if (url) seen.add(url);
        if (seen.size >= 48) break;
      }
      return Array.from(seen);
    },
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="w-[320px] max-h-[320px] overflow-y-auto rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 shadow-xl p-3">
      <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-2">Figurinhas das conversas</p>
      {isLoading ? (
        <div className="grid grid-cols-4 gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="w-16 h-16 rounded-lg bg-slate-100 dark:bg-white/5 animate-pulse" />
          ))}
        </div>
      ) : stickers.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Nenhuma figurinha ainda. As que chegarem nas conversas aparecem aqui. Para enviar uma imagem
          sua como figurinha, anexe ou cole a imagem e marque &quot;Enviar como figurinha&quot;.
        </p>
      ) : (
        <div className="grid grid-cols-4 gap-2">
          {stickers.map((url) => (
            <button
              key={url}
              type="button"
              onClick={() => onPick(url)}
              className="w-16 h-16 rounded-lg hover:bg-slate-100 dark:hover:bg-white/10 flex items-center justify-center transition-colors"
              title="Enviar figurinha"
              aria-label="Enviar figurinha"
            >
              <img src={url} alt="Figurinha" className="max-w-full max-h-full" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
