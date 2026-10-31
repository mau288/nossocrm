-- =============================================================================
-- ARK — Onda 2 da vistoria de 31/10/2026 (parte B): identidade única de contato
--
-- Problema (seção 0 do PLANO-CRM-vistoria-2026-10-31.md): 7 portas criavam contato,
-- cada uma do seu jeito — telefone sem a regra do 9º dígito (515 BR com 12 dígitos e
-- 313 com 13), Instagram/TikTok com 1 contato por conversa (sem @), importação só
-- deduplicando por e-mail, origem perdida, merge que não juntava tags.
--
-- Solução: UMA porta — `upsert_contact_identity(...)` — usada por webhooks (Evolution,
-- Zernio), webhook-in, importação, API pública, formulário, "criar e vincular" e
-- "Enviar pro Funil". Ela:
--   1) normaliza telefone em E.164 canônico (BR celular SEMPRE com o 9);
--   2) procura por telefone (canônico OU variante sem 9), e-mail, @instagram, @tiktok;
--   3) se achar: completa campos vazios, promove nome genérico/telefone para nome
--      real, soma tags, grava `origem:<canal>` se ainda não tem, e promove
--      conversa -> contato quando a porta é de contato (importação, captação, manual);
--   4) se não achar: cria com source, tag origem:<canal> e o lifecycle da porta.
-- Nada de IA aqui (Onda 4).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. @ do Instagram / TikTok no contato (hoje só vive no metadata da conversa)
-- -----------------------------------------------------------------------------
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS instagram_username text,
  ADD COLUMN IF NOT EXISTS tiktok_username text;

CREATE INDEX IF NOT EXISTS idx_contacts_org_instagram
  ON public.contacts (organization_id, lower(instagram_username))
  WHERE instagram_username IS NOT NULL AND deleted_at IS NULL AND merged_into_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_org_tiktok
  ON public.contacts (organization_id, lower(tiktok_username))
  WHERE tiktok_username IS NOT NULL AND deleted_at IS NULL AND merged_into_id IS NULL;

COMMENT ON COLUMN public.contacts.instagram_username IS 'ARK (Onda 2B): @ do Instagram sem arroba, minúsculo. Chave de dedup das DMs.';
COMMENT ON COLUMN public.contacts.tiktok_username IS 'ARK (Onda 2B): @ do TikTok sem arroba, minúsculo. Chave de dedup das DMs.';

