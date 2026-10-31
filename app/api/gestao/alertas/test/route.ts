import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createStaticAdminClient } from '@/lib/supabase/staticAdminClient';

export const maxDuration = 30;

const PAINEL_URL = 'https://crm.arkacademy.com.br/reports?view=gestao';

async function sendViaEvolution(credentials: Record<string, string>, phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
  const serverUrl = (credentials.serverUrl ?? '').replace(/\/+$/, '');
  const instance = credentials.instanceName ?? '';
  const apiKey = credentials.apiKey ?? '';
  if (!serverUrl || !instance || !apiKey) return { ok: false, error: 'Canal Evolution sem credenciais completas' };
  const number = phone.replace(/[^0-9]/g, '');
  try {
    const resp = await fetch(`${serverUrl}/message/sendText/${encodeURIComponent(instance)}`, {
      method: 'POST',
      headers: { apikey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number, text }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return { ok: false, error: `Evolution respondeu ${resp.status} ${t.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Falha de rede na Evolution' };
  }
}

/**
 * POST /api/gestao/alertas/test — ARK Onda 3 (3.4).
 * Manda a mensagem de teste dos alertas para os destinatarios salvos, pelo chip configurado.
 * So admin. Mesmo envio da edge function gestao-alertas, mas feito aqui porque o segredo do
 * cron nao fica na Vercel; o log entra como alert_type = 'test'.
 */
export async function POST() {
  try {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: profile } = await supabase.from('profiles').select('organization_id, role').eq('id', user.id).single();
    if (!profile?.organization_id) return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    if (profile.role !== 'admin') return NextResponse.json({ error: 'Só administradores podem testar os alertas' }, { status: 403 });

    const admin = createStaticAdminClient();
    const { data: s } = await admin.from('gestao_alert_settings').select('channel_id, recipients').eq('organization_id', profile.organization_id).maybeSingle();
    if (!s) return NextResponse.json({ ok: false, sent: 0, detail: 'salve a configuração primeiro' });

    const recipients = (Array.isArray(s.recipients) ? (s.recipients as Array<{ name?: string; phone: string }>) : []).filter(
      (r) => r && typeof r.phone === 'string' && r.phone.replace(/\D/g, '').length >= 10
    );
    if (!s.channel_id) return NextResponse.json({ ok: false, sent: 0, detail: 'sem chip de envio' });
    if (recipients.length === 0) return NextResponse.json({ ok: false, sent: 0, detail: 'sem destinatários' });

    const { data: channel } = await admin
      .from('messaging_channels')
      .select('id, name, provider, credentials, organization_id')
      .eq('id', s.channel_id)
      .eq('organization_id', profile.organization_id)
      .maybeSingle();
    if (!channel || channel.provider !== 'evolution') return NextResponse.json({ ok: false, sent: 0, detail: 'chip não é Evolution' });

    const text = `✅ *Teste de alerta do CRM*\nOs alertas de gestão vão chegar por este número (chip ${channel.name}).\n${PAINEL_URL}`;
    let sent = 0;
    const erros: string[] = [];
    for (const r of recipients) {
      const res = await sendViaEvolution((channel.credentials ?? {}) as Record<string, string>, r.phone, text);
      if (res.ok) sent++;
      else erros.push(`${r.phone}: ${res.error}`);
    }

    await admin.from('gestao_alert_log').insert({
      organization_id: profile.organization_id,
      alert_type: 'test',
      message: text,
      recipients,
      sent_ok: sent > 0,
      error: erros.length ? erros.join(' | ').slice(0, 1000) : null,
    });

    return NextResponse.json({ ok: sent > 0, sent, failed: erros.length, detail: erros.join(' | ') || undefined });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || 'Erro inesperado' }, { status: 500 });
  }
}
