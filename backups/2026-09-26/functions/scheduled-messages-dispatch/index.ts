// =============================================================================
// Scheduled Messages Dispatch — Edge Function
// =============================================================================
// Chamada a cada minuto pelo pg_cron (via pg_net). Envia as mensagens
// programadas vencidas (status pending, scheduled_at <= now) pelo provider do
// canal (Evolution ou Zernio) e marca sent/failed.
//
// A mensagem enviada NÃO é inserida em messaging_messages aqui: o espelho do
// canal (webhook fromMe / message.sent) grava na conversa automaticamente,
// mantendo uma única fonte de verdade.
//
// Auth: header x-dispatch-secret deve bater com SCHEDULED_DISPATCH_SECRET.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ScheduledRow = {
  id: string;
  conversation_id: string;
  channel_id: string;
  content: string;
};

type ChannelRow = {
  id: string;
  provider: string;
  credentials: Record<string, string> | null;
};

type ConversationRow = {
  id: string;
  external_contact_id: string;
};

async function sendViaEvolution(
  credentials: Record<string, string>,
  phone: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const serverUrl = (credentials.serverUrl ?? "").replace(/\/+$/, "");
  const instance = credentials.instanceName ?? "";
  const apiKey = credentials.apiKey ?? "";
  if (!serverUrl || !instance || !apiKey) {
    return { ok: false, error: "Canal Evolution sem credenciais completas" };
  }

  const number = phone.replace(/[^0-9]/g, "");
  try {
    const resp = await fetch(`${serverUrl}/message/sendText/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { apikey: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ number, text }),
    });
    if (!resp.ok) {
      return { ok: false, error: `Evolution respondeu ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Falha de rede na Evolution" };
  }
}

async function sendViaZernio(
  credentials: Record<string, string>,
  conversationExternalId: string,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = credentials.apiKey ?? "";
  const accountId = credentials.accountId ?? "";
  if (!apiKey || !accountId) {
    return { ok: false, error: "Canal Zernio sem credenciais completas" };
  }
  try {
    const resp = await fetch(
      `https://zernio.com/api/v1/inbox/conversations/${encodeURIComponent(conversationExternalId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accountId, message: text }),
      }
    );
    if (!resp.ok) {
      return { ok: false, error: `Zernio respondeu ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Falha de rede na Zernio" };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json(405, { error: "Método não permitido" });
  }

  const secret = Deno.env.get("SCHEDULED_DISPATCH_SECRET");
  if (!secret || req.headers.get("x-dispatch-secret") !== secret) {
    return json(401, { error: "Não autorizado" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: "Supabase não configurado no runtime" });
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  // Lote pequeno por execução (roda a cada minuto; evita estourar o tempo)
  const { data: due, error: dueErr } = await supabase
    .from("scheduled_messages")
    .select("id, conversation_id, channel_id, content")
    .eq("status", "pending")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .limit(10);

  if (dueErr) {
    console.error("[Dispatch] erro lendo pendentes:", dueErr);
    return json(500, { error: dueErr.message });
  }

  const results: Record<string, string> = {};

  for (const row of (due ?? []) as ScheduledRow[]) {
    // Claim otimista: só processa se ainda estiver pending (evita corrida
    // entre execuções sobrepostas do cron).
    const { data: claimed } = await supabase
      .from("scheduled_messages")
      .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (!claimed) continue; // outra execução pegou

    const fail = async (error: string) => {
      await supabase
        .from("scheduled_messages")
        .update({ status: "failed", error, sent_at: null, updated_at: new Date().toISOString() })
        .eq("id", row.id);
      results[row.id] = `failed: ${error}`;
    };

    const { data: channel } = await supabase
      .from("messaging_channels")
      .select("id, provider, credentials")
      .eq("id", row.channel_id)
      .maybeSingle();

    const { data: conversation } = await supabase
      .from("messaging_conversations")
      .select("id, external_contact_id")
      .eq("id", row.conversation_id)
      .maybeSingle();

    if (!channel || !conversation) {
      await fail("Canal ou conversa não encontrados");
      continue;
    }

    const ch = channel as ChannelRow;
    const conv = conversation as ConversationRow;
    const credentials = (ch.credentials ?? {}) as Record<string, string>;

    let sent: { ok: boolean; error?: string };
    if (ch.provider === "evolution") {
      sent = await sendViaEvolution(credentials, conv.external_contact_id, row.content);
    } else if (ch.provider === "zernio") {
      sent = await sendViaZernio(credentials, conv.external_contact_id, row.content);
    } else {
      sent = { ok: false, error: `Provider não suportado: ${ch.provider}` };
    }

    if (!sent.ok) {
      await fail(sent.error ?? "Falha desconhecida no envio");
      continue;
    }

    results[row.id] = "sent";
  }

  return json(200, { ok: true, processed: Object.keys(results).length, results });
});
