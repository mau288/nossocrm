/**
 * Estado de conexao dos canais realtime (ARK, Onda 1 / 1.2).
 *
 * O polling das listas de Mensagens (conversas a cada 20 s, thread a cada 12 s) existia
 * como rede de seguranca para quando o WebSocket cai. Com este registro, as queries
 * perguntam "o realtime esta de pe?" e so fazem polling agressivo quando NAO esta.
 */

const channelStatus = new Map<string, boolean>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

/** Registra o status de um canal (SUBSCRIBED = true). */
export function setRealtimeChannelConnected(channelName: string, connected: boolean): void {
  const prev = channelStatus.get(channelName);
  if (prev === connected) return;
  channelStatus.set(channelName, connected);
  notify();
}

/** Remove um canal do registro (cleanup do hook). */
export function forgetRealtimeChannel(channelName: string): void {
  if (channelStatus.delete(channelName)) notify();
}

/** true quando pelo menos um canal realtime esta assinado. */
export function isRealtimeConnected(): boolean {
  for (const v of channelStatus.values()) if (v) return true;
  return false;
}

/** Para useSyncExternalStore, se alguma tela quiser mostrar o estado. */
export function subscribeRealtimeStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
