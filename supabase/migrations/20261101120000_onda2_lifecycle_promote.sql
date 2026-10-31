-- =============================================================================
-- ARK — Onda 2 da vistoria de 31/10/2026 (parte A): regra nova de criação de contato
--
-- Decisão 8 do PLANO-CRM-vistoria-2026-10-31.md: contato só "nasce" (passa a existir
-- para Contatos, filtros, Kanban, métricas e exportação) quando alguém o promove
-- explicitamente, quando é importado/captado com dados, quando ganha um negócio ou
-- quando a pessoa RESPONDE a uma abordagem. Mensagem automática enviada (DM de
-- boas-vindas do Instagram, disparo da Black) sem resposta NÃO vira contato.
--
-- A FK de messaging_conversations exige um registro em contacts, então o registro
-- continua sendo criado; o que muda é a coluna `lifecycle`:
--   'conversa' = só existe para sustentar a conversa (invisível nas telas de contato)
--   'contato'  = contato de verdade
--
-- Default 'contato' para TUDO que já existe e para qualquer porta que não conheça a
-- coluna (importação CSV, webhook-in, API pública, formulário, "Criar e Vincular"):
-- nada some das telas por acidente. Só as edge functions de mensagem (Evolution e
-- Zernio) passam a gravar 'conversa' nos contatos que criam automaticamente.
-- A reclassificação da base atual é um UPDATE separado (onda2_backfill_lifecycle.sql),
-- só com OK do Mauricio, depois do relatório ONDA2-relatorio-reclassificacao.
--
-- Promoção conversa -> contato (RPC promote_contact + 2 triggers):
--   T1  mensagem INBOUND numa conversa que já tinha mensagem OUTBOUND = respondeu a uma
--       abordagem -> promove (motivo 'resposta'). Inbound avulso de desconhecido NÃO
--       promove sozinho: fica em Mensagens com o botão "Enviar para contatos".
--   T2  negócio criado para o contato (routing rule, webhook-in, "Enviar pro Funil",
--       API) -> promove (motivo 'negocio').
--   Botão em Mensagens ("Enviar para contatos" / "Vincular") chama promote_contact direto.
-- =============================================================================

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS lifecycle text NOT NULL DEFAULT 'contato',
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS lifecycle_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_lifecycle_check') THEN
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_lifecycle_check CHECK (lifecycle IN ('conversa', 'contato'));
  END IF;
END $$;

-- As telas filtram por organização + lifecycle + deleted_at IS NULL.
CREATE INDEX IF NOT EXISTS idx_contacts_org_lifecycle
  ON public.contacts (organization_id, lifecycle)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN public.contacts.lifecycle IS
  'conversa = registro que só sustenta uma conversa (não aparece em Contatos); contato = contato de verdade. Promoção via promote_contact().';

-- -----------------------------------------------------------------------------
-- promote_contact(p_contact_id, p_reason): conversa -> contato. Idempotente.
-- SECURITY DEFINER para os triggers e as edge functions; usuário logado só promove
-- contato da própria organização.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.promote_contact(p_contact_id uuid, p_reason text DEFAULT 'manual')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_contact_id IS NULL THEN
    RETURN false;
  END IF;

  -- Usuário autenticado (PostgREST): só a própria organização. service_role/triggers passam direto.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = p_contact_id AND c.organization_id = public.get_user_org_id()
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  UPDATE public.contacts
     SET lifecycle = 'contato',
         lifecycle_changed_at = now(),
         lifecycle_reason = left(coalesce(p_reason, 'manual'), 60)
   WHERE id = p_contact_id
     AND lifecycle = 'conversa'
     AND deleted_at IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.promote_contact(uuid, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- T1: resposta a uma abordagem promove o contato
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_promote_contact_on_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact_id uuid;
BEGIN
  IF NEW.direction <> 'inbound' THEN
    RETURN NEW;
  END IF;

  SELECT mc.contact_id INTO v_contact_id
    FROM public.messaging_conversations mc
   WHERE mc.id = NEW.conversation_id;

  IF v_contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Barato: só segue se o contato ainda é 'conversa'.
  IF NOT EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.id = v_contact_id AND c.lifecycle = 'conversa'
  ) THEN
    RETURN NEW;
  END IF;

  -- "Respondeu a uma abordagem": já existia mensagem nossa nesta conversa.
  IF EXISTS (
    SELECT 1 FROM public.messaging_messages m
     WHERE m.conversation_id = NEW.conversation_id
       AND m.direction = 'outbound'
       AND m.id <> NEW.id
  ) THEN
    PERFORM public.promote_contact(v_contact_id, 'resposta');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promote_contact_on_reply ON public.messaging_messages;
