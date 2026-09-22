'use client';

/**
 * @fileoverview As duas leituras do dinheiro, lado a lado mas separadas.
 *
 * O Mauricio pediu em 22/09/2026 "as duas visões mas separadas, não grudadas":
 * - REALIZADO: o que já foi ganho no período. É dinheiro que entrou.
 * - PREVISÃO: o que está em aberto no pipeline. É dinheiro que talvez entre.
 *
 * Somar os dois daria um número que não existe, por isso eles nunca aparecem no mesmo card.
 * Em cada bloco: faturamento cheio, quanto sobra depois da taxa do gateway e quanto sobra
 * depois da taxa e do imposto.
 */

import React from 'react';
import { TrendingUp, Hourglass } from 'lucide-react';
import { useActiveGateways, useDefaultTaxPct } from '@/lib/query/hooks';
import { calcularResultado } from '@/lib/financeiro/calculo';
import type { Deal } from '@/types';

const moeda = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface BlocoProps {
  titulo: string;
  explicacao: string;
  icone: React.ElementType;
  deals: Deal[];
  gateways: ReturnType<typeof useActiveGateways>['data'];
  defaultTaxPct: number;
  destaque: 'realizado' | 'previsao';
}

const Bloco: React.FC<BlocoProps> = ({ titulo, explicacao, icone: Icone, deals, gateways, defaultTaxPct, destaque }) => {
  const r = calcularResultado(deals, gateways || [], defaultTaxPct);

  const cor = destaque === 'realizado'
    ? 'text-green-600 dark:text-green-400'
    : 'text-blue-600 dark:text-blue-400';
  const borda = destaque === 'realizado'
    ? 'border-green-200 dark:border-green-900/40'
    : 'border-blue-200 dark:border-blue-900/40';

  return (
    <section className={`rounded-xl border ${borda} bg-white dark:bg-white/5 p-5`}>
      <header className="mb-4">
        <h3 className={`font-bold flex items-center gap-2 ${cor}`}>
          <Icone size={16} /> {titulo}
        </h3>
        <p className="text-xs text-slate-500 mt-1">{explicacao}</p>
      </header>

      <dl className="space-y-2">
        <div className="flex justify-between items-baseline">
          <dt className="text-sm text-slate-500">Faturamento</dt>
          <dd className="text-lg font-bold font-mono text-slate-900 dark:text-white">{moeda(r.bruto)}</dd>
        </div>
        <div className="flex justify-between items-baseline">
          <dt className="text-sm text-slate-500">Após taxas</dt>
          <dd className="text-base font-mono text-slate-700 dark:text-slate-200">{moeda(r.aposTaxas)}</dd>
        </div>
        <div className="flex justify-between items-baseline pt-2 border-t border-slate-100 dark:border-white/10">
          <dt className="text-sm font-bold text-slate-700 dark:text-slate-200">Após taxas + imposto</dt>
          <dd className={`text-lg font-bold font-mono ${cor}`}>{moeda(r.aposTaxasEImposto)}</dd>
        </div>
      </dl>

      <p className="text-[11px] text-slate-400 mt-3">
        {deals.length} {deals.length === 1 ? 'negócio' : 'negócios'} · taxa {moeda(r.taxaTotal)} · imposto {moeda(r.impostoTotal)}
      </p>
    </section>
  );
};

interface Props {
  /** Negócios ganhos no período — dinheiro que entrou. */
  wonDeals: Deal[];
  /** Negócios em aberto — dinheiro que talvez entre. */
  openDeals: Deal[];
}

export const ResultadoFinanceiroSection: React.FC<Props> = ({ wonDeals, openDeals }) => {
  const { data: gateways = [] } = useActiveGateways();
  const { data: defaultTaxPct = 0 } = useDefaultTaxPct();

  // Sem gateway cadastrado a conta seria só o valor cheio repetido três vezes: não ajuda ninguém.
  if (gateways.length === 0) return null;

  return (
    <div className="shrink-0">
      <h2 className="text-sm font-bold text-slate-400 uppercase mb-3">Resultado financeiro</h2>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Bloco
          titulo="Realizado no período"
          explicacao="O que já foi ganho. Dinheiro que entrou."
          icone={TrendingUp}
          deals={wonDeals}
          gateways={gateways}
          defaultTaxPct={defaultTaxPct}
          destaque="realizado"
        />
        <Bloco
          titulo="Previsão (em aberto)"
          explicacao="O que está no pipeline. Dinheiro que ainda pode entrar — não some com o realizado."
          icone={Hourglass}
          deals={openDeals}
          gateways={gateways}
          defaultTaxPct={defaultTaxPct}
          destaque="previsao"
        />
      </div>
    </div>
  );
};

export default ResultadoFinanceiroSection;
