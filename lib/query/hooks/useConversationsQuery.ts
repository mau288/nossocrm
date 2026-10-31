'use client';

/**
 * TanStack Query hooks for Messaging Conversations
 *
 * Features:
 * - Fetch conversations with filters
 * - Optimistic updates for instant UI feedback
 * - Automatic cache invalidation
 * - Realtime-ready (integrates with useRealtimeSyncMessaging)
 */
import {
  useQuery,
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { queryKeys } from '../index';
import { supabase } from '@/lib/supabase';
import { isRealtimeConnected } from '@/lib/realtime/status';
import { sanitizePostgrestValue } from '@/lib/utils/sanitize';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import type {
  DbMessagingConversation,
  MessagingConversation,
  ConversationView,
  ConversationFilters,
  UpdateConversationInput,
} from '@/lib/messaging/types';
import {
  transformConversation as transform,
  isWindowExpired as checkWindowExpired,
  getWindowMinutesRemaining as getWindowMinutes,
} from '@/lib/messaging/types';

// =============================================================================
// PENDING DELETION GUARD
// =============================================================================

/**
 * Module-level set of conversation IDs currently being deleted.
 *
 * Problem: Other mutations (e.g. markAsRead) have their own onSettled that calls
 * invalidateQueries(messagingConversations.all). If they complete while a delete
 * is in-flight, their refetch can return the conversation still in the DB
 * (the DELETE hasn't committed yet), overwriting the optimistic removal.
 *
 * Solution: addPendingDeletion() before starting the delete. The useConversations
 * `select` filter removes the ID from every query result until removePendingDeletion()
 * is called (in onSettled, after the mutation settles either way).
 */
export const pendingDeletionIds = new Set<string>();

export function addPendingDeletion(id: string): void {
  pendingDeletionIds.add(id);
}

export function removePendingDeletion(id: string): void {
  pendingDeletionIds.delete(id);
}

// =============================================================================
// QUERY HOOKS
// =============================================================================

// =============================================================================
// LISTA DE CONVERSAS — PAGINADA (ARK, Onda 1 / 1.1)
// =============================================================================

/** Tamanho da pagina da lista de conversas. */
export const CONVERSATIONS_PAGE_SIZE = 40;
/** Paginas mantidas em memoria (o polling refaz todas as carregadas). */
const CONVERSATIONS_MAX_PAGES = 5;

export interface ConversationsPage {
  rows: ConversationView[];
  nextOffset: number | null;
}

/** Colunas da conversa que a lista usa — antes era `select('*')` com 1.000 linhas (1,24 MB). */
const CONVERSATION_COLUMNS = [
  'id', 'organization_id', 'channel_id', 'business_unit_id', 'contact_id',
  'external_contact_id', 'external_contact_name', 'external_contact_avatar',
  'status', 'priority', 'assigned_user_id', 'assigned_at', 'window_expires_at',
  'unread_count', 'message_count', 'last_message_at', 'last_message_preview',
  'last_message_direction', 'metadata', 'created_at', 'updated_at',
].join(', ');

type EmbeddedChannel = { id: string; name: string; channel_type: string; provider: string } | null;
type EmbeddedContact = { id: string; name: string; email: string; phone: string; ai_paused?: boolean; tags?: string[] } | null;
type EmbeddedUser = { id: string; name: string; avatar_url: string } | null;

function toConversationView(row: Record<string, unknown>): ConversationView {
  const base = transform(row as unknown as DbMessagingConversation);
  const channel = row.channel as EmbeddedChannel;
  const contact = row.contact as EmbeddedContact;
  const assignedUser = row.assigned_user as EmbeddedUser;
  return {
    ...base,
    channelType: (channel?.channel_type || 'whatsapp') as ConversationView['channelType'],
    channelName: channel?.name || 'Canal',
    contactName: contact?.name,
    contactEmail: contact?.email,
    contactPhone: contact?.phone,
    contactAiPaused: contact?.ai_paused ?? false,
    assignedUserName: assignedUser?.name,
    assignedUserAvatar: assignedUser?.avatar_url,
    isWindowExpired: checkWindowExpired(base, channel?.provider),
    windowMinutesRemaining: getWindowMinutes(base),
  };
}

/**
 * Fetch conversations with optional filters — paginated (40 por pagina, offset).
 * `data` ja vem achatado em ConversationView[]; use `fetchNextPage`/`hasNextPage`
 * para carregar mais (sentinela no fim da lista).
 *
 * Antes: 1 query com TODAS as conversas (1.000 linhas, 1,24 MB), baixada 2x ao abrir,
 * a cada 20 s e a cada mensagem recebida.
 */
export function useConversations(filters?: ConversationFilters) {
  const { user, profile, loading: authLoading } = useAuth();

  return useInfiniteQuery({
    queryKey: queryKeys.messagingConversations.filtered(filters),
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<ConversationsPage> => {
      const offset = typeof pageParam === 'number' ? pageParam : 0;
      // ARK: filtro por tag do contato. Com tag, o join vira !inner (so conversas com contato
      // vinculado) e filtramos no contato embutido — "qualquer uma das tags" (overlaps).
      const tagFilter = (filters?.tags ?? []).filter(Boolean);
      const contactJoin = tagFilter.length ? 'contacts!contact_id!inner' : 'contacts!contact_id';
      // ARK (Onda 0 / 0.1): filtro de canal no SERVIDOR.
      const channelJoin = filters?.channelType
        ? 'messaging_channels!channel_id!inner'
        : 'messaging_channels!channel_id';

      let query = supabase
        .from('messaging_conversations')
        .select(`
          ${CONVERSATION_COLUMNS},
          channel:${channelJoin} (
            id,
            name,
            channel_type,
            provider
          ),
          contact:${contactJoin} (
            id,
            name,
            email,
            phone,
            ai_paused,
            tags
          ),
          assigned_user:profiles!assigned_user_id (
            id,
            name,
            avatar_url
          )
        `)
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(offset, offset + CONVERSATIONS_PAGE_SIZE - 1);

      // Defense-in-depth: filter by organization even though RLS handles it
      if (profile?.organization_id) {
        query = query.eq('organization_id', profile.organization_id);
      }

      // Apply filters
      if (filters?.status && filters.status !== 'all') {
        query = query.eq('status', filters.status);
      }
      if (filters?.channelId) {
        query = query.eq('channel_id', filters.channelId);
      }
      if (filters?.channelType) {
        query = query.eq('channel.channel_type', filters.channelType);
      }
      if (filters?.businessUnitId) {
        query = query.eq('business_unit_id', filters.businessUnitId);
      }
      if (filters?.assignedUserId === 'unassigned') {
        query = query.is('assigned_user_id', null);
      } else if (filters?.assignedUserId) {
        query = query.eq('assigned_user_id', filters.assignedUserId);
      }
      if (tagFilter.length) {
        query = query.overlaps('contact.tags', tagFilter);
      }
      if (filters?.hasUnread) {
        query = query.gt('unread_count', 0);
      }
      if (filters?.search) {
        const safe = sanitizePostgrestValue(filters.search);
        if (safe) {
          query = query.or(
            `external_contact_name.ilike.%${safe}%,last_message_preview.ilike.%${safe}%`
          );
        }
      }

      const { data, error } = await query;
      if (error) throw error;

      let rows = (data || []).map((row) => toConversationView(row as Record<string, unknown>));
      // Rede de seguranca: o servidor ja filtrou; isto so protege contra embed sem match.
      if (filters?.channelType) {
        rows = rows.filter((conv) => conv.channelType === filters.channelType);
      }
      const full = (data || []).length === CONVERSATIONS_PAGE_SIZE;
      return { rows, nextOffset: full ? offset + CONVERSATIONS_PAGE_SIZE : null };
    },
    getNextPageParam: (lastPage) => lastPage.nextOffset,
    maxPages: CONVERSATIONS_MAX_PAGES,
    staleTime: 30 * 1000, // 30 seconds
    // Rede de seguranca: o realtime e o caminho principal. Com o canal de pe, o polling
    // e so um "acerto" a cada 60 s; se o WebSocket cair, volta para 20 s.
    refetchInterval: () => (isRealtimeConnected() ? 60 * 1000 : 20 * 1000),
    refetchOnWindowFocus: true,
    enabled: !authLoading && !!user && !!profile?.organization_id,
    placeholderData: keepPreviousData,
    // Achata as paginas, tira duplicatas (offset + lista viva) e as conversas em exclusao.
    select: (data) => flattenConversationPages(data),
  });
}

export function flattenConversationPages(
  data: InfiniteData<ConversationsPage> | undefined
): ConversationView[] {
  if (!data) return [];
  const seen = new Set<string>();
  const out: ConversationView[] = [];
  for (const page of data.pages) {
    for (const conv of page.rows) {
      if (seen.has(conv.id)) continue;
      if (pendingDeletionIds.size > 0 && pendingDeletionIds.has(conv.id)) continue;
      seen.add(conv.id);
      out.push(conv);
    }
  }
  return out;
}

// =============================================================================
// CACHE DA LISTA — helpers compartilhados (mutations + realtime)
// =============================================================================

type ListCache = ConversationView[] | InfiniteData<ConversationsPage>;

function isInfinite(x: unknown): x is InfiniteData<ConversationsPage> {
  return !!x && typeof x === 'object' && Array.isArray((x as InfiniteData<ConversationsPage>).pages);
}

/**
 * Aplica `fn` a cada lista de conversas em cache (formato antigo = array; novo = paginas).
 * `fn` recebe a lista achatada e devolve a nova lista; as paginas sao refeitas com o
 * mesmo tamanho (a ultima absorve o que sobrar).
 */
export function updateConversationLists(
  queryClient: QueryClient,
  fn: (list: ConversationView[], queryKey: QueryKey) => ConversationView[]
): void {
  const entries = queryClient.getQueriesData<ListCache>({ queryKey: queryKeys.messagingConversations.all });
  for (const [key, old] of entries) {
    if (Array.isArray(old)) {
      const next = fn(old, key);
      if (next !== old) queryClient.setQueryData<ListCache>(key, next);
      continue;
    }
    if (!isInfinite(old)) continue;
    const flat = old.pages.flatMap((p) => p.rows);
    const next = fn(flat, key);
    if (next === flat) continue;
    const sizes = old.pages.map((p) => p.rows.length);
    const pages: ConversationsPage[] = [];
    let cursor = 0;
    for (let i = 0; i < old.pages.length; i++) {
      const isLast = i === old.pages.length - 1;
      const take = isLast ? next.length - cursor : Math.min(sizes[i], Math.max(0, next.length - cursor));
      pages.push({ ...old.pages[i], rows: next.slice(cursor, cursor + Math.max(0, take)) });
      cursor += Math.max(0, take);
    }
    queryClient.setQueryData<ListCache>(key, { ...old, pages });
  }
}

/**
 * Le os filtros embutidos na queryKey de uma lista (ver queryKeys.messagingConversations.filtered).
 */
function filtersFromKey(queryKey: QueryKey): { status: string | null; hasUnread: boolean | null; isPlainList: boolean } {
  const i = queryKey.indexOf('filtered');
  if (i === -1) return { status: null, hasUnread: null, isPlainList: false };
  const [status, channelId, channelType, businessUnitId, assignedUserId, hasUnread, search, tags] =
    queryKey.slice(i + 1) as Array<string | boolean | null>;
  const isPlainList = !channelId && !channelType && !assignedUserId && !search && !tags;
  void businessUnitId;
  return {
    status: typeof status === 'string' ? status : null,
    hasUnread: typeof hasUnread === 'boolean' ? hasUnread : null,
    isPlainList,
  };
}

function matchesListFilters(conv: ConversationView, f: ReturnType<typeof filtersFromKey>): boolean {
  if (f.status && f.status !== 'all' && conv.status !== f.status) return false;
  if (f.hasUnread && !(conv.unreadCount > 0)) return false;
  return true;
}

function sortByLastMessage(list: ConversationView[]): ConversationView[] {
  return [...list].sort((a, b) => {
    const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : -1;
    const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : -1;
    return tb - ta;
  });
}

/**
 * ARK (Onda 1 / 1.2): evento realtime de UPDATE em messaging_conversations vira um PATCH
 * do item no cache (previa, nao lida, janela, ordem) em vez de refazer a lista inteira.
 * Devolve true se a conversa estava em pelo menos uma lista; false = ninguem a conhece
 * (conversa fora das paginas carregadas) e o chamador decide se refaz a busca.
 */
export function patchConversationFromRow(queryClient: QueryClient, row: Record<string, unknown>): boolean {
  const base = transform(row as unknown as DbMessagingConversation);
  let found = false;
  updateConversationLists(queryClient, (list, key) => {
    const idx = list.findIndex((c) => c.id === base.id);
    if (idx === -1) return list;
    found = true;
    const prev = list[idx];
    const merged: ConversationView = {
      ...prev,
      ...base,
      windowMinutesRemaining: getWindowMinutes(base),
      isWindowExpired: prev.windowExpiresAt === base.windowExpiresAt
        ? prev.isWindowExpired
        : checkWindowExpired(base, prev.channelType === 'whatsapp' ? undefined : 'zernio'),
    };
    const f = filtersFromKey(key);
    if (!matchesListFilters(merged, f)) {
      return list.filter((c) => c.id !== base.id);
    }
    const next = list.slice();
    next[idx] = merged;
    return prev.lastMessageAt === merged.lastMessageAt ? next : sortByLastMessage(next);
  });

  queryClient.setQueryData<ConversationView | null>(
    queryKeys.messagingConversations.detail(base.id),
    (old) => (old ? { ...old, ...base, windowMinutesRemaining: getWindowMinutes(base) } : old)
  );
  return found;
}

/** Previa curta de uma mensagem (mesma regra do webhook: texto/legenda ou tipo). */
function previewFromMessageRow(row: Record<string, unknown>): string {
  const content = (row.content ?? {}) as Record<string, unknown>;
  const text = (content.text ?? content.caption) as string | undefined;
  if (text) return text.slice(0, 100);
  switch (row.content_type) {
    case 'image': return '📷 Foto';
    case 'video': return '🎥 Vídeo';
    case 'audio': return '🎤 Áudio';
    case 'document': return '📄 Documento';
    case 'sticker': return '🏷️ Figurinha';
    case 'location': return '📍 Localização';
    default: return 'Mensagem';
  }
}

/**
 * ARK (Onda 1 / 1.2): mensagem nova (INSERT em messaging_messages) atualiza a conversa na
 * lista na hora — previa, horario, direcao, nao lidas — sem esperar o UPDATE da conversa.
 * Devolve true se a conversa estava em alguma lista.
 */
export function patchConversationFromMessage(queryClient: QueryClient, row: Record<string, unknown>): boolean {
  const conversationId = row.conversation_id as string | undefined;
  if (!conversationId) return false;
  const createdAt = (row.created_at as string | undefined) ?? new Date().toISOString();
  const direction = row.direction as ConversationView['lastMessageDirection'];
  const preview = previewFromMessageRow(row);
  let found = false;
  updateConversationLists(queryClient, (list, key) => {
    const idx = list.findIndex((c) => c.id === conversationId);
    if (idx === -1) return list;
    found = true;
    const prev = list[idx];
    // Mensagem atrasada (sync) nao vira "ultima mensagem".
    if (prev.lastMessageAt && Date.parse(prev.lastMessageAt) > Date.parse(createdAt)) return list;
    const merged: ConversationView = {
      ...prev,
      lastMessageAt: createdAt,
      lastMessagePreview: preview,
      lastMessageDirection: direction,
      unreadCount: direction === 'inbound' ? prev.unreadCount + 1 : prev.unreadCount,
      status: direction === 'inbound' ? 'open' : prev.status,
    };
    const f = filtersFromKey(key);
    if (!matchesListFilters(merged, f)) return list.filter((c) => c.id !== conversationId);
    const next = list.slice();
    next[idx] = merged;
    return sortByLastMessage(next);
  });
  return found;
}

/**
 * Fetch a single conversation by ID.
 */
export function useConversation(conversationId: string | undefined) {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingConversations.detail(conversationId || ''),
    queryFn: async (): Promise<ConversationView | null> => {
      const { data, error } = await supabase
        .from('messaging_conversations')
        .select(`
          *,
          channel:messaging_channels!channel_id (
            id,
            name,
            channel_type,
            provider
          ),
          contact:contacts!contact_id (
            id,
            name,
            email,
            phone,
            ai_paused
          ),
          assigned_user:profiles!assigned_user_id (
            id,
            name,
            avatar_url
          )
        `)
        .eq('id', conversationId!)
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;

      const base = transform(data as DbMessagingConversation);
      const channel = data.channel as { id: string; name: string; channel_type: string; provider: string } | null;
      const contact = data.contact as { id: string; name: string; email: string; phone: string; ai_paused?: boolean } | null;
      const assignedUser = data.assigned_user as { id: string; name: string; avatar_url: string } | null;

      return {
        ...base,
        channelType: (channel?.channel_type || 'whatsapp') as ConversationView['channelType'],
        channelName: channel?.name || 'Canal',
        contactName: contact?.name,
        contactEmail: contact?.email,
        contactPhone: contact?.phone,
        contactAiPaused: contact?.ai_paused ?? false,
        assignedUserName: assignedUser?.name,
        assignedUserAvatar: assignedUser?.avatar_url,
        isWindowExpired: checkWindowExpired(base, channel?.provider),
        windowMinutesRemaining: getWindowMinutes(base),
      };
    },
    staleTime: 30 * 1000,
    refetchOnWindowFocus: true,
    enabled: !authLoading && !!user && !!conversationId,
  });
}

