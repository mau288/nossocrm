'use client';

/**
 * @fileoverview Histórico de metas dos funis, no fim da Visão Geral (ARK #53).
 *
 * Cada linha é uma meta que já foi trocada: funil, período, alvo e o resultado final.
 * A meta em andamento de cada funil aparece em cima, para a leitura ficar completa.
 * Pedido do Mauricio em 29/10/2026: deixar o histórico aqui para virar gráfico depois.
 */

import React from 'react';
import { Target, History } from 'lucide-react';
import { useBoardGoalHistory } from '@/lib/query/hooks/useBoardGoalHistoryQuery';
import { useBoards } from '@/lib/query/hooks/useBoardsQuery';
import { useDeals } from '@/lib/query/hooks/useDealsQuery';
import { calcularProgressoMeta, alvoNumerico, percentualDaMeta, formatPeriodo } from '@/lib/boards/goal-progress';

const dataBR = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('pt-BR') : '—');

interface Linha {
  key: string;
  funil: string;
  meta: string;
  periodo: string;
  alvo: string;
  resultado: string;
  pct: number;
  status: 'andamento' | 'batida' | 'nao-batida';
  encerradaEm?: string;
}

const Barra: React.FC<{ pct: number; status: Linha['status'] }> = ({ pct, status }) => {
  const cor = status === 'batida' ? 'bg-green-500' : status === 'andamento' ? 'bg-blue-500' : 'bg-amber-500';
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="relative h-1.5 flex-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
        <div className={`absolute left-0 top-0 h-full rounded-full ${cor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-slate-600 dark:text-slate-300 w-10 text-right">{Math.round(pct)}%</span>
    </div>
  );
};

export const MetasHistoricoSection: React.FC = () => {
  const { data: history = [] } = useBoardGoalHistory();
  const { data: boards = [] } = useBoards();
  const { data: deals = [] } = useDeals();

  const atuais: Linha[] = boards
    .filter(b => b.goal && (b.goal.kpi || b.goal.targetValue))
    .map(b => {
      const p = calcularProgressoMeta(b.goal, deals, b.id);
      const pct = percentualDaMeta(p.value, alvoNumerico(b.goal));
      return {
        key: `atual-${b.id}`,
        funil: b.name,
        meta: b.goal!.kpi || 'Meta',
        periodo: formatPeriodo(b.goal) ?? 'sem período',
        alvo: b.goal!.targetValue,
        resultado: p.display,
        pct,
        status: 'andamento',
      };
    });

  const anteriores: Linha[] = history.map(h => {
    const pct = percentualDaMeta(h.achievedValue, parseFloat((h.targetValue || '0').replace(/[^0-9.]/g, '')) || 0);
    return {
      key: h.id,
      funil: h.boardName,
      meta: h.kpi || 'Meta',
      periodo: formatPeriodo(h) ?? 'sem período',
      alvo: h.targetValue,
      resultado: h.achievedDisplay,
      pct,
      status: pct >= 100 ? 'batida' : 'nao-batida',
      encerradaEm: h.archivedAt,
    };
  });

  const linhas = [...atuais, ...anteriores];
  if (linhas.length === 0) return null;

  return (
    <div className="shrink-0">
      <h2 className="text-sm font-bold text-slate-400 uppercase mb-3 flex items-center gap-2">
        <History size={14} /> Histórico de metas
      </h2>
      <section className="rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-white/5 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-white/5 text-[10px] uppercase tracking-wider text-slate-400">
            <tr>
              <th className="text-left px-4 py-2 font-bold">Funil</th>
              <th className="text-left px-4 py-2 font-bold">Meta</th>
              <th className="text-left px-4 py-2 font-bold">Período</th>
              <th className="text-right px-4 py-2 font-bold">Alvo</th>
              <th className="text-right px-4 py-2 font-bold">Resultado</th>
              <th className="text-left px-4 py-2 font-bold">Atingido</th>
              <th className="text-left px-4 py-2 font-bold">Situação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-white/5">
            {linhas.map(l => (
              <tr key={l.key} className="text-slate-700 dark:text-slate-200">
                <td className="px-4 py-2 font-medium">{l.funil}</td>
                <td className="px-4 py-2">
                  <span className="inline-flex items-center gap-1.5">
                    <Target size={12} className={l.status === 'andamento' ? 'text-blue-500' : 'text-slate-400'} />
                    {l.meta}
                  </span>
                </td>
                <td className="px-4 py-2 text-slate-500">{l.periodo}</td>
                <td className="px-4 py-2 text-right font-mono">{l.alvo}</td>
                <td className="px-4 py-2 text-right font-mono font-bold">{l.resultado}</td>
                <td className="px-4 py-2"><Barra pct={l.pct} status={l.status} /></td>
                <td className="px-4 py-2 text-xs">
                  {l.status === 'andamento' && <span className="text-blue-600 dark:text-blue-400 font-medium">Em andamento</span>}
                  {l.status === 'batida' && <span className="text-green-600 dark:text-green-400 font-medium">Batida · {dataBR(l.encerradaEm)}</span>}
                  {l.status === 'nao-batida' && <span className="text-amber-600 dark:text-amber-400 font-medium">Encerrada · {dataBR(l.encerradaEm)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
};

export default MetasHistoricoSection;
