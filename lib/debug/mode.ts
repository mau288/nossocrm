/**
 * Debug Mode — flags puras (sem dependencias).
 *
 * ARK (Onda 0 / 0.7): separado de `./index` para que o shell (Layout, useDebugMode)
 * possa ler a flag sem puxar o Faker para o bundle inicial.
 */

export const DEBUG_MODE_EVENT = 'debug_mode_changed';

/**
 * Função pública `isDebugMode` do projeto.
 * @returns {boolean} Retorna um valor do tipo `boolean`.
 */
export const isDebugMode = (): boolean => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('DEBUG_MODE') === 'true';
};

/**
 * Função pública `enableDebugMode` do projeto.
 * @returns {void} Não retorna valor.
 */
export const enableDebugMode = (): void => {
  localStorage.setItem('DEBUG_MODE', 'true');
  window.dispatchEvent(new CustomEvent(DEBUG_MODE_EVENT));
  console.log('🐛 Debug mode ENABLED');
};

/**
 * Função pública `disableDebugMode` do projeto.
 * @returns {void} Não retorna valor.
 */
export const disableDebugMode = (): void => {
  localStorage.removeItem('DEBUG_MODE');
  window.dispatchEvent(new CustomEvent(DEBUG_MODE_EVENT));
  console.log('🐛 Debug mode DISABLED');
};

// Expõe no window para fácil acesso via console
if (typeof window !== 'undefined') {
  const w = window as unknown as Record<string, unknown>;
  w.enableDebugMode = enableDebugMode;
  w.disableDebugMode = disableDebugMode;
  w.isDebugMode = isDebugMode;
}