/**
 * Fetch unread conversations count.
 */
export function useUnreadCount() {
  const { user, loading: authLoading } = useAuth();

  return useQuery({
    queryKey: queryKeys.messagingConversations.unreadCount(),
    queryFn: async (): Promise<number> => {
      const { count, error } = await supabase
        .from('messaging_conversations')
        .select('*', { count: 'exact', head: true })
        .gt('unread_count', 0)
        .eq('status', 'open');

      if (error) throw error;
      return count || 0;
    },
    staleTime: 60 * 1000, // 60s - realtime subscription handles live updates
    refetchOnWindowFocus: false,
    enabled: !authLoading && !!user,
  });
}

// =============================================================================
// MUTATION HOOKS
// =============================================================================

/**
 * Update a conversation (status, priority, assignment).
 */
export function useUpdateConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      conversationId,
      updates,
    }: {
      conversationId: string;
      updates: UpdateConversationInput;
    }) => {
      // Transform to snake_case for DB
      const dbUpdates: Record<string, unknown> = {};
      if (updates.status !== undefined) dbUpdates.status = updates.status;
      if (updates.priority !== undefined) dbUpdates.priority = updates.priority;
      if (updates.assignedUserId !== undefined) {
        dbUpdates.assigned_user_id = updates.assignedUserId;
        dbUpdates.assigned_at = updates.assignedUserId ? new Date().toISOString() : null;
      }

      const { error } = await supabase
        .from('messaging_conversations')
        .update(dbUpdates)
        .eq('id', conversationId);

      if (error) throw error;
      return { conversationId, updates };
    },
    onMutate: async ({ conversationId, updates }) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({
        queryKey: queryKeys.messagingConversations.all,
      });

      // Snapshot previous value
      const previousConversations = queryClient.getQueriesData({
        queryKey: queryKeys.messagingConversations.all,
      });

      // Optimistically update list caches (array antigo ou paginas novas).
      updateConversationLists(queryClient, (list) =>
        list.map((conv) => (conv.id === conversationId ? { ...conv, ...updates } : conv))
      );

      // Also optimistically update the detail query so the header dropdown
      // reflects the change immediately without waiting for the refetch.
      queryClient.setQueryData(
        queryKeys.messagingConversations.detail(conversationId),
        (old: ConversationView | null | undefined) => {
          if (!old) return old;
          return { ...old, ...updates };
        }
      );

      return { previousConversations };
    },
    onError: (_error, _variables, context) => {
      // Rollback on error
      if (context?.previousConversations) {
        for (const [queryKey, data] of context.previousConversations) {
          queryClient.setQueryData(queryKey, data);
        }
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.all,
      });
    },
  });
}

