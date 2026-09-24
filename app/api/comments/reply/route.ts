import { NextRequest, NextResponse } from 'next/server';
import { createClient, createStaticAdminClient } from '@/lib/supabase/server';

type ReplyBody = { postId?: string; commentId?: string; accountId?: string; message?: string };

export async function POST(request: NextRequest) {
  const [supabase, body] = await Promise.all([createClient(), request.json() as Promise<ReplyBody>]);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 });

  const postId = body.postId?.trim();
  const commentId = body.commentId?.trim();
  const accountId = body.accountId?.trim();
  const message = body.message?.trim();
  if (!postId || !commentId || !accountId || !message) {
    return NextResponse.json({ message: 'Post, comentário, conta e resposta são obrigatórios.' }, { status: 400 });
  }

  const orgId = (user.app_metadata?.organization_id as string | undefined) ??
    (await supabase.from('profiles').select('organization_id').eq('id', user.id).single()).data?.organization_id;
  if (!orgId) return NextResponse.json({ message: 'Perfil sem organização.' }, { status: 403 });

  // A chave da Zernio nunca vai ao navegador. Só a conta vinculada à organização
  // do usuário autenticado pode ser usada para responder.
  const admin = createStaticAdminClient();
  const { data: channels } = await admin
    .from('messaging_channels')
    .select('credentials')
    .eq('organization_id', orgId)
    .eq('provider', 'zernio')
    .eq('status', 'connected')
    .limit(10);
  const credentials = (channels ?? [])
    .map((item) => item.credentials as Record<string, unknown>)
    .find((item) => {
      const ids = Array.isArray(item?.commentAccountIds) ? item.commentAccountIds.filter((id): id is string => typeof id === 'string') : [];
      if (typeof item?.accountId === 'string') ids.push(item.accountId);
      return typeof item?.apiKey === 'string' && ids.includes(accountId);
    });
  if (!credentials?.apiKey || typeof credentials.apiKey !== 'string') {
    return NextResponse.json({ message: 'A conta social não está conectada a esta organização.' }, { status: 403 });
  }

  const response = await fetch(`https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(postId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentials.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId, commentId, message }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return NextResponse.json({ message: data?.error ?? 'A Zernio recusou a resposta.' }, { status: response.status });
  return NextResponse.json({ ok: true, data });
}
