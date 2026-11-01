-- ARK Onda 3 / ajuste (01/11/2026): alerta "aguardando resposta" em horarios fixos.
--
-- Pedido do Mauricio: o resumo de conversas paradas chegava de hora em hora (cooldown de 60 min
-- em horario comercial). Ele quer 2 vezes ao dia, por volta das 9h e das 20h, e a mensagem
-- listando nome/telefone de quem esta pendente.
--
-- gestao_alert_settings.waiting_hours: horas (America/Sao_Paulo, 0-23) em que o resumo sai.
--   NULL ou vazio = modo antigo (a cada cooldown_minutes dentro do horario comercial).
--   Preenchido    = 1 envio por hora listada, por dia (fingerprint 'AAAA-MM-DD:HH' no log),
--                   ignorando hours_start/hours_end; "so dias uteis" continua valendo.
-- A edge function gestao-alertas (v2) le a coluna; a tela em Relatorios > Gestao edita.

BEGIN;

ALTER TABLE public.gestao_alert_settings
  ADD COLUMN IF NOT EXISTS waiting_hours integer[];

ALTER TABLE public.gestao_alert_settings
  DROP CONSTRAINT IF EXISTS gestao_alert_settings_waiting_hours_check;
ALTER TABLE public.gestao_alert_settings
  ADD CONSTRAINT gestao_alert_settings_waiting_hours_check
  CHECK (
    waiting_hours IS NULL
    OR waiting_hours <@ ARRAY[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]
  );

COMMENT ON COLUMN public.gestao_alert_settings.waiting_hours IS
  'Horas (BRT) em que o resumo "aguardando resposta" sai, 1x por hora listada. NULL = modo cooldown.';

-- ArkAcademy: 9h e 20h (pedido de 01/11/2026).
UPDATE public.gestao_alert_settings
   SET waiting_hours = ARRAY[9, 20]
 WHERE organization_id = '41a996f9-6894-4b33-af05-67bd6436b7b9';

COMMIT;
