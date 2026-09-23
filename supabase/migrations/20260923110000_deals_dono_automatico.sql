-- Negocios: dono automatico + carga inicial dos ganhos sem dono
-- Plano: PLANO-CRM-mensagens-vendedores-2026-09-23.md (item 4)
--
-- Por que: 20/20 negocios estavam com owner_id NULL e o Top Vendedores mostrava "Sem Dono".
-- Regra nova (no banco, vale pra todo caminho da UI: modal, "Enviar pro funil", mover pro
-- Matriculado, botao GANHO):
--   * INSERT sem owner_id  -> dono = usuario logado
--   * UPDATE que vira ganho (is_won false -> true) sem owner_id -> dono = quem marcou
-- Webhook/n8n/API publica rodam com service role (auth.uid() NULL) e o negocio fica sem dono
-- ate alguem marcar ganho ou atribuir no campo "Responsavel" do card.
--
-- Idempotente: CREATE OR REPLACE + DROP TRIGGER IF EXISTS; o UPDATE de carga so acha linha na
-- instancia da ARK (org 41a996f9) e e no-op em banco novo.

-- =============================================================================
-- 1. Trigger
-- =============================================================================
CREATE OR REPLACE FUNCTION public.set_deal_owner_default()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR NEW.owner_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
     OR (COALESCE(NEW.is_won, FALSE) IS TRUE AND COALESCE(OLD.is_won, FALSE) IS FALSE) THEN
    -- So atribui se o usuario logado pertence a mesma organizacao do negocio
    IF EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = v_uid AND p.organization_id = NEW.organization_id
    ) THEN
      NEW.owner_id := v_uid;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_owner_default ON public.deals;
CREATE TRIGGER trg_deal_owner_default
BEFORE INSERT OR UPDATE ON public.deals
FOR EACH ROW
EXECUTE FUNCTION public.set_deal_owner_default();

-- =============================================================================
-- 2. Carga inicial (instancia ARK): os 5 ganhos sem dono (R$ 8.685) ficam com o Mauricio,
--    unico usuario da organizacao em 23/09/2026. Corrigir depois pelo campo "Responsavel".
-- =============================================================================
UPDATE public.deals d
SET owner_id = 'dbf7ec9b-2a61-4fd9-93f4-9c69c75c93b7'
WHERE d.organization_id = '41a996f9-6894-4b33-af05-67bd6436b7b9'
  AND d.is_won IS TRUE
  AND d.owner_id IS NULL
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = 'dbf7ec9b-2a61-4fd9-93f4-9c69c75c93b7'
      AND p.organization_id = d.organization_id
  );
