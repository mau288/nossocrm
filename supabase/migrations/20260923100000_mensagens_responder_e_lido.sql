-- Mensagens: responder = lido
-- Plano: PLANO-CRM-mensagens-vendedores-2026-09-23.md (item 1)
--
-- Por que: unread_count so crescia (+1 a cada mensagem do lead) e nada zerava ao responder —
-- nem pelo celular, nem pelo bot do n8n, nem pelo CRM. Em producao havia 330 conversas com
-- badge somando 1.148 "nao lidas", 59 delas com a ULTIMA mensagem sendo do proprio operador.
-- Regra nova: mensagem nossa (outbound, de qualquer origem) zera o badge da conversa.
-- Abrir a conversa no CRM continua zerando (RPC mark_conversation_read, que ja existia).
--
-- Idempotente: a funcao e CREATE OR REPLACE e o recalculo so toca linha que esta diferente.

-- =============================================================================
-- 1. Trigger: outbound zera, inbound soma (o resto da funcao e identico ao que esta no banco,
--    incluindo o tratamento de reacoes da migration 20260403120000)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS TRIGGER AS $$
DECLARE
  v_emoji TEXT;
  v_message_id TEXT;
  v_current_count INT;
BEGIN
  -- Reactions are annotations on existing messages, not standalone messages.
  -- Update the original message's metadata.reactions and exit early.
  IF NEW.content_type = 'reaction' THEN
    v_emoji      := NEW.content->>'emoji';
    v_message_id := NEW.content->>'messageId';

    IF v_emoji IS NOT NULL AND v_message_id IS NOT NULL THEN
      UPDATE public.messaging_messages
      SET metadata = jsonb_set(
        jsonb_set(
          COALESCE(metadata, '{}'),
          ARRAY['reactions'],
          COALESCE(metadata->'reactions', '{}')
        ),
        ARRAY['reactions', v_emoji],
        to_jsonb(
          COALESCE(
            (metadata->'reactions'->>v_emoji)::int,
            0
          ) + 1
        )
      )
      WHERE external_id = v_message_id;
    END IF;

    RETURN NEW;
  END IF;

  -- Normal (non-reaction) message: update conversation counters
  UPDATE public.messaging_conversations
  SET
    last_message_at = NEW.created_at,
    last_message_preview = CASE
      WHEN NEW.content_type = 'text'     THEN LEFT(NEW.content->>'text', 100)
      WHEN NEW.content_type = 'image'    THEN '[Imagem]'
      WHEN NEW.content_type = 'video'    THEN '[Video]'
      WHEN NEW.content_type = 'audio'    THEN '[Audio]'
      WHEN NEW.content_type = 'document' THEN '[Documento]'
      WHEN NEW.content_type = 'sticker'  THEN '[Sticker]'
      WHEN NEW.content_type = 'location' THEN '[Localização]'
      WHEN NEW.content_type = 'contact'  THEN '[Contato]'
      WHEN NEW.content_type = 'template' THEN '[Template]'
      ELSE '[Mensagem]'
    END,
    last_message_direction = NEW.direction,
    message_count          = message_count + 1,
    -- ARK: responder = lido. Mensagem nossa zera o badge; mensagem do lead soma.
    unread_count           = CASE
      WHEN NEW.direction = 'inbound' THEN unread_count + 1
      ELSE 0
    END,
    window_expires_at      = CASE
      WHEN NEW.direction = 'inbound' THEN NOW() + INTERVAL '24 hours'
      ELSE window_expires_at
    END,
    updated_at = NOW()
  WHERE id = NEW.conversation_id;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- 2. Recalculo unico: badge = mensagens do lead depois da nossa ultima resposta
--    (reacoes nao contam, igual ao trigger). So atualiza quem esta diferente.
-- =============================================================================
UPDATE public.messaging_conversations c
SET unread_count = sub.pendentes
FROM (
  SELECT
    c2.id,
    (
      SELECT COUNT(*)
      FROM public.messaging_messages m
      WHERE m.conversation_id = c2.id
        AND m.direction = 'inbound'
        AND m.content_type <> 'reaction'
        AND m.created_at > COALESCE(
          (SELECT MAX(o.created_at)
             FROM public.messaging_messages o
            WHERE o.conversation_id = c2.id AND o.direction = 'outbound'),
          '1970-01-01'::timestamptz
        )
    ) AS pendentes
  FROM public.messaging_conversations c2
) sub
WHERE sub.id = c.id
  AND c.unread_count <> sub.pendentes;
