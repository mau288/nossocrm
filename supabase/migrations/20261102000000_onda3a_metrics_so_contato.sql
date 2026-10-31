-- ARK Onda 3 (sobra da Onda 2): "Novos Contatos" do bloco Performance de Mensagens
-- contava toda CONVERSA criada no periodo (1.951 em 30 dias), nao contatos.
--
-- Agora:
--   contacts.new              = contatos (lifecycle = 'contato') que viraram contato no periodo
--                               (COALESCE(lifecycle_changed_at, created_at) dentro da janela)
--   contacts.newConversations = conversas criadas no periodo (o numero antigo, com nome certo)
--   contacts.followUp         = conversas do periodo com contato anterior ao periodo (como era)
-- O resto da funcao nao muda.

CREATE OR REPLACE FUNCTION public.get_messaging_metrics(
  p_org_id UUID,
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ DEFAULT NOW(),
  p_user_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_result JSONB;
  v_messages_total INTEGER DEFAULT 0;
  v_messages_by_user JSONB DEFAULT '[]'::jsonb;
  v_responses_by_type JSONB DEFAULT '{}'::jsonb;
  v_new_contacts INTEGER DEFAULT 0;
  v_new_conversations INTEGER DEFAULT 0;
  v_follow_ups INTEGER DEFAULT 0;
  v_avg_frt INTEGER DEFAULT 0;
  v_conversations_with_frt INTEGER DEFAULT 0;
  v_conversations_total INTEGER DEFAULT 0;
  v_conversations_with_response INTEGER DEFAULT 0;
  v_response_rate NUMERIC DEFAULT 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND organization_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  IF p_start_date < NOW() - INTERVAL '365 days' THEN
    p_start_date := NOW() - INTERVAL '365 days';
  END IF;

  -- Mensagens outbound por tipo
  SELECT
    COALESCE(SUM(type_count), 0),
    COALESCE(jsonb_object_agg(sender_type_key, type_count), '{}'::jsonb)
  INTO v_messages_total, v_responses_by_type
  FROM (
    SELECT
      COALESCE(m.sender_type, 'unknown') as sender_type_key,
      COUNT(*) as type_count
    FROM messaging_messages m
    JOIN messaging_conversations c ON m.conversation_id = c.id
    WHERE c.organization_id = p_org_id
      AND m.direction = 'outbound'
      AND m.created_at >= p_start_date
      AND m.created_at <= p_end_date
      AND (p_user_id IS NULL OR m.sender_user_id = p_user_id)
    GROUP BY COALESCE(m.sender_type, 'unknown')
  ) sub;

  -- Mensagens por vendedor (top 50)
  SELECT COALESCE(jsonb_agg(row_to_json(sub)), '[]'::jsonb)
  INTO v_messages_by_user
  FROM (
    SELECT
      m.sender_user_id as user_id,
      COALESCE(p.name, 'Não atribuído') as name,
      COUNT(*) as count
    FROM messaging_messages m
    JOIN messaging_conversations c ON m.conversation_id = c.id
    LEFT JOIN profiles p ON m.sender_user_id = p.id
    WHERE c.organization_id = p_org_id
      AND m.direction = 'outbound'
      AND m.created_at >= p_start_date
      AND m.created_at <= p_end_date
      AND (p_user_id IS NULL OR m.sender_user_id = p_user_id)
    GROUP BY m.sender_user_id, p.name
    ORDER BY count DESC
    LIMIT 50
  ) sub;

  -- Conversas novas vs follow-ups (como era: por conversa criada no periodo)
  SELECT
    COALESCE(COUNT(*), 0),
    COALESCE(COUNT(*) FILTER (WHERE cnt.created_at < p_start_date), 0)
  INTO v_new_conversations, v_follow_ups
  FROM messaging_conversations conv
  JOIN contacts cnt ON conv.contact_id = cnt.id
  WHERE conv.organization_id = p_org_id
    AND conv.created_at >= p_start_date
    AND conv.created_at <= p_end_date;

  -- ARK Onda 3: novos CONTATOS = quem virou 'contato' no periodo (regra da Onda 2)
  SELECT COALESCE(COUNT(*), 0)
  INTO v_new_contacts
  FROM contacts cnt
  WHERE cnt.organization_id = p_org_id
    AND cnt.deleted_at IS NULL
    AND cnt.lifecycle = 'contato'
    AND COALESCE(cnt.lifecycle_changed_at, cnt.created_at) >= p_start_date
    AND COALESCE(cnt.lifecycle_changed_at, cnt.created_at) <= p_end_date;

  -- SLA: First Response Time
  SELECT
    COALESCE(AVG(first_response_seconds)::INTEGER, 0),
    COUNT(*)
  INTO v_avg_frt, v_conversations_with_frt
  FROM messaging_conversations
  WHERE organization_id = p_org_id
    AND first_response_at >= p_start_date
    AND first_response_at <= p_end_date
    AND first_response_seconds IS NOT NULL;

  -- Taxa de Resposta
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM messaging_messages m2
      WHERE m2.conversation_id = conv.id
        AND m2.direction = 'outbound'
        AND m2.created_at >= p_start_date
    ))
  INTO v_conversations_total, v_conversations_with_response
  FROM messaging_conversations conv
  WHERE conv.organization_id = p_org_id
    AND conv.created_at >= p_start_date
    AND conv.created_at <= p_end_date
    AND EXISTS (
      SELECT 1 FROM messaging_messages m
      WHERE m.conversation_id = conv.id
        AND m.direction = 'inbound'
    );

  v_response_rate := CASE
    WHEN v_conversations_total > 0
    THEN ROUND((v_conversations_with_response::NUMERIC / v_conversations_total) * 100, 1)
    ELSE 0
  END;

  v_result := jsonb_build_object(
    'messagesSent', jsonb_build_object(
      'total', v_messages_total,
      'byUser', v_messages_by_user,
      'byType', v_responses_by_type
    ),
    'contacts', jsonb_build_object(
      'new', v_new_contacts,
      'newConversations', v_new_conversations,
      'followUp', v_follow_ups
    ),
    'sla', jsonb_build_object(
      'avgFirstResponseSeconds', v_avg_frt,
      'conversationsWithFRT', v_conversations_with_frt
    ),
    'responseRate', jsonb_build_object(
      'rate', v_response_rate,
      'responded', v_conversations_with_response,
      'total', v_conversations_total
    )
  );

  RETURN v_result;
END;
$$;
