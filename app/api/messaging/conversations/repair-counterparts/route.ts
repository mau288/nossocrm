import { createClient } from '@/lib/supabase/server';
import { isAllowedOrigin } from '@/lib/security/sameOrigin';

function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function normalized(value: string | null | undefined): string {
  return (value || '').trim().toLocaleLowerCase('pt-BR');
}

function digits(value: string | null | undefined): string {
  return (value || '').replace(/\D/g, '');
}

function isUsableInboundName(value: string | null | undefined): value is string {
  const name = (value || '').trim();
  return name.length >= 2 && !['contato desconhecido', 'contato do instagram'].includes(normalized(name));
}

/**
 * Corrects legacy records whose identity was accidentally taken from an
 * outbound channel event. Only stale, placeholder, or number-only linked
 * contacts are changed, preserving any name entered manually by the team.
 */
export async function POST(req: Request) {
  if (!isAllowedOrigin(req)) return json({ error: 'Forbidden' }, 403);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: 'Unauthorized' }, 401);

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single();
  if (profileError || !profile?.organization_id) return json({ error: 'Profile not found' }, 404);

  const { data: conversations, error: conversationsError } = await supabase
    .from('messaging_conversations')
    .select('id, contact_id, external_contact_id, external_contact_name')
    .eq('organization_id', profile.organization_id)
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(250);
  if (conversationsError) {
    console.error('Counterpart repair: could not list conversations', conversationsError);
    return json({ error: 'Internal server error' }, 500);
  }
  if (!conversations?.length) {
    return json({ repairedConversations: 0, repairedContacts: 0, repairedDeals: 0 });
  }

  const conversationIds = conversations.map((conversation) => conversation.id);
  const { data: incomingMessages, error: messagesError } = await supabase
    .from('messaging_messages')
    .select('conversation_id, sender_name, created_at')
    .in('conversation_id', conversationIds)
    .eq('direction', 'inbound')
    .not('sender_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(5000);
  if (messagesError) {
    console.error('Counterpart repair: could not read incoming messages', messagesError);
    return json({ error: 'Internal server error' }, 500);
  }

  // The query is newest first: save the newest valid inbound sender per thread.
  const latestInboundName = new Map<string, string>();
  for (const message of incomingMessages || []) {
    if (!latestInboundName.has(message.conversation_id) && isUsableInboundName(message.sender_name)) {
      latestInboundName.set(message.conversation_id, message.sender_name.trim());
    }
  }

  const contactIds = conversations
    .map((conversation) => conversation.contact_id)
    .filter((id): id is string => Boolean(id));
  const contactsById = new Map<string, { id: string; name: string | null }>();
  if (contactIds.length) {
    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id, name')
      .in('id', contactIds);
    if (contactsError) {
      console.error('Counterpart repair: could not read contacts', contactsError);
      return json({ error: 'Internal server error' }, 500);
    }
    for (const contact of contacts || []) contactsById.set(contact.id, contact);
  }

  let repairedConversations = 0;
  let repairedContacts = 0;
  let repairedDeals = 0;
  const repairedDealContactIds = new Set<string>();
  for (const conversation of conversations) {
    const inboundName = latestInboundName.get(conversation.id);
    if (!inboundName) continue;

    const previousName = conversation.external_contact_name;
    if (normalized(previousName) !== normalized(inboundName)) {
      const { error } = await supabase
        .from('messaging_conversations')
        .update({ external_contact_name: inboundName })
        .eq('id', conversation.id);
      if (error) {
        console.error('Counterpart repair: conversation update failed', error, { conversationId: conversation.id });
        continue;
      }
      repairedConversations++;
    }

    const contact = conversation.contact_id ? contactsById.get(conversation.contact_id) : undefined;
    if (!contact) continue;
    const currentName = normalized(contact.name);
    const isPlaceholder = !currentName || ['contato desconhecido', 'contato do instagram'].includes(currentName);
    const isStaleConversationName = currentName === normalized(previousName);
    const isPhoneName = Boolean(digits(contact.name)) && digits(contact.name) === digits(conversation.external_contact_id);
    const shouldRepairContact =
      (isPlaceholder || isStaleConversationName || isPhoneName) &&
      currentName !== normalized(inboundName);
    if (shouldRepairContact) {
      const { error } = await supabase
        .from('contacts')
        .update({ name: inboundName })
        .eq('id', contact.id);
      if (error) {
        console.error('Counterpart repair: contact update failed', error, { contactId: contact.id });
        continue;
      }
      repairedContacts++;
    }

    // NegÃ³cios jÃ¡ enviados ao board tambÃ©m podem ter recebido o telefone ou
    // o nome do canal como tÃ­tulo. SÃ³ trocamos esses dois casos objetivos;
    // tÃ­tulos customizados pelo time continuam intactos.
    if (repairedDealContactIds.has(contact.id)) continue;
    repairedDealContactIds.add(contact.id);
    const { data: deals, error: dealsError } = await supabase
      .from('deals')
      .select('id, title')
      .eq('organization_id', profile.organization_id)
      .eq('contact_id', contact.id)
      .is('deleted_at', null);
    if (dealsError) {
      console.error('Counterpart repair: could not read deals', dealsError, { contactId: contact.id });
      continue;
    }
    for (const deal of deals || []) {
      const titleIsStaleName = normalized(deal.title) === normalized(previousName);
      const titleIsPhone = Boolean(digits(deal.title)) && digits(deal.title) === digits(conversation.external_contact_id);
      if (!titleIsStaleName && !titleIsPhone) continue;
      const { error: dealError } = await supabase
        .from('deals')
        .update({ title: inboundName })
        .eq('id', deal.id);
      if (dealError) {
        console.error('Counterpart repair: deal update failed', dealError, { dealId: deal.id });
        continue;
      }
      repairedDeals++;
    }
  }

  return json({ repairedConversations, repairedContacts, repairedDeals });
}
