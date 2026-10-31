-- ARK Onda 3 / 3.2: regras de roteamento (lead_routing_rules) so para conversa de DUAS VIAS.
--
-- Antes, a regra "canal X -> funil Y" era aplicada pelos webhooks na CRIACAO da conversa:
-- com a regra nova de contato (Onda 2, decisao 8) isso criaria negocio (e promoveria a contato)
-- para toda DM automatica do Instagram e todo disparo da Black. Decisao do Mauricio (31/10):
-- o negocio so nasce quando o lead RESPONDE a uma abordagem (mesmo gatilho do T1).
--
-- Implementacao: trigger no banco (vale para Evolution, Zernio e qualquer canal futuro),
-- AFTER INSERT em messaging_messages, logo depois do T1 (ordem alfabetica dos triggers:
-- trg_promote_contact_on_reply < trg_route_lead_on_reply):
--   mensagem inbound + ja havia outbound na conversa + canal com regra ligada e funil
--   + contato ainda sem negocio naquele funil  ->  cria o negocio (etapa da regra ou 1a etapa,
--   dono = responsavel da conversa, titulo "<nome> - <canal>") e guarda deal_id no metadata
--   da conversa. Lock por (contato, funil) evita duplicar em mensagens simultaneas.
-- Os webhooks Evolution e Zernio deixam de chamar autoCreateDeal na criacao da conversa.
-- webhook-in (captacao) continua criando negocio sozinho, como antes.

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_route_lead_on_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv       record;
  v_rule       record;
  v_stage_id   uuid;
  v_deal_id    uuid;
  v_name       text;
  v_label      text;
BEGIN
  IF NEW.direction <> 'inbound' THEN
    RETURN NEW;
  END IF;

  SELECT mc.id, mc.organization_id, mc.channel_id, mc.contact_id, mc.assigned_user_id,
         mc.external_contact_name, mc.external_contact_id, mc.metadata
    INTO v_conv
    FROM public.messaging_conversations mc
   WHERE mc.id = NEW.conversation_id;

  IF v_conv.contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Regra do canal (ligada e com funil)
  SELECT r.board_id, r.stage_id
    INTO v_rule
    FROM public.lead_routing_rules r
   WHERE r.channel_id = v_conv.channel_id
     AND r.enabled
     AND r.board_id IS NOT NULL
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- "Respondeu a uma abordagem": ja existia mensagem nossa nesta conversa.
  IF NOT EXISTS (
    SELECT 1 FROM public.messaging_messages m
     WHERE m.conversation_id = NEW.conversation_id
       AND m.direction = 'outbound'
       AND m.id <> NEW.id
  ) THEN
    RETURN NEW;
  END IF;

  -- Um negocio por (contato, funil): lock + checagem
  PERFORM pg_advisory_xact_lock(hashtext(v_conv.contact_id::text || ':' || v_rule.board_id::text));
  IF EXISTS (
    SELECT 1 FROM public.deals d
     WHERE d.contact_id = v_conv.contact_id
       AND d.board_id = v_rule.board_id
       AND d.deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  -- Etapa: a da regra ou a primeira do funil
  v_stage_id := v_rule.stage_id;
  IF v_stage_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.board_stages s WHERE s.id = v_stage_id AND s.board_id = v_rule.board_id) THEN
    SELECT s.id INTO v_stage_id
      FROM public.board_stages s
     WHERE s.board_id = v_rule.board_id
     ORDER BY s."order" ASC
     LIMIT 1;
  END IF;
  IF v_stage_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(c.name, ''), v_conv.external_contact_name, v_conv.external_contact_id, 'Lead')
    INTO v_name
    FROM public.contacts c WHERE c.id = v_conv.contact_id;

  SELECT CASE ch.channel_type
           WHEN 'whatsapp' THEN 'WhatsApp'
           WHEN 'instagram' THEN 'Instagram'
           WHEN 'tiktok' THEN 'TikTok'
           ELSE initcap(ch.channel_type) END
    INTO v_label
    FROM public.messaging_channels ch WHERE ch.id = v_conv.channel_id;

  INSERT INTO public.deals (organization_id, board_id, stage_id, contact_id, owner_id, title, value, tags)
  VALUES (v_conv.organization_id, v_rule.board_id, v_stage_id, v_conv.contact_id, v_conv.assigned_user_id,
          left(v_name || ' - ' || COALESCE(v_label, 'Mensagem'), 200), 0,
          ARRAY['origem:' || lower(COALESCE(v_label, 'mensagem'))])
  RETURNING id INTO v_deal_id;

  UPDATE public.messaging_conversations
     SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('deal_id', v_deal_id, 'auto_created_deal', true, 'routed_on', 'reply')
   WHERE id = v_conv.id;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Roteamento nunca pode derrubar a gravacao da mensagem.
  RAISE WARNING 'trg_route_lead_on_reply: % (conversa %)', SQLERRM, NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_lead_on_reply ON public.messaging_messages;
CREATE TRIGGER trg_route_lead_on_reply
  AFTER INSERT ON public.messaging_messages
  FOR EACH ROW EXECUTE FUNCTION public.trg_route_lead_on_reply();

COMMIT;
