-- ARK Onda 3 / ajuste (31/10/2026): "responder = assumir".
--
-- Achado da medicao: 54 das 55 conversas da fila "aguardando resposta" estavam sem
-- responsavel. Decisao do Mauricio: o responsavel e quem estava LOGADO e respondeu pela
-- tela do CRM (ou quem clicou em Atribuir). Os chips (Julio, Pedro, Raul) sao compartilhados,
-- entao a atribuicao vai pelo login, nunca pelo chip. Resposta do n8n/aparelho nao atribui
-- (chega pelo webhook sem sender_user_id). "Resolvida" continua manual (disciplina do time).
--
-- Trigger AFTER INSERT em messaging_messages: outbound com sender_type = 'user' e
-- sender_user_id preenchido -> conversa SEM responsavel passa a ser desse usuario.
-- Quem ja tem responsavel nao muda (Atribuir manual continua mandando).

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_assign_on_human_reply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.direction = 'outbound' AND NEW.sender_type = 'user' AND NEW.sender_user_id IS NOT NULL THEN
    UPDATE public.messaging_conversations
       SET assigned_user_id = NEW.sender_user_id,
           assigned_at = now()
     WHERE id = NEW.conversation_id
       AND assigned_user_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_assign_on_human_reply ON public.messaging_messages;
CREATE TRIGGER trg_assign_on_human_reply
  AFTER INSERT ON public.messaging_messages
  FOR EACH ROW EXECUTE FUNCTION public.trg_assign_on_human_reply();

COMMIT;
