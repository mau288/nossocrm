'use client';

/**
 * @fileoverview Painel do gestor — Relatorios > Gestao (ARK Onda 3 / 3.1).
 *
 * Tudo vem de uma RPC (`get_gestao_painel`): fila de conversas aguardando resposta
 * (snapshot de agora), tempo de 1a resposta no periodo, abertas x resolvidas por dia e
 * leads por origem/campanha x conversao. Admin ve a casa inteira e pode filtrar por
 * vendedor; vendedor ve so o que esta atribuido a ele.
 * Abaixo entram as metas por vendedor (3.3) e a configuracao dos alertas (3.4).
 */

import React, { useState } from 'react';
import Link from 'next/link';
import { AlertCircle, Clock, Inbox, CheckCircle2, MessageSquare, Instagram, Hash, RefreshCw } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { useGestaoPainelQuery, type GestaoOrigem } from '@/lib/query/hooks/useGestaoPainelQuery';
import { useOrgMembersQuery } from '@/lib/query/hooks/useOrgMembersQuery';
import { PeriodFilterSelect } from '@/components/filters/PeriodFilterSelect';
import { LazyAbertasResolvidasChart, ChartWrapper } from '@/components/charts';
import type { PeriodFilter } from '@/features/dashboard/hooks/useDashboardMetrics';
import { SellerGoalsSection } from './SellerGoalsSection';
import { AlertSettingsSection } from './AlertSettingsSection';

// =============================================================================
// Helpers
// =============================================================================

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatMinutes(min: number): string {
  if (!min || min <= 0) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) {
    const m = min % 60;
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  return `${Math.floor(h / 24)} dias`;
}

export function formatSeconds(s: number): string {
  if (!s || s <= 0) return '—';
  if (s < 60) return `${s}s`;
  return formatMinutes(Math.round(s / 60));
}

const pct = (parte: number, total: number) => (total > 0 ? `${Math.round((parte / total) * 100)}%` : '—');

const ChannelIcon: React.FC<{ type: string; className?: string }> = ({ type, className = 'w-3.5 h-3.5' }) => {
  if (type === 'instagram') return <Instagram className={className} />;
  if (type === 'tiktok') return <Hash className={className} />;
  return <MessageSquare className={className} />;
};

const SLA_OPTIONS = [15, 30, 60, 120, 240];
const JANELA_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 24, label: 'últimas 24h' },
  { value: 72, label: 'últimos 3 dias' },
  { value: 168, label: 'últimos 7 dias' },
  { value: 720, label: 'últimos 30 dias' },
];

// =============================================================================
// Pecas
// =============================================================================

const Card: React.FC<{ title: string; icon?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  title,
  icon,
  right,
  children,
  className = '',
}) => (
  <div className={`glass p-4 rounded-xl border border-slate-200 dark:border-white/5 shadow-sm ${className}`}>
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-sm font-bold text-slate-900 dark:text-white flex items-center gap-2">
        {icon}
        {title}
      </h3>
      {right}
    </div>
    {children}
  </div>
);

const Kpi: React.FC<{ label: string; value: string | number; sub?: string; tone?: 'amber' | 'green' | 'blue' | 'red' | 'slate' }> = ({
  label,
  value,
  sub,
  tone = 'slate',
}) => {
  const tones = {
    amber: 'text-amber-500',
    green: 'text-emerald-500',
    blue: 'text-sky-500',
    red: 'text-red-500',
    slate: 'text-slate-900 dark:text-white',
  };
  return (
    <div className="glass p-4 rounded-xl border border-slate-200 dark:border-white/5 shadow-sm">
      <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${tones[tone]}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 truncate">{sub}</p>}
    </div>
  );
};

