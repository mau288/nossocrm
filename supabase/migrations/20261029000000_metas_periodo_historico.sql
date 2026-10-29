-- ARK #53: meta do funil com periodo + historico de metas.
--
-- Hoje cada funil tem UMA meta (4 colunas em boards) e o progresso soma todos os ganhos
-- que o funil ja teve, sem olhar data. Trocar "Set26 - 20" por "Dezembro - 30" nascia com
-- 15/30, porque as matriculas de setembro entravam na conta. E a meta antiga sumia.
--
-- Agora: a meta ganha inicio/fim (so conta ganho fechado dentro da janela) e, ao trocar a
-- meta na tela, a anterior vai para board_goal_history com o resultado final.

BEGIN;

ALTER TABLE public.boards
  ADD COLUMN IF NOT EXISTS goal_start_date date,
  ADD COLUMN IF NOT EXISTS goal_end_date   date;

CREATE TABLE IF NOT EXISTS public.board_goal_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  board_id         uuid NOT NULL REFERENCES public.boards(id) ON DELETE CASCADE,
  board_name       text NOT NULL,            -- nome na epoca (funil pode ser renomeado)
  kpi              text,
  target_value     text,
  goal_type        text,                     -- currency | number | percentage
  description      text,
  start_date       date,
  end_date         date,
  achieved_value   numeric(14,2) NOT NULL DEFAULT 0,  -- no tipo da meta (R$, qtd ou %)
  achieved_display text,
  won_count        integer NOT NULL DEFAULT 0,
  won_value        numeric(14,2) NOT NULL DEFAULT 0,
  archived_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_goal_history_board_id_idx ON public.board_goal_history(board_id);
CREATE INDEX IF NOT EXISTS board_goal_history_organization_id_idx ON public.board_goal_history(organization_id);

ALTER TABLE public.board_goal_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS board_goal_history_org_isolate ON public.board_goal_history;
CREATE POLICY board_goal_history_org_isolate ON public.board_goal_history
  FOR ALL USING (organization_id = get_user_org_id())
  WITH CHECK (organization_id = get_user_org_id());

-- A meta que esta no ar (Set26) ganha o periodo dela. Nao entra no historico aqui:
-- quando a tela trocar pela meta de dezembro, ela arquiva Set26 com o resultado real.
UPDATE public.boards
SET goal_start_date = '2026-09-01', goal_end_date = '2026-09-30'
WHERE goal_kpi = 'Meta do Lançamento - Set26' AND goal_start_date IS NULL AND deleted_at IS NULL;

COMMIT;
