import { useSyncExternalStore } from 'react';
import { DEBUG_MODE_EVENT, isDebugMode } from './mode';

function subscribe(callback: () => void) {
  if (typeof window === 'undefined') return () => undefined;

  const handler = () => callback();
  window.addEventListener(DEBUG_MODE_EVENT, handler);
  // For cross-tab updates
  window.addEventListener('storage', handler);

  return () => {
    window.removeEventListener(DEBUG_MODE_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

/**
 * Hook React `useDebugMode` que encapsula uma lógica reutilizável.
 * @returns {boolean} Retorna um valor do tipo `boolean`.
 */
export function useDebugMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isDebugMode(),
    () => false
  );
}