/**
 * Mark conversation as read (reset unread count).
 */
export function useMarkConversationRead() {
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      // RPC SECURITY DEFINER (ja existia no banco). O UPDATE direto na tabela nunca chegou a
      // zerar o badge em producao e falhava em silencio; a RPC nao depende de RLS e o erro
      // (se houver) agora aparece no toast.
      const { error } = await supabase.rpc('mark_conversation_read', {
        p_conversation_id: conversationId,
      });

      if (error) throw error;
      return conversationId;
    },
    onError: (error) => {
      addToast(`Nao consegui marcar a conversa como lida: ${(error as Error).message}`, 'error');
    },
    onMutate: async (conversationId) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.messagingConversations.all,
      });

      // Optimistically set unread to 0
      updateConversationLists(queryClient, (list) =>
        list.map((conv) => (conv.id === conversationId ? { ...conv, unreadCount: 0 } : conv))
      );
    },
    onSettled: () => {
      // Skip conversations-list invalidation while a delete is in-progress.
      // The delete mutation handles cache cleanup directly, and invalidating here
      // triggers a refetch that can return the conversation from DB before it's
      // fully deleted, causing it to flash back into the list.
      if (pendingDeletionIds.size === 0) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.messagingConversations.all,
        });
      }
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.unreadCount(),
      });
    },
  });
}

