/**
 * Sugestões padrão de tags do Ark Academy.
 *
 * Convenção de prefixos (o que mantém o filtro dos funis organizado):
 *  - `produto:` — qual produto aquele negócio persegue
 *  - `edicao:`  — turma/edição de um evento ou lançamento
 *  - `funil:`   — origem do lead (de onde ele veio)
 *
 * A lista é só um ponto de partida: qualquer tag nova digitada pelo operador
 * continua valendo e entra no catálogo local (`crm_tags`).
 */

export const TAG_SUGGESTIONS_PRODUTO = [
  'produto:comunidade',
  'produto:pos',
  'produto:integrador',
  'produto:python',
  'produto:controle',
  'produto:ladder',
  'produto:guia-clp',
  'produto:acervo',
] as const;

export const TAG_SUGGESTIONS_EDICAO = [
  'edicao:lancamento-classico',
  'edicao:lancamento-pago',
  'edicao:imersao',
] as const;

export const TAG_SUGGESTIONS_FUNIL = [
  'funil:live-semanal',
  'funil:bio',
  'funil:manychat',
  'funil:lancamento-classico',
  'funil:lancamento-gratuito',
  'funil:lancamento-pago',
  'funil:imersao',
  'funil:perpetuo',
  'funil:low-ticket',
  'funil:live-pos',
  'funil:social-seller',
  'funil:agendamento-direto',
  'funil:indicacao',
] as const;

/** Todas as sugestões padrão, na ordem em que fazem sentido no autocomplete. */
export const TAG_SUGGESTIONS_DEFAULT: string[] = [
  ...TAG_SUGGESTIONS_PRODUTO,
  ...TAG_SUGGESTIONS_EDICAO,
  ...TAG_SUGGESTIONS_FUNIL,
];
