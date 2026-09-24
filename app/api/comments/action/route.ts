import { NextRequest, NextResponse } from 'next/server';
import { createClient, createStaticAdminClient } from '@/lib/supabase/server';

type ActionBody = { action?: 'hide' | 'delete'; postId?: string; commentId?: string; accountId?: string };
type RemoteComment = { id?: string; from?: { isOwner?: boolean }; replies?: RemoteComment[] };

function channelForAccount(channels: Array<{ credentials: unknown }>, accountId: string) {
  return channels.map(({ credentials }) => credentials as Record<string, unknown>).find((credentials) => {
    const ids = Array.isArray(credentials?.commentAccountIds) ? credentials.commentAccountIds.filter((id): id is string => typeof id === 'string') : [];
    if (typeof credentials?.accountId === 'string') ids.push(credentials.accountId);
    return typeof credentials?.apiKey === 'string' && ids.includes(accountId);
  });
}

function findComment(items: RemoteComment[], id: string): RemoteComment | undefined {
  for (const item of items) { if (item.id === id) return item; const nested = findComment(item.replies ?? [], id); if (nested) return nested; }
}

export async function POST(request: NextRequest) {
  const [supabase, body] = await Promise.all([createClient(), request.json() as Promise<ActionBody>]);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 });
  const action = body.action; const postId = body.postId?.trim(); const commentId = body.commentId?.trim(); const accountId = body.accountId?.trim();
  if (!action || !postId || !commentId || !accountId) return NextResponse.json({ message: 'Ação, post, comentário e conta são obrigatórios.' }, { status: 400 });
  const orgId = (user.app_metadata?.organization_id as string | undefined) ?? (await supabase.from('profiles').select('organization_id').eq('id', user.id).single()).data?.organization_id;
  if (!orgId) return NextResponse.json({ message: 'Perfil sem organização.' }, { status: 403 });
  const { data: channels } = await createStaticAdminClient().from('messaging_channels').select('credentials').eq('organization_id', orgId).eq('provider', 'zernio').eq('status', 'connected').limit(10);
  const credentials = channelForAccount(channels ?? [], accountId);
  if (!credentials?.apiKey || typeof credentials.apiKey !== 'string') return NextResponse.json({ message: 'A conta social não está conectada a esta organização.' }, { status: 403 });
  const base = `https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(postId)}`;
  if (action === 'delete') {
    const threadResponse = await fetch(`${base}?accountId=${encodeURIComponent(accountId)}&limit=100`, { headers: { Authorization: `Bearer ${credentials.apiKey}` }, cache: 'no-store' });
    const thread = await threadResponse.json().catch(() => ({}));
    const comment = threadResponse.ok ? findComment(thread.comments ?? [], commentId) : undefined;
    if (!comment?.from?.isOwner) return NextResponse.json({ message: 'Por segurança, somente respostas identificadas pela Zernio como suas podem ser excluídas.' }, { status: 403 });
  }
  const response = action === 'hide'
    ? await fetch(`${base}/${encodeURIComponent(commentId)}/hide`, { method: 'POST', headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId }) })
    : await fetch(`${base}?accountId=${encodeURIComponent(accountId)}&commentId=${encodeURIComponent(commentId)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${credentials.apiKey}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return NextResponse.json({ message: data?.error ?? 'A Zernio recusou esta ação.' }, { status: response.status });
  return NextResponse.json({ ok: true, data });
}