-- -----------------------------------------------------------------------------
-- 2. Telefone: E.164 canônico com a regra do 9º dígito
--    '+5511987654321' | '11 98765-4321' | '5511987654321' | '011987654321' | '+551187654321'
--    -> '+5511987654321'. Fixo BR (1º dígito local 2-5) fica com 8 dígitos. Fora do BR: só limpa.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_phone_e164(p_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw    text := coalesce(p_phone, '');
  v_digits text;
  v_intl   boolean;
  v_local  text;
BEGIN
  v_digits := regexp_replace(v_raw, '\D', '', 'g');
  IF v_digits = '' THEN
    RETURN NULL;
  END IF;

  v_intl := left(btrim(v_raw), 1) = '+' OR left(v_digits, 2) = '00';
  IF left(v_digits, 2) = '00' THEN
    v_digits := substr(v_digits, 3);
  END IF;

  -- Sem '+': 10/11 dígitos = número BR sem DDI; 0 + DDD = tronco nacional.
  IF NOT v_intl THEN
    IF left(v_digits, 1) = '0' AND length(v_digits) IN (11, 12) THEN
      v_digits := substr(v_digits, 2);
    END IF;
    IF length(v_digits) IN (10, 11) THEN
      v_digits := '55' || v_digits;
    END IF;
  END IF;

  -- Brasil: +55 DD + 8 ou 9 dígitos. Celular (1º dígito local 6-9) sempre com o 9.
  IF left(v_digits, 2) = '55' AND length(v_digits) IN (12, 13) THEN
    v_local := substr(v_digits, 5);
    IF length(v_local) = 8 AND substr(v_local, 1, 1) BETWEEN '6' AND '9' THEN
      v_digits := substr(v_digits, 1, 4) || '9' || v_local;
    END IF;
  END IF;

  RETURN '+' || v_digits;
END;
$$;

-- Variantes para PROCURAR (o banco antigo tem BR sem 9, sem '+', etc.)
CREATE OR REPLACE FUNCTION public.phone_lookup_variants(p_phone text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_canon text := public.normalize_phone_e164(p_phone);
  v_out   text[];
  v_local text;
  v_no9   text;
BEGIN
  IF v_canon IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;
  v_out := ARRAY[v_canon, substr(v_canon, 2)];
  IF left(v_canon, 3) = '+55' AND length(v_canon) = 14 THEN
    v_local := substr(v_canon, 6);
    IF left(v_local, 1) = '9' THEN
      v_no9 := substr(v_canon, 1, 5) || substr(v_local, 2);
      v_out := v_out || ARRAY[v_no9, substr(v_no9, 2)];
    END IF;
  END IF;
  -- o valor cru também (ex.: '(11) 98765-4321' gravado à mão)
  IF btrim(coalesce(p_phone, '')) <> '' AND NOT (btrim(p_phone) = ANY (v_out)) THEN
    v_out := v_out || ARRAY[btrim(p_phone)];
  END IF;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.normalize_social_username(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT nullif(lower(regexp_replace(btrim(coalesce(p, '')), '^@+', '')), '');
$$;

-- -----------------------------------------------------------------------------
-- 3. A porta única
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_contact_identity(
  p_organization_id    uuid,
  p_name               text DEFAULT NULL,
  p_phone              text DEFAULT NULL,
  p_email              text DEFAULT NULL,
  p_instagram_username text DEFAULT NULL,
  p_tiktok_username    text DEFAULT NULL,
  p_source             text DEFAULT NULL,
  p_channel            text DEFAULT 'manual',
  p_tags               text[] DEFAULT NULL,
  p_lifecycle          text DEFAULT 'contato',
  p_avatar             text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_phone      text := public.normalize_phone_e164(p_phone);
  v_variants   text[] := public.phone_lookup_variants(p_phone);
  v_email      text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  v_ig         text := public.normalize_social_username(p_instagram_username);
  v_tt         text := public.normalize_social_username(p_tiktok_username);
  v_channel    text := nullif(lower(btrim(coalesce(p_channel, ''))), '');
  v_name       text := nullif(btrim(coalesce(p_name, '')), '');
  v_tags       text[] := ARRAY[]::text[];
  v_origem_tag text;
  v_lifecycle  text := CASE WHEN p_lifecycle = 'conversa' THEN 'conversa' ELSE 'contato' END;
  v_existing   public.contacts%ROWTYPE;
  v_matched_by text := NULL;
  v_new_id     uuid;
  v_t          text;
  v_name_is_real boolean;
  v_old_name_generic boolean;
  v_promoted   boolean := false;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'organization_id obrigatório';
  END IF;
  IF auth.uid() IS NOT NULL AND p_organization_id <> public.get_user_org_id() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;
  IF v_channel IS NULL THEN
    v_channel := 'manual';
  END IF;
  v_origem_tag := 'origem:' || v_channel;

  -- tags de entrada limpas, sem repetição (case-insensitive)
  IF p_tags IS NOT NULL THEN
    FOREACH v_t IN ARRAY p_tags LOOP
      v_t := left(btrim(coalesce(v_t, '')), 40);
      IF v_t <> '' AND NOT EXISTS (SELECT 1 FROM unnest(v_tags) x WHERE lower(x) = lower(v_t)) THEN
        v_tags := v_tags || v_t;
      END IF;
    END LOOP;
  END IF;

  -- nome "real" = não é vazio, não é placeholder, não é o próprio telefone
  v_name_is_real := v_name IS NOT NULL
    AND v_name !~* '^contato do '
    AND v_name NOT IN ('Lead', 'Sem nome')
    AND regexp_replace(v_name, '\D', '', 'g') <> coalesce(substr(v_phone, 2), '')
    AND NOT (v_name ~ '^\+?[0-9 ()\-]+$');

  -- ---------------------------------------------------------------------------
  -- Procura (ordem: telefone -> e-mail -> @instagram -> @tiktok). Prefere quem já é
  -- 'contato' e o mais antigo.
  -- ---------------------------------------------------------------------------
  IF cardinality(v_variants) > 0 THEN
    SELECT c.* INTO v_existing FROM public.contacts c
     WHERE c.organization_id = p_organization_id AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
       AND c.phone = ANY (v_variants)
     ORDER BY (c.lifecycle = 'contato') DESC, c.created_at
     LIMIT 1;
    IF FOUND THEN v_matched_by := 'phone'; END IF;
  END IF;
  IF v_matched_by IS NULL AND v_email IS NOT NULL THEN
    SELECT c.* INTO v_existing FROM public.contacts c
     WHERE c.organization_id = p_organization_id AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
       AND lower(c.email) = v_email
     ORDER BY (c.lifecycle = 'contato') DESC, c.created_at
     LIMIT 1;
    IF FOUND THEN v_matched_by := 'email'; END IF;
  END IF;
  IF v_matched_by IS NULL AND v_ig IS NOT NULL THEN
    SELECT c.* INTO v_existing FROM public.contacts c
     WHERE c.organization_id = p_organization_id AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
       AND lower(c.instagram_username) = v_ig
     ORDER BY (c.lifecycle = 'contato') DESC, c.created_at
     LIMIT 1;
    IF FOUND THEN v_matched_by := 'instagram'; END IF;
  END IF;
  IF v_matched_by IS NULL AND v_tt IS NOT NULL THEN
    SELECT c.* INTO v_existing FROM public.contacts c
     WHERE c.organization_id = p_organization_id AND c.deleted_at IS NULL AND c.merged_into_id IS NULL
       AND lower(c.tiktok_username) = v_tt
     ORDER BY (c.lifecycle = 'contato') DESC, c.created_at
     LIMIT 1;
    IF FOUND THEN v_matched_by := 'tiktok'; END IF;
  END IF;

  -- ---------------------------------------------------------------------------
  -- Achou: completa, promove nome, soma tags, carimba origem, promove lifecycle
  -- ---------------------------------------------------------------------------
  IF v_matched_by IS NOT NULL THEN
    v_old_name_generic := v_existing.name IS NULL OR btrim(v_existing.name) = ''
      OR v_existing.name ~* '^contato do ' OR v_existing.name IN ('Lead', 'Sem nome')
      OR v_existing.name ~ '^\+?[0-9 ()\-]+$';

    UPDATE public.contacts c SET
      name = CASE WHEN v_name_is_real AND v_old_name_generic THEN v_name ELSE c.name END,
      -- telefone: preenche se vazio; se era a variante sem 9 (ou sem '+'), passa ao canônico
      phone = CASE
                WHEN v_phone IS NOT NULL AND (c.phone IS NULL OR c.phone = '' OR (v_matched_by = 'phone' AND c.phone <> v_phone))
                  THEN v_phone
                ELSE c.phone
              END,
      email = CASE WHEN v_email IS NOT NULL AND (c.email IS NULL OR c.email = '') THEN v_email ELSE c.email END,
      instagram_username = coalesce(c.instagram_username, v_ig),
      tiktok_username = coalesce(c.tiktok_username, v_tt),
      source = coalesce(nullif(c.source, ''), nullif(btrim(coalesce(p_source, '')), ''), v_channel),
      avatar = coalesce(nullif(c.avatar, ''), nullif(btrim(coalesce(p_avatar, '')), '')),
      tags = (
        SELECT coalesce(array_agg(x ORDER BY ord), ARRAY[]::text[])
        FROM (
          SELECT DISTINCT ON (lower(x)) x, ord
          FROM unnest(
            coalesce(c.tags, ARRAY[]::text[]) || v_tags
            || CASE WHEN EXISTS (SELECT 1 FROM unnest(coalesce(c.tags, ARRAY[]::text[])) t WHERE t ILIKE 'origem:%')
                    THEN ARRAY[]::text[] ELSE ARRAY[v_origem_tag] END
          ) WITH ORDINALITY AS u(x, ord)
          WHERE btrim(x) <> ''
          ORDER BY lower(x), ord
        ) d
      ),
      updated_at = now()
    WHERE c.id = v_existing.id;

    -- Porta de contato (importação, captação, manual) promove quem ainda era 'conversa'.
    IF v_lifecycle = 'contato' AND v_existing.lifecycle = 'conversa' THEN
      v_promoted := public.promote_contact(v_existing.id, 'porta:' || v_channel);
    END IF;

    RETURN jsonb_build_object(
      'contact_id', v_existing.id,
      'created', false,
      'matched_by', v_matched_by,
      'promoted', v_promoted,
      'phone', v_phone
    );
  END IF;

  -- ---------------------------------------------------------------------------
  -- Não achou: cria
  -- ---------------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM unnest(v_tags) t WHERE t ILIKE 'origem:%') THEN
    v_tags := v_tags || v_origem_tag;
  END IF;

  INSERT INTO public.contacts (
    organization_id, name, phone, email, instagram_username, tiktok_username,
    source, avatar, tags, status, stage,
    lifecycle, lifecycle_changed_at, lifecycle_reason
  ) VALUES (
    p_organization_id,
    coalesce(v_name, CASE WHEN v_ig IS NOT NULL THEN '@' || v_ig WHEN v_tt IS NOT NULL THEN '@' || v_tt END, v_phone, v_email, 'Lead'),
    v_phone, v_email, v_ig, v_tt,
    coalesce(nullif(btrim(coalesce(p_source, '')), ''), v_channel),
    nullif(btrim(coalesce(p_avatar, '')), ''),
    v_tags, 'ACTIVE', 'LEAD',
    v_lifecycle,
    CASE WHEN v_lifecycle = 'contato' THEN now() END,
    CASE WHEN v_lifecycle = 'contato' THEN 'porta:' || v_channel ELSE 'webhook:' || v_channel END
  )
  RETURNING id INTO v_new_id;

  RETURN jsonb_build_object(
    'contact_id', v_new_id,
    'created', true,
    'matched_by', NULL,
    'promoted', false,
    'phone', v_phone
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.upsert_contact_identity(uuid, text, text, text, text, text, text, text, text[], text, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.normalize_phone_e164(text) TO authenticated, service_role, anon;
GRANT EXECUTE ON FUNCTION public.phone_lookup_variants(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.normalize_social_username(text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Duplicados: além de telefone exato e e-mail, agora 9º dígito e @ (só 'contato')
-- -----------------------------------------------------------------------------
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

  WITH base AS (
    SELECT id, name, phone, email, instagram_username, tiktok_username, created_at,
           public.normalize_phone_e164(phone) AS phone_canon
    FROM contacts
    WHERE organization_id = p_org_id
      AND deleted_at IS NULL
      AND merged_into_id IS NULL
      AND lifecycle = 'contato'
  ),
  raw_groups AS (
    -- telefone igual DEPOIS de normalizar (pega 9º dígito, sem '+', com máscara)
    SELECT
      CASE WHEN count(DISTINCT phone) > 1 THEN 'phone9' ELSE 'phone' END AS match_type,
      phone_canon AS match_value,
      array_agg(id ORDER BY created_at) AS contact_ids,
      array_agg(name ORDER BY created_at) AS contact_names,
      count(*) AS group_size
    FROM base
    WHERE phone_canon IS NOT NULL
    GROUP BY phone_canon
    HAVING count(*) > 1

    UNION ALL

    SELECT 'email', lower(email), array_agg(id ORDER BY created_at), array_agg(name ORDER BY created_at), count(*)
    FROM base
    WHERE email IS NOT NULL AND email <> ''
    GROUP BY lower(email)
    HAVING count(*) > 1

    UNION ALL

    SELECT 'instagram', lower(instagram_username), array_agg(id ORDER BY created_at), array_agg(name ORDER BY created_at), count(*)
    FROM base
    WHERE instagram_username IS NOT NULL
    GROUP BY lower(instagram_username)
    HAVING count(*) > 1

    UNION ALL

    SELECT 'tiktok', lower(tiktok_username), array_agg(id ORDER BY created_at), array_agg(name ORDER BY created_at), count(*)
    FROM base
    WHERE tiktok_username IS NOT NULL
    GROUP BY lower(tiktok_username)
    HAVING count(*) > 1
  )
  SELECT COALESCE(jsonb_agg(row_to_json(g)), '[]'::jsonb)
  INTO v_result
  FROM raw_groups g;

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Merge junta tags, source, @, lifecycle (o resto igual ao 20260208200000)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_contacts(
  p_source_id UUID,
  p_target_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_caller_id UUID;
  v_source RECORD;
  v_target RECORD;
  v_moved JSONB DEFAULT '{}'::jsonb;
  v_count INTEGER;
BEGIN
  v_caller_id := auth.uid();

  IF p_source_id = p_target_id THEN
    RAISE EXCEPTION 'Cannot merge contact into itself';
  END IF;

  IF p_source_id < p_target_id THEN
    SELECT * INTO v_source FROM contacts WHERE id = p_source_id AND deleted_at IS NULL FOR UPDATE;
    SELECT * INTO v_target FROM contacts WHERE id = p_target_id AND deleted_at IS NULL FOR UPDATE;
  ELSE
    SELECT * INTO v_target FROM contacts WHERE id = p_target_id AND deleted_at IS NULL FOR UPDATE;
    SELECT * INTO v_source FROM contacts WHERE id = p_source_id AND deleted_at IS NULL FOR UPDATE;
  END IF;

  IF v_source IS NULL OR v_target IS NULL THEN
    RAISE EXCEPTION 'Contact not found or already deleted';
  END IF;

  IF v_source.organization_id != v_target.organization_id THEN
    RAISE EXCEPTION 'Contacts from different organizations';
  END IF;

  v_org_id := v_target.organization_id;

  -- service_role (sem auth.uid) passa; usuário precisa ser da org
  IF v_caller_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM profiles WHERE id = v_caller_id AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF v_source.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'Source contact already merged';
  END IF;
  IF v_target.merged_into_id IS NOT NULL THEN
    RAISE EXCEPTION 'Target contact already merged';
  END IF;

  -- 1. Preencher campos nulos do target com dados do source + juntar tags
  --    ARK (Onda 2B): tags somam (rastro de funis nunca se perde), source/@/avatar
  --    completam, telefone fica no canônico, lifecycle 'contato' vence.
  UPDATE contacts SET
    email = COALESCE(email, v_source.email),
    phone = COALESCE(public.normalize_phone_e164(phone), public.normalize_phone_e164(v_source.phone), phone, v_source.phone),
    instagram_username = COALESCE(instagram_username, v_source.instagram_username),
    tiktok_username = COALESCE(tiktok_username, v_source.tiktok_username),
    source = COALESCE(NULLIF(source, ''), v_source.source),
    avatar = COALESCE(NULLIF(avatar, ''), v_source.avatar),
    company_name = COALESCE(company_name, v_source.company_name),
    client_company_id = COALESCE(client_company_id, v_source.client_company_id),
    name = CASE
      WHEN (name ~ '^\+?[0-9 ()\-]+$' OR name ~* '^contato do ')
       AND v_source.name IS NOT NULL
       AND NOT (v_source.name ~ '^\+?[0-9 ()\-]+$' OR v_source.name ~* '^contato do ')
      THEN v_source.name ELSE name END,
    tags = (
      SELECT coalesce(array_agg(x ORDER BY ord), ARRAY[]::text[])
      FROM (
        SELECT DISTINCT ON (lower(x)) x, ord
        FROM unnest(coalesce(tags, ARRAY[]::text[]) || coalesce(v_source.tags, ARRAY[]::text[])) WITH ORDINALITY AS u(x, ord)
        WHERE btrim(x) <> ''
        ORDER BY lower(x), ord
      ) d
    ),
    lifecycle = CASE WHEN lifecycle = 'contato' OR v_source.lifecycle = 'contato' THEN 'contato' ELSE lifecycle END,
    lifecycle_changed_at = CASE WHEN lifecycle = 'conversa' AND v_source.lifecycle = 'contato' THEN now() ELSE lifecycle_changed_at END,
    lifecycle_reason = CASE WHEN lifecycle = 'conversa' AND v_source.lifecycle = 'contato' THEN 'merge' ELSE lifecycle_reason END,
    total_value = COALESCE(total_value, 0) + COALESCE(v_source.total_value, 0),
    notes = CASE
      WHEN notes IS NULL THEN v_source.notes
      WHEN v_source.notes IS NOT NULL THEN LEFT(notes || E'\n---\n' || v_source.notes, 50000)
      ELSE notes
    END,
    updated_at = NOW()
  WHERE id = p_target_id;

  ALTER TABLE deals DISABLE TRIGGER check_deal_duplicate_trigger;
  UPDATE deals SET contact_id = p_target_id WHERE contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('deals', v_count);
  ALTER TABLE deals ENABLE TRIGGER check_deal_duplicate_trigger;

  UPDATE messaging_conversations SET contact_id = p_target_id WHERE contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('conversations', v_count);

  UPDATE voice_calls SET contact_id = p_target_id WHERE contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('voice_calls', v_count);

  UPDATE activities SET contact_id = p_target_id WHERE contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('activities', v_count);

  UPDATE activities
  SET participant_contact_ids = (
    SELECT ARRAY(SELECT DISTINCT unnest(
      array_replace(participant_contact_ids, p_source_id, p_target_id)
    ))
  )
  WHERE p_source_id = ANY(participant_contact_ids);

  UPDATE ai_decisions SET contact_id = p_target_id WHERE contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('ai_decisions', v_count);

  UPDATE ai_audio_notes SET contact_id = p_target_id WHERE contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('ai_audio_notes', v_count);

  UPDATE leads SET converted_to_contact_id = p_target_id
    WHERE converted_to_contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('leads', v_count);

  UPDATE webhook_events_in SET created_contact_id = p_target_id
    WHERE created_contact_id = p_source_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  v_moved := v_moved || jsonb_build_object('webhook_events', v_count);

  UPDATE contacts SET
    merged_into_id = p_target_id,
    deleted_at = NOW(),
    updated_at = NOW()
  WHERE id = p_source_id;

  INSERT INTO contact_merge_log (
    organization_id, source_contact_id, target_contact_id, merged_by,
    source_snapshot, records_moved
  ) VALUES (
    v_org_id, p_source_id, p_target_id, v_caller_id,
    row_to_json(v_source)::jsonb,
    v_moved
  );

  RETURN jsonb_build_object(
    'success', true,
    'targetId', p_target_id,
    'sourceId', p_source_id,
    'recordsMoved', v_moved
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. Produtos comprados (card do contato): negócios ganhos.
--    Produto = tag produto:<x> do negócio; senão item do negócio; senão o funil.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_contact_purchases(p_contact_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'deal_id', d.id,
      'title', d.title,
      'product', coalesce(
         (SELECT string_agg(initcap(replace(substr(t, 9), '-', ' ')), ' + ' ORDER BY t) FROM unnest(d.tags) t WHERE t ILIKE 'produto:%'),
         (SELECT string_agg(i.name, ' + ' ORDER BY i.created_at) FROM public.deal_items i WHERE i.deal_id = d.id),
         b.name
      ),
      'board', b.name,
      'value', d.value,
      'closed_at', coalesce(d.closed_at, d.updated_at),
      'payment_method', d.payment_method,
      'gateway', d.gateway_id IS NOT NULL
    ) ORDER BY coalesce(d.closed_at, d.updated_at) DESC), '[]'::jsonb)
  FROM public.deals d
  LEFT JOIN public.boards b ON b.id = d.board_id
  WHERE d.contact_id = p_contact_id
    AND d.organization_id = public.get_user_org_id()
    AND d.deleted_at IS NULL
    AND d.is_won = true;
$$;

GRANT EXECUTE ON FUNCTION public.get_contact_purchases(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
