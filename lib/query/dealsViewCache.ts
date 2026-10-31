/**
 * ARK (Onda 1 / 1.3) — caches de DealView.
 *
 * Antes havia UM cache (`DEALS_VIEW_KEY`) com TODOS os negocios de todos os funis, e o
 * Kanban filtrava o board no navegador. Agora cada board tem o seu cache
 * (`[...DEALS_VIEW_KEY, boardId]`) e o cache "todos" continua existindo para as telas que
 * precisam da visao geral (Visao Geral, Inbox, cockpit).
 *
 * Mutations e realtime continuam escrevendo em "todos os caches de DealView": estes helpers
 * aplicam o mesmo updater em cada cache cujo prefixo e DEALS_VIEW_KEY. Como o `select` do
 * Kanban filtra por boardId, um negocio inserido num cache de outro board nao aparece la.
 */
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { DEALS_VIEW_KEY } from './queryKeys';
import type { DealView } from '@/types';

export type DealsViewSnapshot = Array<[QueryKey, DealView[] | undefined]>;

/** Chave do cache de um board especifico. */
export const dealsBoardViewKey = (boardId: string) => [...DEALS_VIEW_KEY, boardId] as const;

/** Foto de todos os caches de DealView (para rollback). */
export function snapshotDealsViewCaches(queryClient: QueryClient): DealsViewSnapshot {
  return queryClient.getQueriesData<DealView[]>({ queryKey: DEALS_VIEW_KEY });
}

/** Aplica `updater` em cada cache de DealView ja carregado. */
export function setDealsViewCaches(
  queryClient: QueryClient,
  updater: (old: DealView[]) => DealView[]
): void {
  queryClient.setQueriesData<DealView[]>({ queryKey: DEALS_VIEW_KEY }, (old) =>
    Array.isArray(old) ? updater(old) : old
  );
}

/** Restaura a foto tirada por snapshotDealsViewCaches. */
export function restoreDealsViewCaches(queryClient: QueryClient, snapshot: DealsViewSnapshot | undefined): void {
  if (!snapshot) return;
  for (const [key, data] of snapshot) queryClient.setQueryData(key, data);
}
