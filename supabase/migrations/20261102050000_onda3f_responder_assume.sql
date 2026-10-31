-- ARK Onda 3 / ajuste (31/10/2026): "responder = assumir" (humano e agente de IA).
--
-- Achado da medicao: 54 das 55 conversas da fila "aguardando resposta" estavam sem
-- responsavel. Decisoes do Mauricio:
--   * responsavel = quem estava LOGADO e respondeu pela tela do CRM (ou quem clicou em
--     Atribuir). Os chips (Julio, Pedro, Raul) sao compartilhados: vai pelo login, nunca pelo chip;
--   * resposta do agente de IA (n8n, pela API da Evolution) atribui ao perfil "Agente-IA"
--     (vendedor ja cadastrado); quando um humano responder pela tela, assume no lugar da IA;
--   * resposta pelo aparelho/WhatsApp Web (sem login) nao atribui;
--   * "resolvida" continua manual (disciplina do time).
--
-- profiles.is_ai_agent: marca o perfil do agente (1 por org). A function Evolution passa a gravar
-- sender_type = 'ai' nas mensagens que sairam pela API sem linha do CRM (evento send.message).
-- Trigger AFTER INSERT em messaging_messages (outbound):
--   sender_type = 'user' + sender_user_id -> assume se a conversa esta sem dono OU com o agente de IA;
--   sender_type = 'ai'                    -> assume o perfil is_ai_agent se a conversa esta sem dono.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_ai_agent boolean NOT NULL DEFAULT false;

-- Perfil "Agente-IA" (vendedor) da ArkAcademy = o agente de vendas do n8n.
UPDATE public.profiles
   SET is_ai_agent = true
 WHERE id = '9bcd9f49-d2ce-450d-9746-c0a819f5f90a'
   AND organization_id = '41a996f9-6894-4b33-af05-67bd6436b7b9';

CREATE OR REPLACE FUNCTION public.trg_assign_on_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org   uuid;
  v_atual uuid;
  v_ai    uuid;
BEGIN
  IF NEW.direction <> 'outbound' THEN
    RETURN NEW;
  END IF;

  IF NEW.sender_type = 'user' AND NEW.sender_user_id IS NOT NULL THEN
    -- Humano logado: assume se nao ha dono ou se o dono e o agente de IA.
    UPDATE public.messaging_conversations mc
       SET assigned_user_id = NEW.sender_user_id,
           assigned_at = now()
     WHERE mc.id = NEW.conversation_id
       AND (mc.assigned_user_id IS NULL
            OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = mc.assigned_user_id AND p.is_ai_agent));
    RETURN NEW;
  END IF;

  IF NEW.sender_type = 'ai' THEN
    SELECT mc.organization_id, mc.assigned_user_id INTO v_org, v_atual
      FROM public.messaging_conversations mc WHERE mc.id = NEW.conversation_id;
    IF v_atual IS NOT NULL THEN
      RETURN NEW;
    END IF;
    SELECT p.id INTO v_ai FROM public.profiles p
     WHERE p.organization_id = v_org AND p.is_ai_agent
     ORDER BY p.created_at LIMIT 1;
    IF v_ai IS NOT NULL THEN
      UPDATE public.messaging_conversations
         SET assigned_user_id = v_ai, assigned_at = now()
       WHERE id = NEW.conversation_id AND assigned_user_id IS NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_on_human_reply ON public.messaging_messages;
DROP TRIGGER IF EXISTS trg_assign_on_reply ON public.messaging_messages;
CREATE TRIGGER trg_assign_on_reply
  AFTER INSERT ON public.messaging_messages
  FOR EACH ROW EXECUTE FUNCTION public.trg_assign_on_reply();

DROP FUNCTION IF EXISTS public.trg_assign_on_human_reply();

COMMIT;
