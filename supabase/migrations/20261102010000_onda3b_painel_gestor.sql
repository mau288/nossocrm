-- ARK Onda 3 / 3.1: painel do gestor (Relatorios > Gestao)
--
-- 1. messaging_conversations.resolved_at: carimbo de quando a conversa foi resolvida
--    (trigger ao mudar status). "Abertas x resolvidas por dia" precisa disso — so
--    existia status, sem data. Backfill unico: as resolvidas de hoje ganham
--    resolved_at = updated_at (aproximacao; 238 linhas em 31/10/2026).
-- 2. Indices parciais para a fila "aguardando resposta" e para resolved_at.
-- 3. RPC get_gestao_painel(org, inicio, fim, sla_minutos, vendedor): um JSON com
--    aguardando (snapshot agora, parada ha mais de X min e menos que a janela,
--                por canal / por vendedor / 20 mais antigas),
--    frt (mediana e media no periodo, por canal / por vendedor),
--    porDia (abertas x resolvidas, fuso America/Sao_Paulo),
--    origem e campanha (contatos que viraram 'contato' no periodo x negocio x ganho).
--    Admin ve tudo e pode filtrar por vendedor; vendedor so ve o proprio
--    (assigned_user_id = auth.uid()) nas tres primeiras partes.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. resolved_at + trigger
-- -----------------------------------------------------------------------------
ALTER TABLE public.messaging_conversations
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

CREATE OR REPLACE FUNCTION public.trg_conversation_resolved_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'resolved' THEN
    IF NEW.resolved_at IS NULL THEN
      NEW.resolved_at := now();
    END IF;
  ELSE
    NEW.resolved_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_conversation_resolved_at ON public.messaging_conversations;
CREATE TRIGGER trg_conversation_resolved_at
  BEFORE INSERT OR UPDATE OF status ON public.messaging_conversations
  FOR EACH ROW EXECUTE FUNCTION public.trg_conversation_resolved_at();

-- Backfill unico (escrita em dados): resolvidas sem carimbo recebem updated_at.
UPDATE public.messaging_conversations
   SET resolved_at = updated_at
 WHERE status = 'resolved' AND resolved_at IS NULL;

-- -----------------------------------------------------------------------------
-- 2. Indices
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_mc_aguardando_resposta
  ON public.messaging_conversations (organization_id, last_message_at)
  WHERE status = 'open' AND last_message_direction = 'inbound';

