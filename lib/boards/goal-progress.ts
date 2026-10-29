/**
 * @fileoverview Progresso da meta do funil (ARK #53).
 *
 * A meta conta só GANHOS (igual ao relatório) e, quando tem início/fim, só os ganhos
 * fechados dentro da janela. Sem período, vale o comportamento antigo: tudo que o funil
 * já ganhou. Usado pelo cabeçalho do board e pelo arquivamento da meta.
 */

import type { BoardGoal, Deal } from '@/types';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export interface GoalProgress {
  /** Valor no tipo da meta: R$, quantidade ou %. */
  value: number;
  display: string;
  wonCount: number;
  wonValue: number;
  lostCount: number;
}

/** Dia local (YYYY-MM-DD) de um ISO — comparar em UTC erraria perto da meia-noite. */
const diaLocal = (iso: string) => new Date(iso).toLocaleDateString('sv-SE');

export function dentroDoPeriodo(closedAt: string | undefined, goal: BoardGoal | undefined): boolean {
  if (!goal?.startDate && !goal?.endDate) return true;
  if (!closedAt) return false;
  const dia = diaLocal(closedAt);
  if (goal.startDate && dia < goal.startDate) return false;
  if (goal.endDate && dia > goal.endDate) return false;
  return true;
}

export function calcularProgressoMeta(goal: BoardGoal | undefined, deals: Deal[], boardId: string): GoalProgress {
  const type = goal?.type || 'currency';
  let wonCount = 0;
  let lostCount = 0;
  let wonValue = 0;
  for (const d of deals) {
    if (d.boardId !== boardId) continue;
    if (!d.isWon && !d.isLost) continue;
    if (!dentroDoPeriodo(d.closedAt, goal)) continue;
    if (d.isWon) {
      wonCount += 1;
      wonValue += d.value || 0;
    } else {
      lostCount += 1;
    }
  }

  if (type === 'currency') {
    return { value: wonValue, display: BRL.format(wonValue), wonCount, wonValue, lostCount };
  }
  if (type === 'percentage') {
    const closed = wonCount + lostCount;
    const percent = closed === 0 ? 0 : Math.round((wonCount / closed) * 100);
    return { value: percent, display: `${percent}%`, wonCount, wonValue, lostCount };
  }
  return { value: wonCount, display: wonCount.toString(), wonCount, wonValue, lostCount };
}

export function alvoNumerico(goal: BoardGoal | undefined): number {
  if (!goal?.targetValue) return 0;
  const n = parseFloat(goal.targetValue.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function percentualDaMeta(valor: number, alvo: number): number {
  if (alvo === 0) return 0;
  return Math.min(100, Math.max(0, (valor / alvo) * 100));
}

const dataBR = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

/** "01/11/2026 → 30/12/2026", "a partir de …", "até …" ou null sem período. */
export function formatPeriodo(goal: { startDate?: string; endDate?: string } | undefined): string | null {
  if (!goal?.startDate && !goal?.endDate) return null;
  if (goal.startDate && goal.endDate) return `${dataBR(goal.startDate)} → ${dataBR(goal.endDate)}`;
  if (goal.startDate) return `a partir de ${dataBR(goal.startDate)}`;
  return `até ${dataBR(goal.endDate!)}`;
}
