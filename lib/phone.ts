import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Regra do produto: padronizar telefones em E.164.
 *
 * - Aceita entrada “solta” (com espaços, parênteses, hífen etc.)
 * - Tenta normalizar usando `defaultCountry` quando não houver prefixo +
 * - Retorna string E.164 (ex.: +5511999990000) ou '' quando vazio
 *
 * Observação:
 * - Se a string já estiver em E.164 válido, retorna como está.
 * - Se não for possível parsear/validar, retorna uma versão “sanitizada”
 *   (mantendo + e dígitos) apenas se parecer E.164; caso contrário, retorna o input trimado.
 */
export function normalizePhoneE164(
  input?: string | null,
  opts?: {
    defaultCountry?: CountryCode;
  }
): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';

  // Atalho: já está em E.164?
  const e164Candidate = raw.replace(/[\s\-()]/g, '');
  if (isE164(e164Candidate)) return e164Candidate;

  const defaultCountry = opts?.defaultCountry ?? 'BR';

  // Parse com fallback de país; funciona bem para inputs sem + (ex.: (11) 99999-0000)
  const phone = parsePhoneNumberFromString(raw, defaultCountry);
  if (phone?.isValid()) return phone.number; // E.164

  // Fallback: mantém somente + e dígitos. Se ficar com cara de E.164, retorna.
  const sanitized = raw.replace(/[^\d+]/g, '');
  if (isE164(sanitized)) return sanitized;

  // Último fallback: devolve o que o usuário tem (evita apagar dado), mas o objetivo
  // é que o sistema normalize na entrada e não chegue aqui com frequência.
  return raw;
}

/** Normaliza um telefone destinado ao WhatsApp sem alterar seus dígitos. */
export function normalizeWhatsAppPhoneE164(input?: string | null): string {
  return normalizePhoneE164(input);
}

/**
 * Função pública `isE164` do projeto.
 *
 * @param {string | null | undefined} input - Parâmetro `input`.
 * @returns {boolean} Retorna um valor do tipo `boolean`.
 */
export function isE164(input?: string | null): boolean {
  const value = (input ?? '').trim();
  return /^\+[1-9]\d{1,14}$/.test(value);
}

/**
 * Para WhatsApp (wa.me) normalmente usamos somente dígitos (sem '+').
 * Retorna '' se não houver número.
 */
export function toWhatsAppPhone(input?: string | null, opts?: { defaultCountry?: CountryCode }): string {
  const e164 = normalizePhoneE164(input, opts);
  if (!e164) return '';
  return e164.replace(/^\+/, '');
}