CREATE INDEX IF NOT EXISTS idx_mc_resolved_at
  ON public.messaging_conversations (organization_id, resolved_at)
  WHERE resolved_at IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 3. RPC get_gestao_painel
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_gestao_painel(
  p_org_id uuid,
  p_start timestamptz,
  p_end timestamptz DEFAULT now(),
  p_sla_minutes integer DEFAULT 30,
  p_user_id uuid DEFAULT NULL,
  p_max_hours integer DEFAULT 168
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role       text;
  v_user       uuid;
  v_sla        interval;
  v_janela     interval;
  v_dia_ini    date;
  v_dia_fim    date;
  v_aguardando jsonb;
  v_frt        jsonb;
  v_por_dia    jsonb;
  v_origem     jsonb;
  v_campanha   jsonb;
BEGIN
  SELECT role INTO v_role
    FROM profiles
   WHERE id = auth.uid() AND organization_id = p_org_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Vendedor so enxerga o que esta atribuido a ele; admin escolhe.
  v_user := CASE WHEN v_role = 'admin' THEN p_user_id ELSE auth.uid() END;

  IF p_start < now() - interval '365 days' THEN
    p_start := now() - interval '365 days';
  END IF;
  v_sla := make_interval(mins => GREATEST(COALESCE(p_sla_minutes, 30), 1));
  -- Janela da fila: conversa parada ha mais que isso e considerada abandonada, nao "aguardando"
  -- (em 31/10 havia DM do Instagram sem resposta ha 78 dias; 7 dias = 55 conversas, 30 = 128, tudo = 397).
  v_janela := make_interval(hours => GREATEST(COALESCE(p_max_hours, 168), 1));
  v_dia_ini := (p_start AT TIME ZONE 'America/Sao_Paulo')::date;
  v_dia_fim := (LEAST(p_end, now()) AT TIME ZONE 'America/Sao_Paulo')::date;

  -- 3a. Aguardando resposta (snapshot de agora: aberta, ultima mensagem do lead, ha mais de X min)
  WITH ag AS (
    SELECT mc.id,
           mc.channel_id,
           mc.assigned_user_id,
           mc.last_message_at,
           mc.last_message_preview,
           COALESCE(NULLIF(c.name, ''), mc.external_contact_name, mc.external_contact_id) AS contact_name,
           ch.name AS channel_name,
           ch.channel_type,
           p.name AS assigned_name,
           EXTRACT(EPOCH FROM (now() - mc.last_message_at)) / 60 AS minutes
      FROM messaging_conversations mc
      JOIN messaging_channels ch ON ch.id = mc.channel_id
      LEFT JOIN contacts c ON c.id = mc.contact_id
      LEFT JOIN profiles p ON p.id = mc.assigned_user_id
     WHERE mc.organization_id = p_org_id
       AND mc.status = 'open'
       AND mc.last_message_direction = 'inbound'
       AND mc.last_message_at < now() - v_sla
       AND mc.last_message_at > now() - v_janela
       AND (v_user IS NULL OR mc.assigned_user_id = v_user)
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM ag),
    'oldestMinutes', COALESCE((SELECT round(max(minutes))::int FROM ag), 0),
    'porCanal', COALESCE((
      SELECT jsonb_agg(x ORDER BY x."count" DESC)
        FROM (SELECT channel_id AS "channelId", channel_name AS "channelName", channel_type AS "channelType",
                     count(*) AS "count", round(max(minutes))::int AS "oldestMinutes"
                FROM ag GROUP BY 1, 2, 3) x), '[]'::jsonb),
    'porVendedor', COALESCE((
      SELECT jsonb_agg(x ORDER BY x."count" DESC)
        FROM (SELECT assigned_user_id AS "userId", COALESCE(assigned_name, 'Sem responsável') AS "name",
                     count(*) AS "count", round(max(minutes))::int AS "oldestMinutes"
                FROM ag GROUP BY 1, 2) x), '[]'::jsonb),
    'lista', COALESCE((
      SELECT jsonb_agg(x)
        FROM (SELECT id AS "conversationId", contact_name AS "contactName", channel_name AS "channelName",
                     channel_type AS "channelType", assigned_name AS "assignedName",
                     round(minutes)::int AS "minutes", left(last_message_preview, 80) AS "preview"
                FROM ag ORDER BY last_message_at ASC LIMIT 20) x), '[]'::jsonb)
  ) INTO v_aguardando;

  -- 3b. Tempo de 1a resposta no periodo (o trigger trg_calculate_frt ja grava os segundos)
  WITH f AS (
    SELECT mc.first_response_seconds AS s,
           mc.channel_id, ch.name AS channel_name, ch.channel_type,
           mc.assigned_user_id, p.name AS assigned_name
      FROM messaging_conversations mc
      JOIN messaging_channels ch ON ch.id = mc.channel_id
      LEFT JOIN profiles p ON p.id = mc.assigned_user_id
     WHERE mc.organization_id = p_org_id
       AND mc.first_response_at >= p_start
       AND mc.first_response_at <= p_end
       AND mc.first_response_seconds IS NOT NULL
       AND (v_user IS NULL OR mc.assigned_user_id = v_user)
  )
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM f),
    'medianSeconds', COALESCE((SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY s) FROM f), 0)::int,
    'avgSeconds', COALESCE((SELECT avg(s) FROM f), 0)::int,
    'porCanal', COALESCE((
      SELECT jsonb_agg(x ORDER BY x."count" DESC)
        FROM (SELECT channel_id AS "channelId", channel_name AS "channelName", channel_type AS "channelType",
                     count(*) AS "count",
                     (percentile_cont(0.5) WITHIN GROUP (ORDER BY s))::int AS "medianSeconds",
                     avg(s)::int AS "avgSeconds"
                FROM f GROUP BY 1, 2, 3) x), '[]'::jsonb),
    'porVendedor', COALESCE((
      SELECT jsonb_agg(x ORDER BY x."count" DESC)
        FROM (SELECT assigned_user_id AS "userId", COALESCE(assigned_name, 'Sem responsável') AS "name",
                     count(*) AS "count",
                     (percentile_cont(0.5) WITHIN GROUP (ORDER BY s))::int AS "medianSeconds",
                     avg(s)::int AS "avgSeconds"
                FROM f GROUP BY 1, 2) x), '[]'::jsonb)
  ) INTO v_frt;

  -- 3c. Abertas x resolvidas por dia (dia local de Sao Paulo)
  SELECT COALESCE(jsonb_agg(
           jsonb_build_object('dia', to_char(d.dia, 'YYYY-MM-DD'),
                              'abertas', COALESCE(a.n, 0),
                              'resolvidas', COALESCE(r.n, 0))
           ORDER BY d.dia), '[]'::jsonb)
    INTO v_por_dia
    FROM (SELECT gs::date AS dia
            FROM generate_series(v_dia_ini::timestamp, v_dia_fim::timestamp, interval '1 day') gs) d
    LEFT JOIN (SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia, count(*) AS n
                 FROM messaging_conversations
                WHERE organization_id = p_org_id
                  AND created_at >= p_start AND created_at <= p_end
                  AND (v_user IS NULL OR assigned_user_id = v_user)
                GROUP BY 1) a ON a.dia = d.dia
    LEFT JOIN (SELECT (resolved_at AT TIME ZONE 'America/Sao_Paulo')::date AS dia, count(*) AS n
                 FROM messaging_conversations
                WHERE organization_id = p_org_id
                  AND resolved_at >= p_start AND resolved_at <= p_end
                  AND (v_user IS NULL OR assigned_user_id = v_user)
                GROUP BY 1) r ON r.dia = d.dia;

  -- 3d. Leads por origem x conversao (contatos que viraram 'contato' no periodo)
  WITH ct AS (
    SELECT c.id,
           COALESCE(NULLIF(c.source, ''),
                    (SELECT substr(t, 8) FROM unnest(c.tags) t WHERE t LIKE 'origem:%' LIMIT 1),
                    'sem origem') AS origem,
           c.tags
      FROM contacts c
     WHERE c.organization_id = p_org_id
       AND c.deleted_at IS NULL
       AND c.lifecycle = 'contato'
       AND COALESCE(c.lifecycle_changed_at, c.created_at) >= p_start
       AND COALESCE(c.lifecycle_changed_at, c.created_at) <= p_end
  ), dl AS (
    SELECT d.contact_id,
           bool_or(d.is_won) AS won,
           sum(CASE WHEN d.is_won THEN COALESCE(d.value, 0) ELSE 0 END) AS won_value
      FROM deals d
     WHERE d.organization_id = p_org_id
       AND d.deleted_at IS NULL
       AND d.contact_id IN (SELECT id FROM ct)
     GROUP BY d.contact_id
  ), por_origem AS (
    SELECT ct.origem,
           count(*) AS contatos,
           count(dl.contact_id) AS com_negocio,
           count(*) FILTER (WHERE dl.won) AS ganhos,
           COALESCE(sum(dl.won_value), 0) AS valor_ganho
      FROM ct LEFT JOIN dl ON dl.contact_id = ct.id
     GROUP BY ct.origem
  ), por_campanha AS (
    SELECT tg.tag AS campanha,
           count(*) AS contatos,
           count(dl.contact_id) AS com_negocio,
           count(*) FILTER (WHERE dl.won) AS ganhos,
           COALESCE(sum(dl.won_value), 0) AS valor_ganho
      FROM ct
      JOIN LATERAL (SELECT DISTINCT t AS tag FROM unnest(ct.tags) t
                     WHERE t LIKE 'funil:%' OR t LIKE 'edicao:%' OR t LIKE 'campanha:%' OR t LIKE 'lista:%') tg ON true
      LEFT JOIN dl ON dl.contact_id = ct.id
     GROUP BY tg.tag
  )
  SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('origem', origem, 'contatos', contatos, 'comNegocio', com_negocio,
                                                  'ganhos', ganhos, 'valorGanho', valor_ganho)
                               ORDER BY contatos DESC) FROM por_origem), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_object('campanha', campanha, 'contatos', contatos, 'comNegocio', com_negocio,
                                                  'ganhos', ganhos, 'valorGanho', valor_ganho)
                               ORDER BY contatos DESC) FROM por_campanha), '[]'::jsonb)
    INTO v_origem, v_campanha;

  RETURN jsonb_build_object(
    'aguardando', v_aguardando,
    'frt', v_frt,
    'porDia', v_por_dia,
    'origem', v_origem,
    'campanha', v_campanha,
    'slaMinutes', GREATEST(COALESCE(p_sla_minutes, 30), 1),
    'maxHours', GREATEST(COALESCE(p_max_hours, 168), 1),
    'scopeUserId', v_user,
    'isAdmin', (v_role = 'admin'),
    'geradoEm', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_gestao_painel(uuid, timestamptz, timestamptz, integer, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gestao_painel(uuid, timestamptz, timestamptz, integer, uuid, integer) TO authenticated;

COMMIT;
