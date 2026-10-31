-- =============================================================================
-- ARK — Onda 1 da vistoria de 31/10/2026 (itens 1.4 e 1.6)
--
-- 1.6  pg_trgm + índices trigram em contacts(name, email, phone): a busca da tela de
--      Contatos usa `ilike '%x%'`, que sem índice varre a tabela inteira.
-- 1.6  get_contact_tag_counts(): tags em uso com contagem, agregadas no banco. Antes a
--      tela baixava `tags` de TODOS os contatos e contava no navegador.
-- 1.4  get_dashboard_contact_stats(): o que a Visão Geral precisa dos contatos (saúde da
--      carteira, LTV, contagem por estágio, criados no período) em UMA linha. Antes a
--      página baixava os 1.000 contatos mais recentes (604 KB) e calculava no navegador.
--
-- Tudo aditivo (não altera dados nem tabelas). SECURITY INVOKER: a RLS de contacts
-- continua valendo; o filtro por organização é explícito por garantia.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_contacts_name_trgm
  ON public.contacts USING gin (name extensions.gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_email_trgm
  ON public.contacts USING gin (email extensions.gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_phone_trgm
  ON public.contacts USING gin (phone extensions.gin_trgm_ops)
  WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- Tags em uso (filtro de conversas por tag do contato)
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
    AND btrim(t.tag) <> ''
  GROUP BY t.tag
  ORDER BY count(*) DESC, t.tag;
$$;

GRANT EXECUTE ON FUNCTION public.get_contact_tag_counts() TO authenticated;

-- -----------------------------------------------------------------------------
-- Estatísticas de contatos da Visão Geral
-- -----------------------------------------------------------------------------
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

GRANT EXECUTE ON FUNCTION public.get_dashboard_contact_stats(timestamptz, timestamptz, timestamptz, timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
