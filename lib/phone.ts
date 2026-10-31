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

/**
 * ARK (Onda 2B): regra do 9º dígito. Espelho de `normalize_phone_e164()` no banco.
 *
 * - '+551187654321' (celular BR com 8 dígitos) -> '+5511987654321'
 * - '11 98765-4321' | '011987654321' | '5511987654321' -> '+5511987654321'
 * - fixo BR (1º dígito local 2-5) fica com 8 dígitos
 * - fora do Brasil: só limpa (mantém + e dígitos)
 * Retorna '' quando vazio.
 */
export function normalizePhoneBr(input?: string | null): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  const intl = raw.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!intl) {
    if (digits.startsWith('0') && (digits.length === 11 || digits.length === 12)) digits = digits.slice(1);
    if (digits.length === 10 || digits.length === 11) digits = '55' + digits;
  }
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const local = digits.slice(4);
    if (local.length === 8 && local[0] >= '6' && local[0] <= '9') {
      digits = digits.slice(0, 4) + '9' + local;
    }
  }
  return '+' + digits;
}

/** Variantes para PROCURAR um telefone no banco antigo (canônico, sem 9, sem '+'). */
export function phoneLookupVariants(input?: string | null): string[] {
  const canon = normalizePhoneBr(input);
  if (!canon) return [];
  const out = [canon, canon.slice(1)];
  if (canon.startsWith('+55') && canon.length === 14 && canon[5] === '9') {
    const no9 = canon.slice(0, 5) + canon.slice(6);
    out.push(no9, no9.slice(1));
  }
  const raw = (input ?? '').trim();
  if (raw && !out.includes(raw)) out.push(raw);
  return out;
}

/** '@Fulano' -> 'fulano'; vazio -> null. Espelho de `normalize_social_username()`. */
export function normalizeSocialUsername(input?: string | null): string | null {
  const v = (input ?? '').trim().replace(/^@+/, '').toLowerCase();
  return v || null;
}
