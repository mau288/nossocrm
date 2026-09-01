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

/**
 * Cada etapa pinta com a SUA cor (a mesma do topo da coluna no Kanban), então
 * mexer na cor da etapa no board reflete aqui. As classes do Tailwind viram hex
 * porque o gradiente é inline.
 */
const STAGE_HEX: Record<string, string> = {
  'bg-slate-500': '#64748b',
  'bg-gray-500': '#6b7280',
  'bg-red-500': '#ef4444',
  'bg-rose-500': '#f43f5e',
  'bg-orange-500': '#f97316',
  'bg-amber-500': '#f59e0b',
  'bg-yellow-500': '#eab308',
  'bg-lime-500': '#84cc16',
  'bg-green-500': '#22c55e',
  'bg-emerald-500': '#10b981',
  'bg-teal-500': '#14b8a6',
  'bg-cyan-500': '#06b6d4',
  'bg-sky-500': '#0ea5e9',
  'bg-blue-500': '#3b82f6',
  'bg-indigo-500': '#6366f1',
  'bg-violet-500': '#8b5cf6',
  'bg-purple-500': '#a855f7',
  'bg-fuchsia-500': '#d946ef',
  'bg-pink-500': '#ec4899',
};

/** Paleta da casa, usada quando a etapa não tem cor definida. */
const FALLBACK_HEX = ['#ffd700', '#f5af19', '#f7971e', '#eb7f2f', '#d68c0a', '#b26a00'];

function stageHex(color: string | undefined, index: number): string {
  if (color && STAGE_HEX[color]) return STAGE_HEX[color];
  if (color && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) return color;
  return FALLBACK_HEX[index % FALLBACK_HEX.length];
}

function shade(hex: string, percent: number): string {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const num = parseInt(full, 16);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = clamp(((num >> 16) & 255) * (1 + percent));
  const g = clamp(((num >> 8) & 255) * (1 + percent));
  const b = clamp((num & 255) * (1 + percent));
  return `rgb(${r} ${g} ${b})`;
}

/** Texto preto ou branco conforme o brilho da cor da etapa. */
function textOn(hex: string): string {
  const n = hex.replace('#', '');
  const full = n.length === 3 ? n.split('').map((c) => c + c).join('') : n;
  const num = parseInt(full, 16);
  const luminance =
    (0.299 * ((num >> 16) & 255) + 0.587 * ((num >> 8) & 255) + 0.114 * (num & 255)) / 255;
  return luminance > 0.62 ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.96)';
}

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
  /** Cor da etapa (hex), vinda do board. */
  hex: string;
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
      hex: stageHex(stage.color, i),
    };
  });
}

/** Uma fatia do funil, recortada em trapézio. */
const FunnelSlice: React.FC<{ slice: Slice }> = ({ slice }) => {
  // Cada etapa na sua própria cor, com leve profundidade no gradiente.
  const background = `linear-gradient(135deg, ${shade(slice.hex, 0.1)} 0%, ${slice.hex} 55%, ${shade(
    slice.hex,
    -0.18
  )} 100%)`;
  const color = textOn(slice.hex);

  const clip = `polygon(${(100 - slice.top) / 2}% 0%, ${(100 + slice.top) / 2}% 0%, ${
    (100 + slice.bottom) / 2
  }% 100%, ${(100 - slice.bottom) / 2}% 100%)`;

  return (
    <div className="relative" style={{ marginBottom: 2 }}>
      <div
        className="h-[58px] flex items-center justify-center shadow-sm"
        style={{ background, clipPath: clip }}
      >
        <div className="text-center leading-tight px-4" style={{ color }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">
            {slice.label}
          </div>
          <div className="text-lg font-black">
            {slice.count}
            {slice.value > 0 && (
              <span className="ml-1.5 text-[11px] font-semibold opacity-75">
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
                  {slices.map((s) => (
                    <FunnelSlice key={s.id} slice={s} />
                  ))}
                </div>
              ) : (
                <div>
                  {slices.map((s) => (
                    <FunnelSlice key={s.id} slice={s} />
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
