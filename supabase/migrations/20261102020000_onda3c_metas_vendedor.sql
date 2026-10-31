-- ARK Onda 3 / 3.3: meta por VENDEDOR (alem da meta por funil, ARK #53).
--
-- Decisao do Mauricio (31/10/2026): meta de negocios ganhos (quantidade) ou valor ganho,
-- por vendedor, com periodo proprio (igual ao da meta do funil), opcionalmente restrita a
-- um funil. Conversas respondidas e indicador do painel, nao meta.
--
-- seller_goals: uma linha por meta; arquivar = archived_at (historico fica na mesma tabela).
-- Progresso pela RPC get_seller_goals_progress: so ganhos/perdas com closed_at dentro da
-- janela (dia local de Sao Paulo), owner_id = vendedor, board_id = funil (ou qualquer).
-- Traz tambem o ritmo esperado (dias decorridos / dias totais) e o status:
--   batida | risco (abaixo de 80% do ritmo esperado, com >= 25% do periodo passado) |
--   andamento | nao-batida (arquivada ou vencida sem bater).
-- Admin ve todas; vendedor so as proprias. service_role (edge function dos alertas) ve todas.

BEGIN;

CREATE TABLE IF NOT EXISTS public.seller_goals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  board_id         uuid REFERENCES public.boards(id) ON DELETE SET NULL,   -- NULL = todos os funis
  kpi              text NOT NULL DEFAULT 'Meta do vendedor',
  goal_type        text NOT NULL DEFAULT 'number' CHECK (goal_type IN ('currency', 'number')),
  target_value     numeric(14,2) NOT NULL CHECK (target_value > 0),
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  description      text,
  archived_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT seller_goals_periodo CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS seller_goals_org_user_idx
  ON public.seller_goals (organization_id, user_id)
  WHERE archived_at IS NULL;

DROP TRIGGER IF EXISTS seller_goals_updated_at ON public.seller_goals;
CREATE TRIGGER seller_goals_updated_at
  BEFORE UPDATE ON public.seller_goals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE public.seller_goals ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro da org (a RPC ja recorta vendedor -> so as proprias).
DROP POLICY IF EXISTS seller_goals_select ON public.seller_goals;
CREATE POLICY seller_goals_select ON public.seller_goals
  FOR SELECT TO authenticated
  USING (organization_id = get_user_org_id());

-- Escrita: so admin da org.
DROP POLICY IF EXISTS seller_goals_admin_write ON public.seller_goals;
CREATE POLICY seller_goals_admin_write ON public.seller_goals
  FOR ALL TO authenticated
  USING (
    organization_id = get_user_org_id()
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  )
  WITH CHECK (
    organization_id = get_user_org_id()
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin')
  );

-- -----------------------------------------------------------------------------
-- RPC: progresso das metas por vendedor
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_seller_goals_progress(
  p_org_id uuid,
  p_include_archived boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_uid  uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_uid AND organization_id = p_org_id;
  IF v_role IS NULL AND auth.role() = 'service_role' THEN
    v_role := 'admin';
  END IF;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', x.id,
      'userId', x.user_id,
      'userName', x.user_name,
      'boardId', x.board_id,
      'boardName', x.board_name,
      'kpi', x.kpi,
      'goalType', x.goal_type,
      'targetValue', x.target_value,
      'startDate', to_char(x.start_date, 'YYYY-MM-DD'),
      'endDate', to_char(x.end_date, 'YYYY-MM-DD'),
      'description', x.description,
      'archivedAt', x.archived_at,
      'wonCount', x.won_count,
      'wonValue', x.won_value,
      'lostCount', x.lost_count,
      'value', x.valor,
      'pct', x.pct,
      'daysTotal', x.days_total,
      'daysElapsed', x.days_elapsed,
      'expectedPct', x.expected_pct,
      'status', CASE
        WHEN x.valor >= x.target_value THEN 'batida'
        WHEN x.archived_at IS NOT NULL OR x.end_date < v_hoje THEN 'nao-batida'
        WHEN x.days_total > 0 AND x.days_elapsed::numeric / x.days_total >= 0.25
             AND x.pct < 0.8 * x.expected_pct THEN 'risco'
        ELSE 'andamento'
      END
    ) ORDER BY x.archived_at NULLS FIRST, x.end_date DESC, x.user_name)
    FROM (
      SELECT g.*,
             COALESCE(NULLIF(p.nickname, ''),
                      NULLIF(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
                      p.name, p.email) AS user_name,
             b.name AS board_name,
             COALESCE(s.won_count, 0)  AS won_count,
             COALESCE(s.won_value, 0)  AS won_value,
             COALESCE(s.lost_count, 0) AS lost_count,
             CASE WHEN g.goal_type = 'currency' THEN COALESCE(s.won_value, 0)
                  ELSE COALESCE(s.won_count, 0)::numeric END AS valor,
             round(100 * (CASE WHEN g.goal_type = 'currency' THEN COALESCE(s.won_value, 0)
                               ELSE COALESCE(s.won_count, 0)::numeric END) / g.target_value, 1) AS pct,
             (g.end_date - g.start_date + 1) AS days_total,
             GREATEST(0, LEAST(g.end_date - g.start_date + 1, v_hoje - g.start_date + 1)) AS days_elapsed,
             round(100.0 * GREATEST(0, LEAST(g.end_date - g.start_date + 1, v_hoje - g.start_date + 1))
                   / (g.end_date - g.start_date + 1), 1) AS expected_pct
        FROM seller_goals g
        JOIN profiles p ON p.id = g.user_id
        LEFT JOIN boards b ON b.id = g.board_id
        LEFT JOIN LATERAL (
          SELECT count(*) FILTER (WHERE d.is_won) AS won_count,
                 COALESCE(sum(d.value) FILTER (WHERE d.is_won), 0) AS won_value,
                 count(*) FILTER (WHERE d.is_lost) AS lost_count
            FROM deals d
           WHERE d.organization_id = g.organization_id
             AND d.deleted_at IS NULL
             AND d.owner_id = g.user_id
             AND (g.board_id IS NULL OR d.board_id = g.board_id)
             AND (d.is_won OR d.is_lost)
             AND d.closed_at IS NOT NULL
             AND (d.closed_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN g.start_date AND g.end_date
        ) s ON true
       WHERE g.organization_id = p_org_id
         AND (p_include_archived OR g.archived_at IS NULL)
         AND (v_role = 'admin' OR g.user_id = v_uid)
    ) x
  ), '[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.get_seller_goals_progress(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_seller_goals_progress(uuid, boolean) TO authenticated, service_role;

COMMIT;
