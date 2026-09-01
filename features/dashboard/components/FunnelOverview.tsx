'use client';

/**
 * Funis em formato de pirâmide — a visão de vendas dos boards.
 *
 * Cada board vira um funil: fatias trapezoidais que estreitam etapa a etapa,
 * com quantidade, valor e a conversão em relação à etapa anterior. O filtro é
 * por TAG DO NEGÓCIO (ex.: `produto:comunidade`, `edicao:lancamento-pago`):
 * escolhendo uma tag, os funis passam a contar só os cards marcados com ela.
 */

import React, { useMemo, useState } from 'react';
import { Filter, X, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBoards } from '@/lib/query/hooks/useBoardsQuery';
import { useDealsView } from '@/lib/query/hooks/useDealsQuery';
import type { DealView, Board } from '@/types';

/** Tags de controle: não servem como recorte de segmento. */
const HIDDEN_TAGS = new Set(['Novo', 'Conversa']);

/** Larguras da pirâmide (%): topo largo, base estreita. */
const WIDTH_TOP = 100;
const WIDTH_BOTTOM = 42;

const formatCurrency = (v: number) =>
  v >= 1000
    ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`
    : `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;

interface Slice {
  id: string;
  label: string;
  count: number;
  value: number;
  /** Conversão vs. etapa anterior (null na primeira). */
  conversion: number | null;
  /** Largura do topo e da base desta fatia, em %. */
  top: number;
  bottom: number;
}

function buildFunnel(board: Board, deals: DealView[]): Slice[] {
  const stages = board.stages; // já vem ordenado pelo boardsService
  const n = Math.max(stages.length, 1);
  const step = (WIDTH_TOP - WIDTH_BOTTOM) / n;

  let previous: number | null = null;
  return stages.map((stage, i) => {
    const inStage = deals.filter((d) => d.status === stage.id);
    const count = inStage.length;
    const value = inStage.reduce((sum, d) => sum + (d.value || 0), 0);
    const conversion = previous !== null && previous > 0 ? Math.round((count / previous) * 100) : null;
    previous = count;
    return {
      id: stage.id,
      label: stage.label,
      count,
      value,
      conversion,
      top: WIDTH_TOP - step * i,
      bottom: WIDTH_TOP - step * (i + 1),
    };
  });
}

/** Uma fatia do funil, recortada em trapézio. */
const FunnelSlice: React.FC<{ slice: Slice; index: number; total: number }> = ({
  slice,
  index,
  total,
}) => {
  // Do dourado da marca (topo) ao âmbar profundo (base): sensação de "afunilar".
  const intensity = index / Math.max(total - 1, 1);
  const background = `linear-gradient(135deg,
    rgba(255, 215, 0, ${0.95 - intensity * 0.35}) 0%,
    rgba(245, 175, 25, ${0.9 - intensity * 0.3}) 60%,
    rgba(214, 140, 10, ${0.85 - intensity * 0.25}) 100%)`;

  const clip = `polygon(${(100 - slice.top) / 2}% 0%, ${(100 + slice.top) / 2}% 0%, ${
    (100 + slice.bottom) / 2
  }% 100%, ${(100 - slice.bottom) / 2}% 100%)`;

  return (
    <div className="relative" style={{ marginBottom: 2 }}>
      <div
        className="h-[58px] flex items-center justify-center shadow-sm"
        style={{ background, clipPath: clip }}
      >
        <div className="text-center leading-tight px-4">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-900/70">
            {slice.label}
          </div>
          <div className="text-lg font-black text-slate-900">
            {slice.count}
            {slice.value > 0 && (
              <span className="ml-1.5 text-[11px] font-semibold text-slate-900/60">
                {formatCurrency(slice.value)}
              </span>
            )}
          </div>
        </div>
      </div>

      {slice.conversion !== null && (
        <span
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 inline-flex items-center gap-0.5',
            'text-[10px] font-bold px-1.5 py-0.5 rounded-full',
            slice.conversion >= 50
              ? 'bg-emerald-500/15 text-emerald-500'
              : 'bg-rose-500/15 text-rose-400'
          )}
          title="Conversão em relação à etapa anterior"
        >
          <ArrowDown className="w-3 h-3" />
          {slice.conversion}%
        </span>
      )}
    </div>
  );
};

export const FunnelOverview: React.FC = () => {
  const { data: boards = [] } = useBoards();
  const { data: deals = [] } = useDealsView();
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const deal of deals) {
      for (const tag of deal.tags || []) if (!HIDDEN_TAGS.has(tag)) set.add(tag);
    }
    return [...set].sort();
  }, [deals]);

  const filteredDeals = useMemo(() => {
    const open = deals.filter((d) => !d.isLost);
    if (!activeTag) return open;
    return open.filter((d) => (d.tags || []).includes(activeTag));
  }, [deals, activeTag]);

  const funnels = useMemo(
    () =>
      boards.map((board) => ({
        board,
        slices: buildFunnel(board, filteredDeals.filter((d) => d.boardId === board.id)),
      })),
    [boards, filteredDeals]
  );

  if (boards.length === 0) return null;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 rounded-xl p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-slate-900 dark:text-white font-display">
            Funis de venda
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Volume por etapa e conversão entre elas
            {activeTag && (
              <>
                {' · filtrando '}
                <span className="font-semibold text-primary-500">{activeTag}</span>
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-400" />
          <select
            value={activeTag ?? ''}
            onChange={(e) => setActiveTag(e.target.value || null)}
            aria-label="Filtrar funis por tag"
            className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg text-sm text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">Todas as tags</option>
            {availableTags.map((tag) => (
              <option key={tag} value={tag}>
                {tag}
              </option>
            ))}
          </select>
          {activeTag && (
            <button
              type="button"
              onClick={() => setActiveTag(null)}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
              aria-label="Limpar filtro"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {funnels.map(({ board, slices }) => {
          const entrada = slices[0]?.count ?? 0;
          const fim = slices.length > 1 ? slices[slices.length - 2].count : 0;
          const total = slices.reduce((sum, s) => sum + s.count, 0);
          const valorTotal = slices.reduce((sum, s) => sum + s.value, 0);
          const taxaGeral = entrada > 0 ? Math.round((fim / entrada) * 100) : null;

          return (
            <div
              key={board.id}
              className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-white/[0.02] p-4"
            >
              <div className="flex items-baseline justify-between mb-1">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                  {board.name}
                </h3>
                {taxaGeral !== null && total > 0 && (
                  <span className="text-[11px] font-semibold text-primary-500 shrink-0 ml-2">
                    {taxaGeral}% ponta a ponta
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400 mb-3">
                {total} {total === 1 ? 'negócio' : 'negócios'}
                {valorTotal > 0 && ` · ${formatCurrency(valorTotal)}`}
              </p>

              {total === 0 ? (
                <div className="opacity-30">
                  {slices.map((s, i) => (
                    <FunnelSlice key={s.id} slice={s} index={i} total={slices.length} />
                  ))}
                </div>
              ) : (
                <div>
                  {slices.map((s, i) => (
                    <FunnelSlice key={s.id} slice={s} index={i} total={slices.length} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default FunnelOverview;
