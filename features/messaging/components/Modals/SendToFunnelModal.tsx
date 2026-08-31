import React, { useEffect, useMemo, useState } from 'react';
import { useCreateDeal } from '@/lib/query/hooks/useDealsQuery';
import { useBoards } from '@/lib/query/hooks/useBoardsQuery';
import { Deal } from '@/types';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/context/ToastContext';

interface SendToFunnelModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Contato real vinculado à conversa (obrigatório para criar o negócio). */
  contactId: string;
  contactName: string;
  /** Conversa de origem — vai no metadata do negócio para rastreio. */
  conversationId?: string;
  /** Nome do canal (ex: "Chip Raul (espelho n8n)") — vira tag do negócio. */
  channelName?: string;
}

/**
 * Modal "Enviar pro Funil": o operador decide manualmente qual conversa vira
 * negócio no Kanban — escolhe board, etapa, título e valor. Nada é criado
 * automaticamente; este é o único caminho da conversa para o funil.
 */
export const SendToFunnelModal: React.FC<SendToFunnelModalProps> = ({
  isOpen,
  onClose,
  contactId,
  contactName,
  conversationId,
  channelName,
}) => {
  const createDeal = useCreateDeal();
  const { data: boards = [] } = useBoards();
  const { showToast } = useToast();

  const [boardId, setBoardId] = useState<string>('');
  const [stageId, setStageId] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [value, setValue] = useState<string>('');

  const selectedBoard = useMemo(
    () => boards.find((b) => b.id === boardId) ?? null,
    [boards, boardId]
  );
  const stages = selectedBoard?.stages ?? [];

  // Ao abrir: board padrão + primeira etapa + título sugerido
  useEffect(() => {
    if (!isOpen) return;
    const defaultBoard = boards.find((b) => b.isDefault) || boards[0] || null;
    setBoardId(defaultBoard?.id ?? '');
    setStageId(defaultBoard?.stages?.[0]?.id ?? '');
    setTitle(contactName || 'Novo negócio');
    setValue('');
  }, [isOpen, boards, contactName]);

  // Trocou de board → volta para a primeira etapa dele
  useEffect(() => {
    if (!selectedBoard) return;
    if (!selectedBoard.stages.some((s) => s.id === stageId)) {
      setStageId(selectedBoard.stages[0]?.id ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  const canSubmit = Boolean(boardId && stageId && title.trim()) && !createDeal.isPending;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const numericValue = Number.parseFloat(value.replace(',', '.'));

    const deal: Omit<Deal, 'id' | 'createdAt'> = {
      title: title.trim(),
      companyId: '',
      contactId,
      boardId,
      value: Number.isFinite(numericValue) ? numericValue : 0,
      items: [],
      status: stageId,
      updatedAt: new Date().toISOString(),
      probability: 10,
      priority: 'medium',
      tags: channelName ? ['Conversa', channelName] : ['Conversa'],
      owner: { name: 'Eu', avatar: '' },
      customFields: conversationId ? { conversation_id: conversationId } : {},
      isWon: false,
      isLost: false,
    };

    createDeal.mutate(deal as Parameters<typeof createDeal.mutate>[0], {
      onSuccess: () => {
        showToast('Negócio criado no funil!', 'success');
        onClose();
      },
      onError: (err) => {
        showToast(
          err instanceof Error ? err.message : 'Falha ao criar o negócio.',
          'error'
        );
      },
    });
  };

  const inputClass =
    'w-full bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 outline-none transition-all';
  const labelClass =
    'block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Enviar pro Funil" size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Cria um negócio no Kanban para <span className="font-semibold">{contactName}</span> a
          partir desta conversa.
        </p>

        <div>
          <label className={labelClass} htmlFor="funnel-board">Board</label>
          <select
            id="funnel-board"
            className={inputClass}
            value={boardId}
            onChange={(e) => setBoardId(e.target.value)}
          >
            {boards.length === 0 && <option value="">Nenhum board criado</option>}
            {boards.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="funnel-stage">Etapa</label>
          <select
            id="funnel-stage"
            className={inputClass}
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="funnel-title">Título do negócio</label>
          <input
            id="funnel-title"
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex: Curso de Instrumentação - Fabricio"
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="funnel-value">Valor estimado (R$) — opcional</label>
          <input
            id="funnel-value"
            className={inputClass}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0,00"
            inputMode="decimal"
          />
        </div>

        <div className="flex gap-3 justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/5 transition-colors"
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {createDeal.isPending ? 'Criando…' : 'Criar negócio'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default SendToFunnelModal;