/**
 * Resolve (close) a conversation.
 */
export function useResolveConversation() {
  const updateMutation = useUpdateConversation();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      return updateMutation.mutateAsync({
        conversationId,
        updates: { status: 'resolved' },
      });
    },
  });
}

/**
 * Reopen a conversation.
 */
export function useReopenConversation() {
  const updateMutation = useUpdateConversation();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      return updateMutation.mutateAsync({
        conversationId,
        updates: { status: 'open' },
      });
    },
  });
}

/**
 * Assign conversation to a user.
 */
export function useAssignConversation() {
  const updateMutation = useUpdateConversation();

  return useMutation({
    mutationFn: async ({
      conversationId,
      userId,
    }: {
      conversationId: string;
      userId: string | null;
    }) => {
      return updateMutation.mutateAsync({
        conversationId,
        updates: { assignedUserId: userId },
      });
    },
  });
}

/**
 * Delete a conversation and all its messages.
 * Use with caution - this is a destructive action.
 */
export function useDeleteConversation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (conversationId: string) => {
      // Delete messages first (FK constraint)
      const { error: messagesError } = await supabase
        .from('messaging_messages')
        .delete()
        .eq('conversation_id', conversationId);

      if (messagesError) throw messagesError;

      // Then delete conversation
      const { error: conversationError } = await supabase
        .from('messaging_conversations')
        .delete()
        .eq('id', conversationId);

      if (conversationError) throw conversationError;

      return conversationId;
    },
    onSuccess: (deletedId) => {
      // Cancel any in-flight refetches triggered by realtime during the mutation.
      // The messaging_messages DELETE event fires before the conversation is deleted,
      // causing a refetch that returns the conversation still in the list and overwrites
      // the optimistic removal. Cancelling here prevents that race condition.
      queryClient.cancelQueries({ queryKey: queryKeys.messagingConversations.all });

      // Remove detail query so onSettled invalidateQueries doesn't refetch it
      queryClient.removeQueries({
        queryKey: queryKeys.messagingConversations.detail(deletedId),
      });
      // Remove from list caches
      updateConversationLists(queryClient, (list) => list.filter((conv) => conv.id !== deletedId));
    },
    onSettled: () => {
      // NOTE: removePendingDeletion is intentionally NOT called here.
      // The guard must stay up until the messaging_conversations DELETE realtime event
      // arrives (in useRealtimeSync). The DB trigger that runs on messages DELETE fires a
      // conversations UPDATE event that arrives via WebSocket AFTER this HTTP onSettled —
      // if we lower the guard here, that UPDATE queues a refetch that re-shows the deleted
      // conversation before the DELETE realtime event cleans it up.
      //
      // NOTE: invalidateQueries(messagingConversations.all) is intentionally omitted.
      // onSuccess already removed the conversation from cache; an extra invalidation here
      // races with the still-pending DB trigger and can re-fetch a stale row.
      queryClient.invalidateQueries({
        queryKey: queryKeys.messagingConversations.unreadCount(),
      });
    },
  });
}
