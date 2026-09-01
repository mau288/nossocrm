'use client';

/**
 * Visão gráfica dos funis: um mini-funil por board, com quantidade e valor por
 * etapa e a taxa de conversão entre elas.
 *
 * O filtro é por TAG DO NEGÓCIO (ex.: `produto:comunidade`,
 * `edicao:lancamento-pago`): escolhendo uma tag, todos os funis passam a
 * contar apenas os cards marcados com ela — é assim que se vê "só a
 * Comunidade" dentro de Formações ou "só o lançamento pago" em Eventos.
 */

import React, { useMemo, useState } from 'react';
import { Filter, TrendingDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBoards } from '@/lib/query/hooks/useBoardsQuery';
import { useDealsView } from '@/lib/query/hooks/useDealsQuery';
import type { DealView, Board } from '@/types';

/** Tags de controle que não servem como filtro de segmento. */
const HIDDEN_TAGS = new Set(['Novo', 'Conversa']);

const formatCurrency = (v: number) =>
  v >= 1000
    ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`
    : `R$ ${v.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}`;

interface StageBar {
  id: string;
  label: string;
  count: number;
  value: number;
  /** Conversão em relação à etapa anterior (null na primeira). */
  conversion: number | null;
}

function buildFunnel(board: Board, deals: DealView[]): StageBar[] {
  // board.stages já vem ordenado pelo boardsService.
  let previous: number | null = null;
  return board.stages.map((stage) => {
    const inStage = deals.filter((d) => d.status === stage.id);
    const count = inStage.length;
    const value = inStage.reduce((sum, d) => sum + (d.value || 0), 0);
    const conversion = previous && previous > 0 ? Math.round((count / previous) * 100) : null;
    previous = count;
    return { id: stage.id, label: stage.label, count, value, conversion };
  });
}

export const FunnelOverview: React.FC = () => {
  const { data: boards = [] } = useBoards();
  const { data: deals = [] } = useDealsView();
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Tags disponíveis = as que existem nos negócios (fora as de controle)
  const availableTags = useMemo(() => {
    const set = new Set<string>();
    for (const deal of deals) {
      for (const tag of deal.tags || []) {
        if (!HIDDEN_TAGS.has(tag)) set.add(tag);
      }
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
        stages: buildFunnel(
          board,
          filteredDeals.filter((d) => d.boardId === board.id)
        ),
      })),
    [boards, filteredDeals]
  );

  if (boards.length === 0) return null;

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 rounded-xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white font-display">
          Funis por etapa
        </h2>

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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {funnels.map(({ board, stages }) => {
          const topCount = Math.max(...stages.map((s) => s.count), 1);
          const total = stages.reduce((sum, s) => sum + s.count, 0);

          return (
            <div
              key={board.id}
              className="border border-slate-200 dark:border-white/10 rounded-lg p-3"
            >
              <div className="flex items-baseline justify-between mb-3">
                <h3 className="text-sm font-bold text-slate-900 dark:text-white truncate">
                  {board.name}
                </h3>
                <span className="text-xs text-slate-500 dark:text-slate-400 shrink-0 ml-2">
                  {total} {total === 1 ? 'negócio' : 'negócios'}
                </span>
              </div>

              {total === 0 ? (
                <p className="text-xs text-slate-400 py-4 text-center">
                  {activeTag ? 'Nenhum negócio com essa tag.' : 'Nenhum negócio ainda.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {stages.map((stage) => (
                    <div key={stage.id}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-slate-600 dark:text-slate-300 truncate pr-2">
                          {stage.label}
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          {stage.conversion !== null && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-0.5',
                                stage.conversion >= 50 ? 'text-emerald-500' : 'text-amber-500'
                              )}
                              title="Conversão em relação à etapa anterior"
                            >
                              <TrendingDown className="w-3 h-3" />
                              {stage.conversion}%
                            </span>
                          )}
                          <span className="font-bold text-slate-900 dark:text-white">
                            {stage.count}
                          </span>
                        </span>
                      </div>
                      <div className="h-6 bg-slate-100 dark:bg-white/5 rounded overflow-hidden relative">
                        <div
                          className="h-full bg-primary-500/70 transition-all"
                          style={{ width: `${Math.round((stage.count / topCount) * 100)}%` }}
                        />
                        {stage.value > 0 && (
                          <span className="absolute inset-y-0 right-2 flex items-center text-[10px] text-slate-500 dark:text-slate-400">
                            {formatCurrency(stage.value)}
                          </span>
                        )}
                      </div>
                    </div>
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
