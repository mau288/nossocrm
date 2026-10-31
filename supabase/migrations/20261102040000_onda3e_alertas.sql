-- ARK Onda 3 / 3.4: alertas do gestor no WhatsApp.
--
-- Decisao do Mauricio (31/10/2026): Mauricio + Verena recebem no WhatsApp, enviado por um chip
-- da Evolution ja ligado ao CRM. Tres gatilhos: conversa aguardando resposta (resumo por canal,
-- no maximo 1 por hora, em horario comercial), erro de webhook (N erros em 10 min) e meta em
-- risco (funil ou vendedor abaixo de 80% do ritmo esperado, 1 por dia).
--
-- gestao_alert_settings: 1 linha por org (quem recebe, por qual chip, limites, horarios).
-- gestao_alert_log: cada envio (ou tentativa), usado para o cooldown e para a tela.
-- pg_cron chama a edge function gestao-alertas a cada 10 min, com o mesmo segredo do job
-- scheduled-messages-dispatch (lido do proprio cron.job, para nao gravar segredo no git).
-- De carona: limpeza diaria de cron.job_run_details (49.549 linhas / 23 MB em 31/10, +1/min),
-- lembrando o incidente de disco de 26/09.

BEGIN;

CREATE TABLE IF NOT EXISTS public.gestao_alert_settings (
  organization_id          uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled                  boolean NOT NULL DEFAULT false,
  channel_id               uuid REFERENCES public.messaging_channels(id) ON DELETE SET NULL,  -- chip Evolution que envia
  recipients               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{"name": "...", "phone": "5511999999999"}]
  alert_waiting            boolean NOT NULL DEFAULT true,
  alert_webhook            boolean NOT NULL DEFAULT true,
  alert_goals              boolean NOT NULL DEFAULT true,
  sla_minutes              integer NOT NULL DEFAULT 30 CHECK (sla_minutes BETWEEN 5 AND 1440),
  max_hours                integer NOT NULL DEFAULT 24 CHECK (max_hours BETWEEN 1 AND 720),
  hours_start              integer NOT NULL DEFAULT 8  CHECK (hours_start BETWEEN 0 AND 23),
  hours_end                integer NOT NULL DEFAULT 20 CHECK (hours_end BETWEEN 1 AND 24),
  weekdays_only            boolean NOT NULL DEFAULT false,
  webhook_error_threshold  integer NOT NULL DEFAULT 3 CHECK (webhook_error_threshold BETWEEN 1 AND 100),
  cooldown_minutes         integer NOT NULL DEFAULT 60 CHECK (cooldown_minutes BETWEEN 10 AND 1440),
  goals_hour               integer NOT NULL DEFAULT 9 CHECK (goals_hour BETWEEN 0 AND 23),
  updated_by               uuid,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS gestao_alert_settings_updated_at ON public.gestao_alert_settings;
CREATE TRIGGER gestao_alert_settings_updated_at
  BEFORE UPDATE ON public.gestao_alert_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.gestao_alert_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  alert_type       text NOT NULL CHECK (alert_type IN ('waiting', 'webhook', 'goals', 'test')),
  fingerprint      text,
  message          text NOT NULL,
  recipients       jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_ok          boolean NOT NULL DEFAULT false,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gestao_alert_log_org_type_idx
  ON public.gestao_alert_log (organization_id, alert_type, created_at DESC);

ALTER TABLE public.gestao_alert_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gestao_alert_log ENABLE ROW LEVEL SECURITY;

-- Configuracao: admin le e escreve (service_role da edge function passa por cima da RLS).
DROP POLICY IF EXISTS gestao_alert_settings_admin ON public.gestao_alert_settings;
CREATE POLICY gestao_alert_settings_admin ON public.gestao_alert_settings
  FOR ALL TO authenticated
  USING (
    organization_id = get_user_org_id()
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  )
  WITH CHECK (
    organization_id = get_user_org_id()
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- Log: admin so le; quem grava e a edge function (service_role).
DROP POLICY IF EXISTS gestao_alert_log_admin_read ON public.gestao_alert_log;
CREATE POLICY gestao_alert_log_admin_read ON public.gestao_alert_log
  FOR SELECT TO authenticated
  USING (
    organization_id = get_user_org_id()
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- -----------------------------------------------------------------------------
-- pg_cron: verificacao a cada 10 min + limpeza diaria do log do cron
-- -----------------------------------------------------------------------------
DO $c$
DECLARE
  v_secret text;
  v_cmd    text;
BEGIN
  -- Reaproveita o segredo do job existente (header x-dispatch-secret), sem gravar no git.
  SELECT substring(command FROM 'x-dispatch-secret'', ''([0-9a-f]+)''')
    INTO v_secret
    FROM cron.job
   WHERE jobname = 'scheduled-messages-dispatch'
   LIMIT 1;

  IF v_secret IS NULL OR v_secret = '' THEN
    RAISE EXCEPTION 'segredo do job scheduled-messages-dispatch nao encontrado em cron.job';
  END IF;

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'gestao-alertas';

  v_cmd := format(
    $f$SELECT net.http_post(
      url := %L,
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-dispatch-secret', %L),
      body := '{}'::jsonb
    );$f$,
    'https://vzqwkckbkwtrowyykmmf.supabase.co/functions/v1/gestao-alertas',
    v_secret
  );
  PERFORM cron.schedule('gestao-alertas', '*/10 * * * *', v_cmd);

  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'cron-job-run-details-cleanup';
  PERFORM cron.schedule(
    'cron-job-run-details-cleanup',
    '0 6 * * *',   -- 06:00 UTC = 03:00 BRT
    $q$DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'$q$
  );
END
$c$;

COMMIT;
