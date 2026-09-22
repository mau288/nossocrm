'use client';

/**
 * @fileoverview Bloco financeiro do negócio: gateway, forma de pagamento, taxa e imposto.
 *
 * Escolher o gateway e a forma já preenche a taxa com o padrão cadastrado, e o campo
 * continua editável ali mesmo — pedido do Mauricio em 22/09/2026: "quando eu for selecionar
 * eu já consigo ajustar". O que for digitado vale só para aquele negócio; apagar o campo
 * devolve o padrão.
 *
 * A conta em si mora em lib/financeiro/calculo.ts, para não existir em dois lugares.
 */

import React from 'react';
import { Landmark } from 'lucide-react';
import { useActiveGateways, useDefaultTaxPct } from '@/lib/query/hooks';
import { resolveFeePct, resolveTaxPct } from '@/lib/financeiro/calculo';
import { PAYMENT_METHOD_LABELS, type Deal, type PaymentMethod } from '@/types';

const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[];

const moeda = (n: number) =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

interface Props {
  deal: Deal;
  updateDeal: (id: string, updates: Partial<Deal>) => void;
}

export const DealFinanceiroSection: React.FC<Props> = ({ deal, updateDeal }) => {
  const { data: gateways = [] } = useActiveGateways();
  const { data: defaultTaxPct = 0 } = useDefaultTaxPct();

  const taxaEfetiva = resolveFeePct(deal, gateways);
  const impostoEfetivo = resolveTaxPct(deal, defaultTaxPct);

  const valor = Number(deal.value) || 0;
  const taxaEmReais = valor * (taxaEfetiva / 100);
  const impostoEmReais = valor * (impostoEfetivo / 100);
  const lucro = valor - taxaEmReais - impostoEmReais;

  /** Campo vazio grava null, que faz o negócio voltar a usar o padrão. */
  const gravarPercentual = (campo: 'feePct' | 'taxPct', bruto: string) => {
    const limpo = bruto.trim();
    updateDeal(deal.id, { [campo]: limpo === '' ? null : Number(limpo) } as unknown as Partial<Deal>);
  };

  return (
    <div className="pt-4 border-t border-slate-100 dark:border-white/5">
      <h3 className="text-xs font-bold text-slate-400 uppercase mb-3 flex items-center gap-2">
        <Landmark size={14} /> Financeiro
      </h3>

      {gateways.length === 0 ? (
        <p className="text-xs text-slate-500 italic">
          Nenhum gateway cadastrado ainda. Cadastre em Configurações &rsaquo; Financeiro para o
          CRM calcular quanto sobra depois das taxas.
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Gateway</label>
            <select
              value={deal.gatewayId || ''}
              onChange={(e) => updateDeal(deal.id, { gatewayId: e.target.value || undefined })}
              className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">— sem gateway —</option>
              {gateways.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-slate-500 mb-1">Forma de pagamento</label>
            <select
              value={deal.paymentMethod || ''}
              onChange={(e) => updateDeal(deal.id, { paymentMethod: (e.target.value || undefined) as PaymentMethod | undefined })}
              className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">— não informada —</option>
              {METHODS.map((m) => (
                <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Taxa (%)</label>
              <input
                key={`fee-${deal.id}-${deal.gatewayId || ''}-${deal.paymentMethod || ''}`}
                type="number" step="0.001" min="0" max="100"
                defaultValue={deal.feePct ?? ''}
                placeholder={String(taxaEfetiva)}
                onBlur={(e) => gravarPercentual('feePct', e.target.value)}
                aria-label="Taxa do gateway nesta venda, em porcento"
                title="Vazio usa a taxa do gateway. Preenchido vale só para este negócio."
                className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div>
              <label className="block text-[11px] text-slate-500 mb-1">Imposto (%)</label>
              <input
                key={`tax-${deal.id}`}
                type="number" step="0.001" min="0" max="100"
                defaultValue={deal.taxPct ?? ''}
                placeholder={String(defaultTaxPct)}
                onBlur={(e) => gravarPercentual('taxPct', e.target.value)}
                aria-label="Imposto nesta venda, em porcento"
                title="Vazio usa o imposto padrão da empresa. Preenchido vale só para este negócio."
                className="w-full px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
          </div>

          <div className="rounded-lg bg-slate-50 dark:bg-white/5 border border-slate-200 dark:border-white/10 px-3 py-2 space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Valor</span>
              <span className="text-slate-900 dark:text-white font-mono">{moeda(valor)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Taxa ({taxaEfetiva}%)</span>
              <span className="text-slate-500 font-mono">- {moeda(taxaEmReais)}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-slate-500">Imposto ({impostoEfetivo}%)</span>
              <span className="text-slate-500 font-mono">- {moeda(impostoEmReais)}</span>
            </div>
            <div className="flex justify-between text-sm pt-1 border-t border-slate-200 dark:border-white/10">
              <span className="font-bold text-slate-700 dark:text-slate-200">Sobra</span>
              <span className="font-bold font-mono text-primary-600 dark:text-primary-400">{moeda(lucro)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DealFinanceiroSection;
