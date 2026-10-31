'use client';

/**
 * Metas por vendedor (ARK Onda 3 / 3.3) — dentro de Relatorios > Gestao.
 *
 * Cada meta: vendedor, funil (ou todos), tipo (quantidade de ganhos ou valor ganho), alvo e
 * periodo. A barra mostra o realizado e um marcador com o ritmo esperado (dias decorridos
 * / dias do periodo); status vem da RPC: andamento · risco · batida · nao-batida.
 * Admin cria/arquiva/exclui; vendedor so ve as proprias.
 */

import React, { useMemo, useState } from 'react';
import { Target, Plus, Archive, Trash2, X } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { useBoards } from '@/lib/query/hooks/useBoardsQuery';
import { useOrgMembersQuery } from '@/lib/query/hooks/useOrgMembersQuery';
import {
  useSellerGoals,
  useCreateSellerGoal,
  useArchiveSellerGoal,
  useDeleteSellerGoal,
} from '@/lib/query/hooks/useSellerGoalsQuery';
import type { SellerGoalProgress, SellerGoalStatus } from '@/types';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBR = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};
const fmtValor = (g: SellerGoalProgress, v: number) => (g.goalType === 'currency' ? BRL.format(v) : `${Math.round(v)}`);

const STATUS: Record<SellerGoalStatus, { label: string; cor: string; barra: string }> = {
  andamento: { label: 'No ritmo', cor: 'text-sky-600 bg-sky-50 dark:bg-sky-500/10', barra: 'bg-sky-500' },
  risco: { label: 'Em risco', cor: 'text-amber-600 bg-amber-50 dark:bg-amber-500/10', barra: 'bg-amber-500' },
  batida: { label: 'Batida', cor: 'text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10', barra: 'bg-emerald-500' },
  'nao-batida': { label: 'Não batida', cor: 'text-red-600 bg-red-50 dark:bg-red-500/10', barra: 'bg-red-400' },
};

