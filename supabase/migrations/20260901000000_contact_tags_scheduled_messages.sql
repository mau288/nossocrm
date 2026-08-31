-- =============================================================================
-- Tags no contato (rastro de funis) + Mensagens programadas (follow-up)
-- =============================================================================

-- 1. Tags acumulativas no contato — o operador aplica direto na conversa e usa
--    depois como filtro/rastro de quais processos o lead passou.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_contacts_tags ON public.contacts USING gin(tags);

-- 2. Mensagens programadas (follow-up em dia/horário definidos pelo operador)
CREATE TABLE IF NOT EXISTS public.scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.messaging_conversations(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES public.messaging_channels(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,

  content TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'sent', 'failed', 'cancelled'
  )),
  sent_at TIMESTAMPTZ,
  error TEXT,

  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_messages FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON public.scheduled_messages (scheduled_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_conversation
  ON public.scheduled_messages (conversation_id);

DROP POLICY IF EXISTS "scheduled_messages_org_isolate" ON public.scheduled_messages;
CREATE POLICY "scheduled_messages_org_isolate" ON public.scheduled_messages
  FOR ALL
  USING (organization_id = public.get_user_org_id())
  WITH CHECK (organization_id = public.get_user_org_id());
