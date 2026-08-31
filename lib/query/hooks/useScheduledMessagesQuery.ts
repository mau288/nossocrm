/**
 * @fileoverview Hooks de mensagens programadas (follow-up).
 *
 * O operador programa uma mensagem para uma conversa em um dia/horário; o
 * envio real é feito pelo pg_cron + edge function `scheduled-messages-dispatch`
 * (a mensagem enviada entra na conversa pelo espelho do canal).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase/client';

export interface ScheduledMessage {
  id: string;
  conversationId: string;
  channelId: string;
  contactId: string | null;
  content: string;
  scheduledAt: string;
  status: 'pending' | 'sent' | 'failed' | 'cancelled';
  sentAt: string | null;
  error: string | null;
  createdAt: string;
}

interface DbScheduledMessage {
  id: string;
  conversation_id: string;
  channel_id: string;
  contact_id: string | null;
  content: string;
  scheduled_at: string;
  status: ScheduledMessage['status'];
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

const transform = (db: DbScheduledMessage): ScheduledMessage => ({
  id: db.id,
  conversationId: db.conversation_id,
  channelId: db.channel_id,
  contactId: db.contact_id,
  content: db.content,
  scheduledAt: db.scheduled_at,
  status: db.status,
  sentAt: db.sent_at,
  error: db.error,
  createdAt: db.created_at,
});

const keyFor = (conversationId: string) => ['scheduled-messages', conversationId] as const;

/** Lista as mensagens programadas de uma conversa (mais recentes primeiro). */
export const useScheduledMessages = (conversationId: string | undefined) => {
  return useQuery<ScheduledMessage[]>({
    queryKey: keyFor(conversationId ?? 'none'),
    enabled: Boolean(conversationId),
    queryFn: async () => {
      const { data, error } = await supabase!
        .from('scheduled_messages')
        .select('*')
        .eq('conversation_id', conversationId!)
        .order('scheduled_at', { ascending: true });
      if (error) throw error;
      return ((data ?? []) as DbScheduledMessage[]).map(transform);
    },
    staleTime: 30 * 1000,
  });
};

/** Programa uma mensagem para a conversa. */
export const useCreateScheduledMessage = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      organizationId: string;
      conversationId: string;
      channelId: string;
      contactId?: string | null;
      content: string;
      scheduledAt: string; // ISO
      createdBy?: string | null;
    }) => {
      const { data, error } = await supabase!
        .from('scheduled_messages')
        .insert({
          organization_id: input.organizationId,
          conversation_id: input.conversationId,
          channel_id: input.channelId,
          contact_id: input.contactId ?? null,
          content: input.content,
          scheduled_at: input.scheduledAt,
          created_by: input.createdBy ?? null,
        })
        .select('*')
        .single();
      if (error) throw error;
      return transform(data as DbScheduledMessage);
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: keyFor(created.conversationId) });
    },
  });
};

/** Cancela uma mensagem programada ainda pendente. */
export const useCancelScheduledMessage = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ id, conversationId }: { id: string; conversationId: string }) => {
      const { error } = await supabase!
        .from('scheduled_messages')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('status', 'pending');
      if (error) throw error;
      return { id, conversationId };
    },
    onSuccess: ({ conversationId }) => {
      queryClient.invalidateQueries({ queryKey: keyFor(conversationId) });
    },
  });
};