const TabelaSimples: React.FC<{
  colunas: string[];
  linhas: Array<Array<React.ReactNode>>;
  vazio: string;
}> = ({ colunas, linhas, vazio }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {colunas.map((c, i) => (
            <th key={c} className={`py-1.5 pr-3 font-medium ${i > 0 ? 'text-right' : ''}`}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100 dark:divide-white/5">
        {linhas.length === 0 ? (
          <tr>
            <td colSpan={colunas.length} className="py-4 text-center text-xs text-slate-400">
              {vazio}
            </td>
          </tr>
        ) : (
          linhas.map((l, i) => (
            <tr key={i}>
              {l.map((cel, j) => (
                <td key={j} className={`py-1.5 pr-3 ${j > 0 ? 'text-right font-mono text-xs text-slate-700 dark:text-slate-200' : 'text-slate-800 dark:text-slate-100'}`}>
                  {cel}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

const TabelaOrigem: React.FC<{ chave: 'origem' | 'campanha'; dados: GestaoOrigem[]; vazio: string }> = ({ chave, dados, vazio }) => (
  <TabelaSimples
    colunas={[chave === 'origem' ? 'Origem' : 'Campanha', 'Contatos', 'Com negócio', 'Ganhos', 'Conv.', 'Valor ganho']}
    vazio={vazio}
    linhas={dados.map((d) => [
      d[chave] || '—',
      d.contatos,
      d.comNegocio,
      d.ganhos,
      pct(d.ganhos, d.contatos),
      BRL.format(Number(d.valorGanho) || 0),
    ])}
  />
);

// =============================================================================
// Painel
// =============================================================================

export const GestaoPanel: React.FC<{ viewToggle?: React.ReactNode }> = ({ viewToggle }) => {
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const [period, setPeriod] = useState<PeriodFilter>('last_7_days');
  const [sla, setSla] = useState<number>(30);
  const [janela, setJanela] = useState<number>(168);
  const [userId, setUserId] = useState<string>('');

  const { data: members = [] } = useOrgMembersQuery();
  const { data, isLoading, isFetching, refetch, error } = useGestaoPainelQuery(
    period,
    sla,
    isAdmin && userId ? userId : undefined,
    janela
  );

  const ag = data?.aguardando;
  const frt = data?.frt;
  const porDia = data?.porDia ?? [];
  const totalAbertas = porDia.reduce((a, d) => a + d.abertas, 0);
  const totalResolvidas = porDia.reduce((a, d) => a + d.resolvidas, 0);

  return (
    <div className="space-y-4 pb-8">
      {/* Cabecalho */}
      <div className="flex flex-wrap justify-between items-start gap-3">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white font-display tracking-tight">Gestão</h1>
          <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">
            {isAdmin ? 'Fila de atendimento, tempo de resposta, origem dos leads e metas por vendedor.' : 'Suas conversas, seu tempo de resposta e suas metas.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {viewToggle}
          {isAdmin && (
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="Vendedor"
              className="px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-primary-500"
            >
              <option value="">Todos os vendedores</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          <PeriodFilterSelect value={period} onChange={setPeriod} />
          <button
            type="button"
            onClick={() => void refetch()}
            title="Atualizar agora"
            className="p-2 rounded-lg glass border border-slate-200/50 dark:border-white/10 text-slate-500 hover:text-slate-800 dark:hover:text-white"
          >
            <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-sm text-red-700 dark:text-red-300">
          Não foi possível carregar o painel: {(error as Error).message}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi
          label={`Aguardando resposta há mais de ${sla} min`}
          value={isLoading ? '…' : ag?.total ?? 0}
          sub={ag?.total ? `mais antiga: ${formatMinutes(ag.oldestMinutes)}` : 'fila limpa'}
          tone={ag?.total ? 'amber' : 'green'}
        />
        <Kpi
          label="Tempo de 1ª resposta (mediana)"
          value={isLoading ? '…' : formatSeconds(frt?.medianSeconds ?? 0)}
          sub={frt?.count ? `média ${formatSeconds(frt.avgSeconds)} · ${frt.count} conversas` : 'sem conversas medidas no período'}
          tone="blue"
        />
        <Kpi label="Conversas abertas no período" value={isLoading ? '…' : totalAbertas} sub="novas conversas criadas" />
        <Kpi
          label="Resolvidas no período"
          value={isLoading ? '…' : totalResolvidas}
          sub={totalAbertas ? `${pct(totalResolvidas, totalAbertas)} das abertas` : undefined}
          tone="green"
        />
      </div>

      {/* Fila aguardando resposta */}
      <Card
        title="Aguardando resposta"
        icon={<AlertCircle size={16} className="text-amber-500" />}
        right={
          <div className="flex items-center gap-2 text-xs">
            <label className="text-slate-500">parada há mais de</label>
            <select
              value={sla}
              onChange={(e) => setSla(Number(e.target.value))}
              className="px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-xs"
            >
              {SLA_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            <label className="text-slate-500">em</label>
            <select
              value={janela}
              onChange={(e) => setJanela(Number(e.target.value))}
              className="px-2 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md text-xs"
            >
              {JANELA_OPTIONS.map((j) => (
                <option key={j.value} value={j.value}>
                  {j.label}
                </option>
              ))}
            </select>
          </div>
        }
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Por canal</p>
            <TabelaSimples
              colunas={['Canal', 'Conversas', 'Mais antiga']}
              vazio="Nenhuma conversa parada."
              linhas={(ag?.porCanal ?? []).map((c) => [
                <span key={c.channelId} className="flex items-center gap-1.5">
                  <ChannelIcon type={c.channelType} />
                  <span className="truncate max-w-[180px]">{c.channelName}</span>
                </span>,
                c.count,
                formatMinutes(c.oldestMinutes ?? 0),
              ])}
            />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Por vendedor</p>
            <TabelaSimples
              colunas={['Vendedor', 'Conversas', 'Mais antiga']}
              vazio="Nenhuma conversa parada."
              linhas={(ag?.porVendedor ?? []).map((v) => [v.name, v.count, formatMinutes(v.oldestMinutes ?? 0)])}
            />
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">As 20 mais antigas</p>
            <div className="max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-white/5">
              {(ag?.lista ?? []).length === 0 ? (
                <p className="py-4 text-center text-xs text-slate-400">Nenhuma conversa parada.</p>
              ) : (
                (ag?.lista ?? []).map((c) => (
                  <Link
                    key={c.conversationId}
                    href={`/messaging?id=${c.conversationId}`}
                    className="flex items-center gap-2 py-1.5 hover:bg-slate-50 dark:hover:bg-white/5 rounded px-1"
                  >
                    <ChannelIcon type={c.channelType} className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 dark:text-slate-100 truncate">{c.contactName || 'Sem nome'}</p>
                      <p className="text-[11px] text-slate-400 truncate">{c.preview || c.channelName}</p>
                    </div>
                    <span className="text-xs font-mono text-amber-600 dark:text-amber-400 shrink-0">{formatMinutes(c.minutes)}</span>
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* FRT + abertas x resolvidas */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card title="Tempo de 1ª resposta" icon={<Clock size={16} className="text-sky-500" />}>
          <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Por canal</p>
          <TabelaSimples
            colunas={['Canal', 'Mediana', 'Média', 'N']}
            vazio="Sem conversas medidas."
            linhas={(frt?.porCanal ?? []).map((c) => [
              <span key={c.channelId} className="flex items-center gap-1.5">
                <ChannelIcon type={c.channelType} />
                <span className="truncate max-w-[160px]">{c.channelName}</span>
              </span>,
              formatSeconds(c.medianSeconds ?? 0),
              formatSeconds(c.avgSeconds ?? 0),
              c.count,
            ])}
          />
          <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1 mt-3">Por vendedor</p>
          <TabelaSimples
            colunas={['Vendedor', 'Mediana', 'Média', 'N']}
            vazio="Sem conversas medidas."
            linhas={(frt?.porVendedor ?? []).map((v) => [v.name, formatSeconds(v.medianSeconds ?? 0), formatSeconds(v.avgSeconds ?? 0), v.count])}
          />
        </Card>

        <Card title="Abertas × resolvidas por dia" icon={<Inbox size={16} className="text-emerald-500" />} className="lg:col-span-2 flex flex-col">
          <div className="h-64">
            {porDia.length > 0 ? (
              <ChartWrapper height="100%">
                <LazyAbertasResolvidasChart data={porDia} />
              </ChartWrapper>
            ) : (
              <p className="py-10 text-center text-xs text-slate-400">Sem dados no período.</p>
            )}
          </div>
        </Card>
      </div>

      {/* Origem x conversao */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Leads por origem × conversão" icon={<CheckCircle2 size={16} className="text-primary-500" />}>
          <p className="text-xs text-slate-500 mb-2">Contatos que viraram contato no período, por canal de entrada.</p>
          <TabelaOrigem chave="origem" dados={data?.origem ?? []} vazio="Nenhum contato novo no período." />
        </Card>
        <Card title="Por campanha / funil" icon={<CheckCircle2 size={16} className="text-primary-500" />}>
          <p className="text-xs text-slate-500 mb-2">Tags funil:, edicao:, campanha: e lista: dos mesmos contatos.</p>
          <TabelaOrigem chave="campanha" dados={data?.campanha ?? []} vazio="Nenhum contato com tag de campanha no período." />
        </Card>
      </div>

      {/* Metas por vendedor (3.3) */}
      <SellerGoalsSection isAdmin={isAdmin} userId={profile?.id} />

      {/* Alertas (3.4) — so admin */}
      {isAdmin && <AlertSettingsSection />}
    </div>
  );
};

export default GestaoPanel;
