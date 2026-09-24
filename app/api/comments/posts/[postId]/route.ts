import { NextRequest, NextResponse } from 'next/server';
import { createClient, createStaticAdminClient } from '@/lib/supabase/server';

function allowedIds(credentials: Record<string, unknown>) {
  const ids = Array.isArray(credentials.commentAccountIds) ? credentials.commentAccountIds.filter((id): id is string => typeof id === 'string') : [];
  if (typeof credentials.accountId === 'string') ids.push(credentials.accountId);
  return new Set(ids);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ postId: string }> }) {
  const supabase = await createClient(); const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 });
  const orgId = (user.app_metadata?.organization_id as string | undefined) ?? (await supabase.from('profiles').select('organization_id').eq('id', user.id).single()).data?.organization_id;
  const { data: channels } = await createStaticAdminClient().from('messaging_channels').select('credentials').eq('organization_id', orgId ?? '').eq('provider', 'zernio').eq('status', 'connected').limit(1);
  const credentials = channels?.[0]?.credentials as Record<string, unknown> | undefined; const apiKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey : null;
  const accountId = request.nextUrl.searchParams.get('accountId');
  if (!apiKey || !accountId || !credentials || !allowedIds(credentials).has(accountId)) return NextResponse.json({ message: 'Conta não autorizada.' }, { status: 403 });
  const { postId } = await params;
  const response = await fetch(`https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(postId)}?accountId=${encodeURIComponent(accountId)}&limit=100`, { headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return NextResponse.json({ message: data?.error ?? 'Não foi possível carregar a thread.' }, { status: response.status });
  return NextResponse.json({ comments: data.comments ?? [] });
}
