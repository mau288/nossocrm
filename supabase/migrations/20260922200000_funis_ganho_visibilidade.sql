-- Funis: etapa de ganho/perda explicita + "Matriculado" padronizado + "No-show" na Consultiva
-- Plano: PLANO-CRM-funis-2026-09-22.md (Entrega 1, Passo 2)
--
-- Por que: os 3 boards foram criados sem won_stage_id/lost_stage_id, entao o botao GANHO cai no
-- fallback (marca is_won e NAO move o card). Aqui a etapa final de cada funil fica declarada.
--
-- Esta migration mexe em dados de uma instancia especifica (os UUIDs sao do org 41a996f9).
-- Em banco novo todo comando vira no-op: os UPDATE nao acham linha e os INSERT sao guardados
-- por EXISTS no board. Tambem e idempotente: rodar duas vezes nao duplica nada.

BEGIN;

-- 2.1 Formacoes: Matriculado = ganho, Nao comprou = perda (etapas ja existem com o nome certo)
UPDATE boards SET
  won_stage_id  = '639789ad-94ac-46bc-aba6-35af827e020d',
  lost_stage_id = '6b034bf5-a073-45b3-ad29-acbe3430afed'
WHERE id = 'f78c3072-35b8-4c74-96db-a44f0ea6a26a';

-- 2.2 Consultiva (Call): "Fechado" passa a se chamar "Matriculado"
UPDATE board_stages SET name = 'Matriculado', label = 'Matriculado'
WHERE id = '45cec45c-abcb-4981-8e2d-7497354397a6';

UPDATE boards SET
  won_stage_id  = '45cec45c-abcb-4981-8e2d-7497354397a6',
  lost_stage_id = 'ad396cb7-a513-4ea3-89bd-d9229a2fbdb6'
WHERE id = 'ada80196-8726-4bc5-8757-5de31039db09';

-- 2.3 Eventos & Lancamentos: "Converteu" -> "Matriculado"; "Nao compareceu" -> "Nao comprou"
UPDATE board_stages SET name = 'Matriculado', label = 'Matriculado'
WHERE id = 'ca39a014-69b8-4033-b910-e46266614cdd';

UPDATE board_stages SET name = 'Não comprou', label = 'Não comprou'
WHERE id = '042e8ea2-b6f2-4bef-b895-c84fbe63e9ef';

UPDATE boards SET
  won_stage_id  = 'ca39a014-69b8-4033-b910-e46266614cdd',
  lost_stage_id = '042e8ea2-b6f2-4bef-b895-c84fbe63e9ef'
WHERE id = '796a21fe-16a3-4739-9f96-a541bdfa70f4';

-- 2.4 Consultiva: nova etapa "No-show" na posicao 2 (entre 1a1 agendada e 1a1 realizada).
-- Fila de reagendamento: etapa comum do pipeline, NAO e perda (a perda continua sendo so "Perdido"),
-- por isso linked_lifecycle_stage fica NULL.
-- Abre espaco reordenando de tras para frente, para nunca colidir no "order".
UPDATE board_stages SET "order" = 7 WHERE id = 'ad396cb7-a513-4ea3-89bd-d9229a2fbdb6'; -- Perdido      6->7
UPDATE board_stages SET "order" = 6 WHERE id = '45cec45c-abcb-4981-8e2d-7497354397a6'; -- Matriculado  5->6
UPDATE board_stages SET "order" = 5 WHERE id = '8155af9e-91e8-4336-958e-0da01b0af498'; -- Negociacao   4->5
UPDATE board_stages SET "order" = 4 WHERE id = '7c69fba3-2084-4eea-bc82-1c6af254dcc5'; -- Proposta     3->4
UPDATE board_stages SET "order" = 3 WHERE id = '27422dba-5f45-4991-ba7c-12826d20cbe0'; -- 1a1 realizada 2->3

INSERT INTO board_stages (id, board_id, name, label, color, "order", is_default, linked_lifecycle_stage, organization_id)
SELECT '8074cf7f-191f-4dc9-a1de-f9e62781c875',
       b.id, 'No-show', 'No-show', 'bg-amber-500', 2, false, NULL, b.organization_id
FROM boards b
WHERE b.id = 'ada80196-8726-4bc5-8757-5de31039db09'
  AND NOT EXISTS (SELECT 1 FROM board_stages WHERE id = '8074cf7f-191f-4dc9-a1de-f9e62781c875');

COMMIT;
