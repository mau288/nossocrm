/**
 * Formatador de texto no padrão WhatsApp (ARK, Onda 0 / 0.3).
 *
 * O WhatsApp (e o Instagram, via Zernio) entregam o texto cru com marcadores:
 *   *negrito*  _itálico_  ~tachado~  `mono`  ```bloco```  e links soltos.
 * Antes a bolha mostrava os asteriscos. Aqui o texto vira React nodes, e
 * `stripWhatsAppMarkup` devolve a versão limpa para prévias (lista, citação).
 *
 * Regras (as mesmas do WhatsApp):
 *  - o marcador de abertura precisa estar colado ao texto (`* negrito*` não vale);
 *  - fora do marcador precisa haver início/fim, espaço ou pontuação (snake_case e
 *    2*3*4 continuam literais);
 *  - negrito/itálico/tachado aninham entre si; mono não formata por dentro;
 *  - links: http(s):// e www. viram <a> (só esses esquemas — nada de javascript:).
 */
import React from 'react';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'text'; value: string }
  | { kind: 'link'; href: string; label: string }
  | { kind: 'mono'; value: string }
  | { kind: 'code'; value: string }
  | { kind: 'bold' | 'italic' | 'strike'; children: Token[] };

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]|www\.[^\s<>()]+[^\s<>().,;:!?'"\]])/i;

// Marcadores inline. Lookbehind: antes do abridor não pode vir letra/número nem outro
// marcador igual; lookahead: depois do fechador não pode vir letra/número.
const INLINE_SRC =
  [
    '(?<![\\p{L}\\p{N}*])\\*(?=\\S)([^*\\n]*?\\S)\\*(?![\\p{L}\\p{N}])',        // 1: bold
    '(?<![\\p{L}\\p{N}_])_(?=\\S)([^_\\n]*?\\S)_(?![\\p{L}\\p{N}])',           // 2: italic
    '(?<![\\p{L}\\p{N}~])~(?=\\S)([^~\\n]*?\\S)~(?![\\p{L}\\p{N}])',           // 3: strike
    '`([^`\\n]+)`',                                                            // 4: mono
    URL_RE.source,                                                             // 5: link
  ].join('|');
// Uma instancia NOVA por chamada: a funcao e recursiva e um RegExp global compartilhado
// teria o lastIndex zerado pela chamada interna.
const inlineRe = () => new RegExp(INLINE_SRC, 'giu');

function tokenizeInline(text: string, depth = 0): Token[] {
  const out: Token[] = [];
  if (!text) return out;
  // Mais de 3 níveis = texto malformado; devolve literal para não travar.
  if (depth > 3) return [{ kind: 'text', value: text }];

  let last = 0;
  const re = inlineRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', value: text.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'bold', children: tokenizeInline(m[1], depth + 1) });
    else if (m[2] !== undefined) out.push({ kind: 'italic', children: tokenizeInline(m[2], depth + 1) });
    else if (m[3] !== undefined) out.push({ kind: 'strike', children: tokenizeInline(m[3], depth + 1) });
    else if (m[4] !== undefined) out.push({ kind: 'mono', value: m[4] });
    else if (m[5] !== undefined) {
      const raw = m[5];
      const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
      out.push({ kind: 'link', href, label: raw });
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // segurança contra loop infinito
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

/** Separa blocos ```código``` (podem ter várias linhas) do resto. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const parts = text.split(/```([\s\S]*?)```/);
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) out.push({ kind: 'code', value: part.replace(/^\n+|\n+$/g, '') });
    else out.push(...tokenizeInline(part));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function renderTokens(tokens: Token[], keyPrefix = 'w'): React.ReactNode[] {
  return tokens.map((t, i) => {
    const key = `${keyPrefix}${i}`;
    switch (t.kind) {
      case 'text':
        return <React.Fragment key={key}>{t.value}</React.Fragment>;
      case 'bold':
        return <strong key={key} className="font-semibold">{renderTokens(t.children, key)}</strong>;
      case 'italic':
        return <em key={key}>{renderTokens(t.children, key)}</em>;
      case 'strike':
        return <s key={key}>{renderTokens(t.children, key)}</s>;
      case 'mono':
        return (
          <code key={key} className="font-mono text-[0.9em] px-1 rounded bg-black/10 dark:bg-white/10">
            {t.value}
          </code>
        );
      case 'code':
        return (
          <pre key={key} className="font-mono text-[0.85em] my-1 p-2 rounded-md bg-black/10 dark:bg-white/10 overflow-x-auto whitespace-pre-wrap">
            {t.value}
          </pre>
        );
      case 'link':
        return (
          <a
            key={key}
            href={t.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="underline underline-offset-2 break-all hover:opacity-80"
          >
            {t.label}
          </a>
        );
      default:
        return null;
    }
  });
}

/**
 * Texto do WhatsApp → React (negrito, itálico, tachado, mono, bloco e links).
 * Quebras de linha são preservadas pelo `whitespace-pre-wrap` do container.
 */
export function renderWhatsAppText(text: string | null | undefined): React.ReactNode {
  if (!text) return null;
  // Atalho: sem nenhum marcador nem link, devolve a string como está (zero custo).
  if (!/[*_~`]|https?:\/\/|www\./i.test(text)) return text;
  return renderTokens(tokenize(text));
}

/** Componente de conveniência. */
export const WhatsAppText = React.memo(function WhatsAppText({
  text,
  className,
}: {
  text: string | null | undefined;
  className?: string;
}) {
  return <span className={className}>{renderWhatsAppText(text)}</span>;
});

// ---------------------------------------------------------------------------
// Prévia (texto limpo)
// ---------------------------------------------------------------------------

function flatten(tokens: Token[]): string {
  return tokens
    .map((t) => {
      switch (t.kind) {
        case 'text':
        case 'mono':
        case 'code':
          return t.value;
        case 'link':
          return t.label;
        default:
          return flatten(t.children);
      }
    })
    .join('');
}

/** Remove os marcadores (*_~`) para prévia da lista e citações. */
export function stripWhatsAppMarkup(text: string | null | undefined): string {
  if (!text) return '';
  if (!/[*_~`]/.test(text)) return text;
  return flatten(tokenize(text));
}