CREATE TRIGGER trg_promote_contact_on_reply
  AFTER INSERT ON public.messaging_messages
  FOR EACH ROW EXECUTE FUNCTION public.trg_promote_contact_on_reply();

-- -----------------------------------------------------------------------------
-- T2: negócio criado promove o contato
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_promote_contact_on_deal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL THEN
    PERFORM public.promote_contact(NEW.contact_id, 'negocio');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_promote_contact_on_deal ON public.deals;
CREATE TRIGGER trg_promote_contact_on_deal
  AFTER INSERT ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.trg_promote_contact_on_deal();

-- -----------------------------------------------------------------------------
-- RPCs de leitura passam a enxergar só 'contato'
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_contact_tag_counts()
RETURNS TABLE(tag text, count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT t.tag, count(*)::bigint AS count
  FROM public.contacts c
  CROSS JOIN LATERAL unnest(c.tags) AS t(tag)
  WHERE c.organization_id = public.get_user_org_id()
    AND c.deleted_at IS NULL
    AND c.lifecycle = 'contato'
    AND btrim(t.tag) <> ''
  GROUP BY t.tag
  ORDER BY count(*) DESC, t.tag;
$$;

CREATE OR REPLACE FUNCTION public.get_dashboard_contact_stats(
  p_start timestamptz,
  p_end timestamptz,
  p_prev_start timestamptz,
  p_prev_end timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH base AS (
    SELECT status, stage, total_value, created_at
    FROM public.contacts
    WHERE organization_id = public.get_user_org_id()
      AND deleted_at IS NULL
      AND lifecycle = 'contato'
  )
  SELECT jsonb_build_object(
    'total',            (SELECT count(*) FROM base),
    'active',           (SELECT count(*) FROM base WHERE status = 'ACTIVE'),
    'inactive',         (SELECT count(*) FROM base WHERE status = 'INACTIVE'),
    'churned',          (SELECT count(*) FROM base WHERE status = 'CHURNED'),
    'total_ltv',        (SELECT coalesce(sum(total_value), 0) FROM base),
    'by_stage',         (SELECT coalesce(jsonb_object_agg(s.stage, s.n), '{}'::jsonb)
                           FROM (SELECT stage, count(*) AS n FROM base WHERE stage IS NOT NULL GROUP BY stage) s),
    'created_current',  (SELECT count(*) FROM base WHERE created_at BETWEEN p_start AND p_end),
    'created_previous', (SELECT count(*) FROM base WHERE created_at BETWEEN p_prev_start AND p_prev_end)
  );
$$;

CREATE OR REPLACE FUNCTION public.get_contact_stage_counts()
RETURNS TABLE (stage TEXT, count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_org_id UUID;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT p.organization_id INTO v_org_id
    FROM public.profiles p
    WHERE p.id = auth.uid();

    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'User has no organization' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        c.stage,
        COUNT(*)::BIGINT AS count
    FROM public.contacts c
    WHERE c.organization_id = v_org_id
      AND c.deleted_at IS NULL
      AND c.lifecycle = 'contato'
    GROUP BY c.stage;
END;
$$;

-- Duplicados: só entre contatos de verdade (os registros 'conversa' entram no merge
-- quando forem promovidos).
CREATE OR REPLACE FUNCTION public.find_duplicate_contacts(p_org_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = auth.uid() AND organization_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  WITH raw_groups AS (
    SELECT
      'phone' as match_type,
      phone as match_value,
      array_agg(id ORDER BY created_at) as contact_ids,
      array_agg(name ORDER BY created_at) as contact_names,
      COUNT(*) as group_size
    FROM contacts
    WHERE organization_id = p_org_id
      AND deleted_at IS NULL
      AND merged_into_id IS NULL
      AND lifecycle = 'contato'
      AND phone IS NOT NULL AND phone != ''
    GROUP BY phone
    HAVING COUNT(*) > 1

    UNION

    SELECT
      'email' as match_type,
      LOWER(email) as match_value,
      array_agg(id ORDER BY created_at) as contact_ids,
      array_agg(name ORDER BY created_at) as contact_names,
      COUNT(*) as group_size
    FROM contacts
    WHERE organization_id = p_org_id
      AND deleted_at IS NULL
      AND merged_into_id IS NULL
      AND lifecycle = 'contato'
      AND email IS NOT NULL AND email != ''
    GROUP BY LOWER(email)
    HAVING COUNT(*) > 1
  )
  SELECT COALESCE(jsonb_agg(row_to_json(g)), '[]'::jsonb)
  INTO v_result
  FROM raw_groups g;

  RETURN v_result;
END;
$$;

NOTIFY pgrst, 'reload schema';
