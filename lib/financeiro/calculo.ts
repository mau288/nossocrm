/**
 * @fileoverview Conta unica do financeiro. Toda tela que mostrar "apos taxas" ou "lucro"
 * passa por aqui, para a formula nao se espalhar e divergir.
 *
 * Decidido com o Mauricio em 22/09/2026:
 * - A taxa e do GATEWAY e muda por FORMA DE PAGAMENTO. O mesmo produto vende por gateways
 *   diferentes, entao taxa por produto estaria errada.
 * - O imposto incide sobre o valor BRUTO vendido, nao sobre o que sobra da taxa:
 *     lucro = valor - (valor * taxa) - (valor * imposto) = valor * (1 - taxa - imposto)
 */

import type { Deal, Gateway } from '@/types';

/**
 * Taxa que vale para um negocio, em %.
 *
 * Ordem: override do proprio negocio > taxa da forma de pagamento no gateway > taxa padrao
 * do gateway > 0. Sem gateway escolhido a taxa e 0 — negocio sem gateway nao inventa desconto.
 */
export function resolveFeePct(deal: Pick<Deal, 'feePct' | 'gatewayId' | 'paymentMethod'>, gateways: Gateway[]): number {
  if (deal.feePct !== undefined && deal.feePct !== null) return deal.feePct;

  const gateway = gateways.find(g => g.id === deal.gatewayId);
  if (!gateway) return 0;

  const porForma = deal.paymentMethod
    ? gateway.fees?.find(f => f.paymentMethod === deal.paymentMethod)
    : undefined;

  return porForma ? porForma.feePct : gateway.feePct;
}

/** Imposto que vale para um negocio, em %: override do negocio > padrao da organizacao. */
export function resolveTaxPct(deal: Pick<Deal, 'taxPct'>, defaultTaxPct: number): number {
  if (deal.taxPct !== undefined && deal.taxPct !== null) return deal.taxPct;
  return defaultTaxPct || 0;
}

export interface ResultadoFinanceiro {
  /** Soma dos valores cheios. */
  bruto: number;
  /** Quanto a taxa dos gateways comeu. */
  taxaTotal: number;
  /** Quanto o imposto comeu (sempre sobre o bruto). */
  impostoTotal: number;
  /** bruto - taxaTotal */
  aposTaxas: number;
  /** bruto - taxaTotal - impostoTotal */
  aposTaxasEImposto: number;
}

/** Soma um conjunto de negocios aplicando taxa e imposto de cada um. */
export function calcularResultado(
  deals: Array<Pick<Deal, 'value' | 'feePct' | 'taxPct' | 'gatewayId' | 'paymentMethod'>>,
  gateways: Gateway[],
  defaultTaxPct: number
): ResultadoFinanceiro {
  let bruto = 0, taxaTotal = 0, impostoTotal = 0;

  for (const deal of deals) {
    const valor = Number(deal.value) || 0;
    bruto += valor;
    taxaTotal += valor * (resolveFeePct(deal, gateways) / 100);
    impostoTotal += valor * (resolveTaxPct(deal, defaultTaxPct) / 100);
  }

  return {
    bruto,
    taxaTotal,
    impostoTotal,
    aposTaxas: bruto - taxaTotal,
    aposTaxasEImposto: bruto - taxaTotal - impostoTotal,
  };
}
