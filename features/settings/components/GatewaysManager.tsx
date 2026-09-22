'use client';

/**
 * @fileoverview Cadastro de gateways de pagamento e suas taxas.
 *
 * A taxa muda por gateway E por forma de pagamento (decidido com o Mauricio em 22/09/2026),
 * por isso cada gateway tem uma taxa padrão e, opcionalmente, uma taxa por forma.
 * Forma sem taxa própria usa a taxa padrão do gateway.
 *
 * O imposto não mora aqui: é um percentual único da organização, no topo da tela.
 */

import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Percent } from 'lucide-react';
import { gatewaysService, financeiroSettingsService } from '@/lib/supabase';
import { PAYMENT_METHOD_LABELS, type Gateway, type PaymentMethod } from '@/types';

const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[];

export const GatewaysManager: React.FC = () => {
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [novoNome, setNovoNome] = useState('');
  const [novaTaxa, setNovaTaxa] = useState('');
  const [imposto, setImposto] = useState('');

  const carregar = async () => {
    setLoading(true);
    const [{ data, error }, cfg] = await Promise.all([
      gatewaysService.getAll(),
      financeiroSettingsService.getDefaultTaxPct(),
    ]);
    if (error) setErro(error.message);
    setGateways(data);
    setImposto(String(cfg ?? 0));
    setLoading(false);
  };

  useEffect(() => { void carregar(); }, []);

  const criar = async () => {
    const nome = novoNome.trim();
    if (!nome) return;
    setSaving(true);
    const { error } = await gatewaysService.create({ name: nome, feePct: Number(novaTaxa) || 0 });
    setSaving(false);
    if (error) { setErro(error.message); return; }
    setNovoNome('');
    setNovaTaxa('');
    void carregar();
  };

  const salvarTaxaPadrao = async (g: Gateway, valor: string) => {
    await gatewaysService.update(g.id, { feePct: Number(valor) || 0 });
    void carregar();
  };

  const salvarTaxaDaForma = async (g: Gateway, metodo: PaymentMethod, valor: string) => {
    const limpo = valor.trim();
    await gatewaysService.setFee(g.id, metodo, limpo === '' ? null : Number(limpo) || 0);
    void carregar();
  };

  const remover = async (g: Gateway) => {
    if (!window.confirm('Excluir o gateway "' + g.name + '"? Os negócios que usam ele ficam sem gateway.')) return;
    await gatewaysService.delete(g.id);
    void carregar();
  };

  const salvarImposto = async () => {
    await financeiroSettingsService.setDefaultTaxPct(Number(imposto) || 0);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-500 py-10">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    );
  }

  return (
    <div className="pb-10 space-y-8">
      {erro && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-900/20 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-300">
          {erro}
        </div>
      )}

      {/* Imposto da organização */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-5 bg-white/50 dark:bg-white/5">
        <h3 className="font-bold text-slate-900 dark:text-white mb-1">Imposto</h3>
        <p className="text-sm text-slate-500 mb-4">
          Percentual padrão da empresa. Incide sobre o valor cheio da venda, não sobre o que sobra
          depois da taxa. Cada negócio pode ter o seu próprio, quando fugir do padrão.
        </p>
        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              type="number" step="0.001" min="0" max="100"
              value={imposto}
              onChange={(e) => setImposto(e.target.value)}
              onBlur={salvarImposto}
              aria-label="Imposto padrão em porcento"
              className="w-32 pl-3 pr-8 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
            />
            <Percent className="h-4 w-4 text-slate-400 absolute right-2 top-1/2 -translate-y-1/2" />
          </div>
          <span className="text-sm text-slate-500">sai do campo e já salva</span>
        </div>
      </section>

      {/* Novo gateway */}
      <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-5 bg-white/50 dark:bg-white/5">
        <h3 className="font-bold text-slate-900 dark:text-white mb-4">Novo gateway</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-48">
            <label className="block text-xs text-slate-500 mb-1">Nome</label>
            <input
              type="text" value={novoNome}
              onChange={(e) => setNovoNome(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && criar()}
              placeholder="TMB, Eduzz, Hotmart, Lia…"
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1">Taxa padrão (%)</label>
            <input
              type="number" step="0.001" min="0" max="100"
              value={novaTaxa}
              onChange={(e) => setNovaTaxa(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && criar()}
              placeholder="0"
              className="w-32 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <button
            onClick={criar}
            disabled={saving || !novoNome.trim()}
            className="px-4 py-2 bg-primary-600 hover:bg-primary-500 disabled:opacity-40 text-black rounded-lg font-bold text-sm flex items-center gap-2"
          >
            <Plus size={16} /> Adicionar
          </button>
        </div>
      </section>

      {/* Lista */}
      {gateways.length === 0 ? (
        <p className="text-sm text-slate-500">
          Nenhum gateway cadastrado. Adicione TMB, Eduzz, Hotmart e Lia para começar a ver o
          resultado depois das taxas.
        </p>
      ) : (
        <div className="space-y-4">
          {gateways.map((g) => (
            <section key={g.id} className="rounded-xl border border-slate-200 dark:border-slate-700 p-5 bg-white/50 dark:bg-white/5">
              <div className="flex items-center justify-between gap-4 mb-4">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-bold text-slate-900 dark:text-white">{g.name}</span>
                  <label className="text-xs text-slate-500">taxa padrão</label>
                  <div className="relative">
                    <input
                      type="number" step="0.001" min="0" max="100"
                      defaultValue={g.feePct}
                      onBlur={(e) => salvarTaxaPadrao(g, e.target.value)}
                      aria-label={'Taxa padrão de ' + g.name}
                      className="w-24 pl-2 pr-6 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
                    />
                    <Percent className="h-3 w-3 text-slate-400 absolute right-1.5 top-1/2 -translate-y-1/2" />
                  </div>
                </div>
                <button
                  onClick={() => remover(g)}
                  aria-label={'Excluir ' + g.name}
                  className="text-slate-400 hover:text-red-500"
                >
                  <Trash2 size={16} />
                </button>
              </div>

              <p className="text-xs text-slate-500 mb-2">
                Taxa por forma de pagamento. Deixe vazio para a forma usar a taxa padrão acima.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {METHODS.map((m) => {
                  const atual = g.fees?.find(f => f.paymentMethod === m);
                  return (
                    <div key={m}>
                      <label className="block text-xs text-slate-500 mb-1">{PAYMENT_METHOD_LABELS[m]}</label>
                      <div className="relative">
                        <input
                          type="number" step="0.001" min="0" max="100"
                          defaultValue={atual ? atual.feePct : ''}
                          placeholder={String(g.feePct)}
                          onBlur={(e) => salvarTaxaDaForma(g, m, e.target.value)}
                          aria-label={'Taxa de ' + PAYMENT_METHOD_LABELS[m] + ' em ' + g.name}
                          className="w-full pl-2 pr-6 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-black/20 text-sm dark:text-white outline-none focus:ring-2 focus:ring-primary-500"
                        />
                        <Percent className="h-3 w-3 text-slate-400 absolute right-1.5 top-1/2 -translate-y-1/2" />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default GatewaysManager;
