-- Financeiro: gateways com taxa por forma de pagamento + taxa/imposto por negocio
-- Plano: PLANO-CRM-funis-2026-09-22.md (Entrega 2)
--
-- A taxa e do GATEWAY, nunca do produto: o mesmo produto e vendido por gateways diferentes.
-- E ela muda tambem por FORMA DE PAGAMENTO (boleto/PIX x cartao parcelado), decidido pelo
-- Mauricio em 22/09. Por isso a taxa mora em gateway_fees, uma linha por (gateway, forma).
-- Sem linha para a forma escolhida, vale a taxa padrao do proprio gateway.
--
-- O imposto incide sobre o valor BRUTO vendido, nao sobre o liquido:
--   lucro = valor * (1 - taxa_gateway - imposto)

BEGIN;

-- Cadastro de gateways (TMB, Eduzz, Hotmart, Lia...)
CREATE TABLE IF NOT EXISTS public.gateways (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  fee_pct         numeric(6,3) NOT NULL DEFAULT 0,  -- taxa padrao, usada quando a forma nao tem a sua
  active          boolean DEFAULT true,
  owner_id        uuid,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  CONSTRAINT gateways_fee_pct_range CHECK (fee_pct >= 0 AND fee_pct <= 100)
);

CREATE INDEX IF NOT EXISTS gateways_organization_id_idx ON public.gateways(organization_id);

-- Taxa por forma de pagamento dentro do gateway.
-- payment_method e texto livre para o cadastro nao travar quando surgir forma nova
-- (a UI oferece pix, boleto, cartao e cartao_parcelado).
CREATE TABLE IF NOT EXISTS public.gateway_fees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  gateway_id      uuid NOT NULL REFERENCES public.gateways(id) ON DELETE CASCADE,
  payment_method  text NOT NULL,
  fee_pct         numeric(6,3) NOT NULL DEFAULT 0,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  CONSTRAINT gateway_fees_fee_pct_range CHECK (fee_pct >= 0 AND fee_pct <= 100),
  CONSTRAINT gateway_fees_unique_method UNIQUE (gateway_id, payment_method)
);

CREATE INDEX IF NOT EXISTS gateway_fees_gateway_id_idx ON public.gateway_fees(gateway_id);

ALTER TABLE public.gateways     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateway_fees ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gateways_org_isolate ON public.gateways;
CREATE POLICY gateways_org_isolate ON public.gateways
  FOR ALL USING (organization_id = get_user_org_id())
  WITH CHECK (organization_id = get_user_org_id());

DROP POLICY IF EXISTS gateway_fees_org_isolate ON public.gateway_fees;
CREATE POLICY gateway_fees_org_isolate ON public.gateway_fees
  FOR ALL USING (organization_id = get_user_org_id())
  WITH CHECK (organization_id = get_user_org_id());

-- No negocio: gateway + forma de pagamento resolvem a taxa; fee_pct/tax_pct sao o override
-- daquela venda. NULL = "usa o padrao" (do gateway/forma, e do imposto da organizacao).
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS gateway_id     uuid REFERENCES public.gateways(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_method text,
  ADD COLUMN IF NOT EXISTS fee_pct        numeric(6,3),
  ADD COLUMN IF NOT EXISTS tax_pct        numeric(6,3);

ALTER TABLE public.deals
  DROP CONSTRAINT IF EXISTS deals_fee_pct_range,
  DROP CONSTRAINT IF EXISTS deals_tax_pct_range;

ALTER TABLE public.deals
  ADD CONSTRAINT deals_fee_pct_range CHECK (fee_pct IS NULL OR (fee_pct >= 0 AND fee_pct <= 100)),
  ADD CONSTRAINT deals_tax_pct_range CHECK (tax_pct IS NULL OR (tax_pct >= 0 AND tax_pct <= 100));

CREATE INDEX IF NOT EXISTS deals_gateway_id_idx ON public.deals(gateway_id);

-- Imposto padrao da organizacao (Simples), sobrescrevivel por negocio.
ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS default_tax_pct numeric(6,3) DEFAULT 0;

COMMIT;
