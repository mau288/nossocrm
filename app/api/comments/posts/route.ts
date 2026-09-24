import { NextRequest, NextResponse } from 'next/server';
import { createClient, createStaticAdminClient } from '@/lib/supabase/server';

function allowedIds(credentials: Record<string, unknown>) {
  const ids = Array.isArray(credentials.commentAccountIds) ? credentials.commentAccountIds.filter((id): id is string => typeof id === 'string') : [];
  if (typeof credentials.accountId === 'string') ids.push(credentials.accountId);
  return new Set(ids);
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ message: 'Não autorizado.' }, { status: 401 });
  const orgId = (user.app_metadata?.organization_id as string | undefined) ?? (await supabase.from('profiles').select('organization_id').eq('id', user.id).single()).data?.organization_id;
  const { data: channels } = await createStaticAdminClient().from('messaging_channels').select('credentials').eq('organization_id', orgId ?? '').eq('provider', 'zernio').eq('status', 'connected').limit(1);
  const credentials = channels?.[0]?.credentials as Record<string, unknown> | undefined;
  const apiKey = typeof credentials?.apiKey === 'string' ? credentials.apiKey : null;
  if (!apiKey) return NextResponse.json({ message: 'Canal Zernio não conectado.' }, { status: 403 });
  const platform = request.nextUrl.searchParams.get('platform');
  if (platform && !['instagram', 'youtube'].includes(platform)) return NextResponse.json({ message: 'Plataforma inválida.' }, { status: 400 });
  // A caixa de Comentários nasce focada em interação. Posts sem comentário só
  // entram quando a UI pede explicitamente a visualização ampliada.
  const includeEmpty = request.nextUrl.searchParams.get('includeEmpty') === 'true';
  const query = new URLSearchParams({ minComments: includeEmpty ? '0' : '1', limit: '100', sortBy: 'date', sortOrder: 'desc' });
  if (platform) query.set('platform', platform);
  const response = await fetch(`https://zernio.com/api/v1/inbox/comments?${query}`, { headers: { Authorization: `Bearer ${apiKey}` }, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return NextResponse.json({ message: data?.error ?? 'Não foi possível listar os posts.' }, { status: response.status });
  const allowed = allowedIds(credentials ?? {});
  return NextResponse.json({ posts: (data.data ?? []).filter((post: { accountId?: string }) => post.accountId && allowed.has(post.accountId)) });
}