const primeiroDiaDoMes = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const ultimoDiaDoMes = () => {
  const d = new Date();
  const fim = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${fim.getFullYear()}-${String(fim.getMonth() + 1).padStart(2, '0')}-${String(fim.getDate()).padStart(2, '0')}`;
};

const LinhaMeta: React.FC<{ g: SellerGoalProgress; isAdmin: boolean; onArchive: (id: string) => void; onDelete: (id: string) => void }> = ({
  g,
  isAdmin,
  onArchive,
  onDelete,
}) => {
  const st = STATUS[g.status] ?? STATUS.andamento;
  const pct = Math.min(100, Math.max(0, Number(g.pct) || 0));
  const esperado = Math.min(100, Math.max(0, Number(g.expectedPct) || 0));
  return (
    <div className="py-3 border-b border-slate-100 dark:border-white/5 last:border-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 dark:text-white truncate">
            {g.userName}
            <span className="font-normal text-slate-400"> · {g.boardName || 'todos os funis'}</span>
          </p>
          <p className="text-xs text-slate-500 truncate">
            {g.kpi} · {dataBR(g.startDate)} → {dataBR(g.endDate)}
            {g.description ? ` · ${g.description}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${st.cor}`}>{st.label}</span>
          {isAdmin && !g.archivedAt && (
            <button
              type="button"
              onClick={() => onArchive(g.id)}
              title="Arquivar (vai para o histórico)"
              className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <Archive size={14} />
            </button>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => onDelete(g.id)}
              title="Excluir"
              className="p-1 rounded text-slate-400 hover:text-red-600"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className="relative h-2 flex-1 bg-slate-100 dark:bg-slate-800 rounded-full overflow-visible">
          <div className={`absolute left-0 top-0 h-full rounded-full ${st.barra}`} style={{ width: `${pct}%` }} />
          {!g.archivedAt && g.status !== 'batida' && (
            <div
              className="absolute top-[-3px] h-[14px] w-0.5 bg-slate-500 dark:bg-slate-300"
              style={{ left: `${esperado}%` }}
              title={`Ritmo esperado: ${esperado.toFixed(0)}% (${g.daysElapsed} de ${g.daysTotal} dias)`}
            />
          )}
        </div>
        <span className="text-xs font-mono text-slate-700 dark:text-slate-200 w-28 text-right">
          {fmtValor(g, g.value)} / {fmtValor(g, g.targetValue)}
        </span>
        <span className="text-xs font-mono text-slate-500 w-12 text-right">{pct.toFixed(0)}%</span>
      </div>
      <p className="text-[11px] text-slate-400 mt-1">
        {g.wonCount} ganho{g.wonCount === 1 ? '' : 's'} · {g.lostCount} perdido{g.lostCount === 1 ? '' : 's'}
        {g.goalType === 'number' && g.wonValue > 0 ? ` · ${BRL.format(g.wonValue)} ganhos` : ''}
        {!g.archivedAt && g.status !== 'batida' ? ` · ritmo esperado ${esperado.toFixed(0)}%` : ''}
      </p>
    </div>
  );
};

export const SellerGoalsSection: React.FC<{ isAdmin: boolean; userId?: string }> = ({ isAdmin }) => {
  const { addToast, showToast } = useToast();
  const toast = addToast || showToast;
  const [verArquivadas, setVerArquivadas] = useState(false);
  const [aberto, setAberto] = useState(false);

  const { data: metas = [], isLoading } = useSellerGoals(verArquivadas);
  const { data: members = [] } = useOrgMembersQuery();
  const { data: boards = [] } = useBoards();
  const criar = useCreateSellerGoal();
  const arquivar = useArchiveSellerGoal();
  const excluir = useDeleteSellerGoal();

  const [form, setForm] = useState({
    userId: '',
    boardId: '',
    goalType: 'number' as 'number' | 'currency',
    targetValue: '',
    startDate: primeiroDiaDoMes(),
    endDate: ultimoDiaDoMes(),
    kpi: '',
    description: '',
  });

  const ativas = useMemo(() => metas.filter((m) => !m.archivedAt), [metas]);
  const arquivadas = useMemo(() => metas.filter((m) => !!m.archivedAt), [metas]);

  const salvar = async () => {
    const alvo = Number(String(form.targetValue).replace(',', '.'));
    if (!form.userId) return toast?.('Escolha o vendedor.', 'error');
    if (!alvo || alvo <= 0) return toast?.('Informe o alvo da meta.', 'error');
    if (!form.startDate || !form.endDate || form.endDate < form.startDate) return toast?.('Período inválido.', 'error');
    try {
      await criar.mutateAsync({
        userId: form.userId,
        boardId: form.boardId || null,
        goalType: form.goalType,
        targetValue: alvo,
        startDate: form.startDate,
        endDate: form.endDate,
        kpi: form.kpi || (form.goalType === 'currency' ? 'Valor ganho' : 'Negócios ganhos'),
        description: form.description,
      });
      toast?.('Meta criada.', 'success');
      setAberto(false);
      setForm((f) => ({ ...f, targetValue: '', description: '', kpi: '' }));
    } catch (e) {
      toast?.((e as Error).message || 'Erro ao criar meta.', 'error');
    }
  };

  const onArchive = async (id: string) => {
    try {
      await arquivar.mutateAsync(id);
      toast?.('Meta arquivada.', 'success');
    } catch (e) {
      toast?.((e as Error).message, 'error');
    }
  };
  const onDelete = async (id: string) => {
    try {
      await excluir.mutateAsync(id);
      toast?.('Meta excluída.', 'success');
    } catch (e) {
      toast?.((e as Error).message, 'error');
    }
  };

  const inputCls =
    'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-primary-500';

  return (
    <div className="glass p-4 rounded-xl border border-slate-200 dark:border-white/5 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
          <Target size={16} className="text-amber-500" />
          Metas por vendedor
        </h3>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={verArquivadas} onChange={(e) => setVerArquivadas(e.target.checked)} />
            ver arquivadas
          </label>
          {isAdmin && (
            <button
              type="button"
              onClick={() => setAberto((v) => !v)}
              className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg bg-primary-600 hover:bg-primary-700 text-white"
            >
              {aberto ? <X size={14} /> : <Plus size={14} />}
              {aberto ? 'Fechar' : 'Nova meta'}
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500 mb-2">
        Conta só negócios ganhos (e perdidos) do vendedor com fechamento dentro do período. O traço na barra é o ritmo esperado.
      </p>

      {isAdmin && aberto && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 p-3 mb-3 rounded-xl border border-dashed border-slate-200 dark:border-white/10">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Vendedor</span>
            <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} className={inputCls}>
              <option value="">Selecione</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Funil</span>
            <select value={form.boardId} onChange={(e) => setForm({ ...form, boardId: e.target.value })} className={inputCls}>
              <option value="">Todos os funis</option>
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Tipo</span>
            <select
              value={form.goalType}
              onChange={(e) => setForm({ ...form, goalType: e.target.value as 'number' | 'currency' })}
              className={inputCls}
            >
              <option value="number">Negócios ganhos (quantidade)</option>
              <option value="currency">Valor ganho (R$)</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Alvo</span>
            <input
              type="number"
              min={1}
              step={form.goalType === 'currency' ? '0.01' : '1'}
              value={form.targetValue}
              onChange={(e) => setForm({ ...form, targetValue: e.target.value })}
              placeholder={form.goalType === 'currency' ? '50000' : '10'}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Início</span>
            <input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className={inputCls} />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Fim</span>
            <input type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className={inputCls} />
          </label>
          <label className="block md:col-span-2">
            <span className="text-[11px] font-medium uppercase tracking-wider text-slate-500">Nome / descrição (opcional)</span>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="ex.: Black 26 — matrículas"
              className={inputCls}
            />
          </label>
          <div className="md:col-span-4 flex justify-end">
            <button
              type="button"
              onClick={() => void salvar()}
              disabled={criar.isPending}
              className="px-4 py-2 text-sm font-semibold rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 disabled:opacity-50"
            >
              {criar.isPending ? 'Salvando…' : 'Salvar meta'}
            </button>
          </div>
        </div>
      )}

      {isLoading ? (
        <p className="py-4 text-center text-xs text-slate-400">Carregando…</p>
      ) : ativas.length === 0 && (!verArquivadas || arquivadas.length === 0) ? (
        <p className="py-4 text-center text-xs text-slate-400">
          {isAdmin ? 'Nenhuma meta por vendedor. Clique em "Nova meta".' : 'Você ainda não tem meta cadastrada.'}
        </p>
      ) : (
        <>
          {ativas.map((g) => (
            <LinhaMeta key={g.id} g={g} isAdmin={isAdmin} onArchive={onArchive} onDelete={onDelete} />
          ))}
          {verArquivadas && arquivadas.length > 0 && (
            <>
              <p className="text-[11px] uppercase tracking-wider text-slate-400 mt-3 mb-1">Arquivadas</p>
              {arquivadas.map((g) => (
                <LinhaMeta key={g.id} g={g} isAdmin={isAdmin} onArchive={onArchive} onDelete={onDelete} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
};

export default SellerGoalsSection;
