/**
 * DELETE /api/messaging/messages/[messageId]
 *
 * ARK: "Apagar para todos". So mensagens enviadas por nos. No WhatsApp (Evolution) a mensagem e
 * revogada; no CRM a linha NAO e apagada — ganha metadata.deleted e a tela mostra
 * "Mensagem apagada" (o conteudo original fica guardado para auditoria).
 */
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const { messageId } = await params;
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
    }

    // RLS garante que so vem mensagem da organizacao do usuario
    const { data: message, error: msgError } = await supabase
      .from('messaging_messages')
      .select(
        `
        id, direction, external_id, metadata,
        conversation:messaging_conversations!conversation_id (
          id,
          external_contact_id,
          channel:messaging_channels!channel_id ( id, provider, credentials )
        )
      `
      )
      .eq('id', messageId)
      .single();

    if (msgError || !message) {
      return NextResponse.json({ message: 'Mensagem não encontrada.' }, { status: 404 });
    }
    if (message.direction !== 'outbound') {
      return NextResponse.json(
        { message: 'Só é possível apagar mensagens enviadas por você.' },
        { status: 400 }
      );
    }

    const metadata = { ...((message.metadata as Record<string, unknown> | null) ?? {}) };
    if (metadata.deleted) {
      return NextResponse.json({ ok: true, alreadyDeleted: true });
    }

    const conversation = message.conversation as unknown as {
      id: string;
      external_contact_id: string;
      channel: { id: string; provider: string; credentials: Record<string, string> | null } | null;
    } | null;

    // Mensagem que nunca chegou ao WhatsApp (sem id externo): apaga so no CRM
    if (message.external_id) {
      const channel = conversation?.channel;
      if (!channel || channel.provider !== 'evolution') {
        return NextResponse.json(
          { message: 'Apagar mensagem ainda não é suportado neste canal.' },
          { status: 400 }
        );
      }
      const serverUrl = (channel.credentials?.serverUrl ?? '').replace(/\/+$/, '');
      const instance = channel.credentials?.instanceName ?? '';
      const apiKey = channel.credentials?.apiKey ?? '';
      const digits = (conversation?.external_contact_id ?? '').replace(/\D/g, '');
      if (!serverUrl || !instance || !apiKey || !digits) {
        return NextResponse.json({ message: 'Canal sem credenciais completas.' }, { status: 400 });
      }

      const resp = await fetch(
        `${serverUrl}/chat/deleteMessageForEveryone/${encodeURIComponent(instance)}`,
        {
          method: 'DELETE',
          headers: { apikey: apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: message.external_id,
            remoteJid: `${digits}@s.whatsapp.net`,
            fromMe: true,
          }),
        }
      );
      if (!resp.ok) {
        const detail = (await resp.text().catch(() => '')).slice(0, 200);
        console.error('[messages/delete] Evolution recusou:', resp.status, detail);
        return NextResponse.json(
          {
            message:
              'O WhatsApp não aceitou apagar esta mensagem. Mensagens com mais de ~2 dias não podem mais ser apagadas para todos.',
          },
          { status: 502 }
        );
      }
    }

    metadata.deleted = true;
    metadata.deleted_at = new Date().toISOString();
    metadata.deleted_by = user.id;

    const { error: updateError } = await supabase
      .from('messaging_messages')
      .update({ metadata })
      .eq('id', messageId);
    if (updateError) {
      return NextResponse.json({ message: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[messages/delete]', error);
    return NextResponse.json({ message: 'Erro ao apagar a mensagem.' }, { status: 500 });
  }
}
