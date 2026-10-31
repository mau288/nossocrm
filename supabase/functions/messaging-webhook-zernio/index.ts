// =============================================================================
// Zernio (Instagram + TikTok) Webhook — Edge Function
// =============================================================================
// Receives Zernio events (message.received / message.sent / conversation.started)
// and persists them as CRM conversations + messages, mirroring the structure of
// messaging-webhook-evolution.
//
// URL pattern (multi-tenant): /messaging-webhook-zernio/{channelId}
//   A URL aponta para o canal do Instagram; eventos de outra conta da mesma
//   chave (TikTok) são roteados para o canal com aquele accountId (ARK #52).
//
// Auth (default-deny):
//   1. HMAC-SHA256 signature of the RAW body, hex lowercase, in the
//      `x-zernio-signature` (or `x-late-signature`) header, verified against
//      the channel's `credentials.webhookSecret` or the global
//      ZERNIO_WEBHOOK_SECRET env.
//   2. If no secret is configured anywhere, an `x-api-key` header matching the
//      channel's `credentials.apiKey` is accepted as fallback.
//   Never accepted without one of the two.
//
// Addressing model: for zernio channels, `external_contact_id` of the CRM
// conversation IS the Zernio conversation id (a DM thread maps 1:1 to a
// participant). Sending from the CRM uses that same id.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

// =============================================================================
// HELPERS
// =============================================================================

/**
 * ARK (Onda 0 / 0.2): o supabase-js lanca PostgrestError, que NAO e instanceof Error —
 * por isso todo erro de banco virava "Unknown error" no log. Extrai code/message/details
 * de qualquer coisa que chegue.
 */
function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    const parts = [e.code, e.message, e.details, e.hint].filter((x) => typeof x === "string" && x) as string[];
    if (parts.length) return parts.join(" | ").slice(0, 500);
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      /* ignore */
    }
  }
  return String(error ?? "Unknown error");
}

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  if (e.code === "23505") return true;
  return typeof e.message === "string" && /duplicate key|unique constraint/i.test(e.message);
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-api-key, x-zernio-signature, x-late-signature",
};

type Obj = Record<string, unknown>;

function asObj(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

function readText(obj: Obj | null | undefined, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function parseDate(value: string | null): Date {
  if (!value) return new Date();
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? new Date() : when;
}

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

/** HMAC-SHA256 of the raw body, hex lowercase (Zernio signature scheme). */
async function hmacHex(secret: string, raw: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(raw));
  return Array.from(new Uint8Array(signed), (b) => b.toString(16).padStart(2, "0")).join("");
}

// =============================================================================
// AI TRIGGER (same contract as the Evolution function)
// =============================================================================

async function triggerAIProcessing(params: {
  conversationId: string;
  organizationId: string;
  messageText: string;
  messageId?: string;
}): Promise<void> {
  const appUrl = Deno.env.get("APP_URL") || Deno.env.get("CRM_APP_URL") || "http://localhost:3000";
  const internalSecret = Deno.env.get("INTERNAL_API_SECRET");

  if (!internalSecret) {
    console.warn("[Zernio] INTERNAL_API_SECRET not set, skipping AI processing");
    return;
  }

  try {
    const response = await fetch(`${appUrl}/api/messaging/ai/process`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": internalSecret,
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      console.error(`[Zernio] AI processing failed: ${response.status} ${await response.text()}`);
      return;
    }
    console.log("[Zernio] AI processing result:", await response.json());
  } catch (error) {
    console.error("[Zernio] AI processing fetch error:", error);
  }
}

// =============================================================================
// LEAD ROUTING (same behavior as the Evolution function)
// =============================================================================

async function getLeadRoutingRule(
  supabase: ReturnType<typeof createClient>,
  channelId: string
): Promise<{ boardId: string; stageId: string | null } | null> {
  const { data, error } = await supabase
    .from("lead_routing_rules")
    .select("board_id, stage_id, enabled")
    .eq("channel_id", channelId)
    .maybeSingle();

  if (error) {
    console.error("[Zernio] Error fetching lead routing rule:", error);
    return null;
  }
  if (!data || !data.enabled || !data.board_id) return null;
  return { boardId: data.board_id, stageId: data.stage_id };
}

async function autoCreateDeal(
  supabase: ReturnType<typeof createClient>,
  params: {
    organizationId: string;
    contactId: string;
    boardId: string;
    stageId?: string | null;
    conversationId: string;
    contactName: string;
    channelLabel?: string;
  }
) {
  try {
    let stageId = params.stageId;

    if (!stageId) {
      const { data: firstStage, error: stageErr } = await supabase
        .from("board_stages")
        .select("id")
        .eq("board_id", params.boardId)
        .order("order", { ascending: true })
        .limit(1)
        .single();

      if (stageErr || !firstStage) {
        console.error("[Zernio] Could not find first stage for auto-create deal:", stageErr);
        return;
      }
      stageId = firstStage.id;
    }

    const { data: newDeal, error: dealErr } = await supabase
      .from("deals")
      .insert({
        organization_id: params.organizationId,
        board_id: params.boardId,
        stage_id: stageId,
        contact_id: params.contactId,
        title: `${params.contactName} - ${params.channelLabel ?? "Instagram"}`,
        value: 0,
      })
      .select("id")
      .single();

    if (dealErr) {
      console.error("[Zernio] Error auto-creating deal:", dealErr);
      return;
    }

    const { data: conv, error: convMetaErr } = await supabase
      .from("messaging_conversations")
      .select("metadata")
      .eq("id", params.conversationId)
      .maybeSingle();

    if (convMetaErr) {
      console.error("[Zernio] Failed to read conversation metadata:", convMetaErr);
      return;
    }

    const { error: metaUpdateErr } = await supabase
      .from("messaging_conversations")
      .update({
        metadata: {
          ...((conv?.metadata as Record<string, unknown>) || {}),
          deal_id: newDeal.id,
          auto_created_deal: true,
        },
      })
      .eq("id", params.conversationId);

    if (metaUpdateErr) {
      console.error("[Zernio] Failed to update conversation metadata:", metaUpdateErr);
    }
  } catch (error) {
    console.error("[Zernio] Unexpected error in autoCreateDeal:", error);
  }
}

// =============================================================================
// EVENT NORMALIZATION
// =============================================================================

type NormalizedMessage = {
  conversationExternalId: string;
  externalMessageId: string | null;
  direction: "inbound" | "outbound";
  text: string | null;
  attachments: { type: string | null; url: string }[];
  senderName: string | null;
  senderUsername: string | null;
  senderAvatar: string | null;
  timestamp: Date;
};

/**
 * Normalizes message.received / message.sent payloads. Zernio vocabulary:
 * direction "incoming"/"outgoing", conversationId, platformMessageId, text may
 * be null when there is only an attachment.
 */
function normalizeMessageEvent(root: Obj): NormalizedMessage | null {
  const message = asObj(root["message"]);
  if (!message) return null;

  const conversation = asObj(root["conversation"]);
  const conversationExternalId =
    readText(message, ["conversationId"]) ?? readText(conversation, ["id"]);
  if (!conversationExternalId) return null;

  const direction =
    (readText(message, ["direction"]) ?? "incoming").toLowerCase() === "outgoing"
      ? "outbound"
      : "inbound";

  const sender = asObj(message["sender"]);
  // On outbound the sender is the business; contact identity comes from the
  // conversation participant.
  const senderName =
    direction === "outbound"
      ? readText(conversation, ["participantName"])
      : readText(sender, ["name"]) ?? readText(conversation, ["participantName"]);
  const senderUsername =
    direction === "outbound"
      ? readText(conversation, ["participantUsername"])
      : readText(sender, ["username"]) ?? readText(conversation, ["participantUsername"]);
  const senderAvatar =
    readText(sender, ["avatar", "avatarUrl", "profilePic"]) ??
    readText(conversation, ["participantPicture", "participantAvatar"]);

  const { attachments, templateText } = parseAttachments(message["attachments"]);

  return {
    conversationExternalId,
    externalMessageId: readText(message, ["id", "platformMessageId"]),
    direction,
    text: joinText(readText(message, ["text"]), templateText),
    attachments,
    senderName,
    senderUsername,
    senderAvatar,
    timestamp: parseDate(readText(message, ["sentAt"]) ?? readText(root, ["timestamp"])),
  };
}

/**
 * Automações (ManyChat etc.) mandam "cartões": o texto fica dentro de um
 * template (payload.generic.elements[].title + botões), não em `text`, e o
 * anexo não tem `url`. Sem isso a mensagem chega vazia e é descartada.
 */
function parseAttachments(raw: unknown): {
  attachments: { type: string | null; url: string }[];
  templateText: string | null;
} {
  const attachments: { type: string | null; url: string }[] = [];
  const parts: string[] = [];
  const items = Array.isArray(raw) ? raw : [];

  const pushButtons = (buttons: unknown) => {
    if (!Array.isArray(buttons)) return;
    for (const b of buttons) {
      const title = readText(asObj(b), ["title"]);
      if (title) parts.push(`▸ ${title}`);
    }
  };

  for (const item of items) {
    const att = asObj(item);
    if (!att) continue;
    const type = readText(att, ["type"]);

    if ((type ?? "").toLowerCase() === "template") {
      const payload = asObj(att["payload"]);
      const generic = asObj(payload?.["generic"]);
      const elements = Array.isArray(generic?.["elements"]) ? (generic!["elements"] as unknown[]) : [];
      for (const el of elements) {
        const e = asObj(el);
        if (!e) continue;
        const title = readText(e, ["title"]);
        const subtitle = readText(e, ["subtitle"]);
        if (title) parts.push(title);
        if (subtitle) parts.push(subtitle);
        const image = readText(e, ["image_url", "imageUrl"]);
        if (image) attachments.push({ type: "image", url: image });
        pushButtons(e["buttons"]);
      }
      // button template: { payload: { text, buttons } }
      const plain = readText(payload, ["text"]);
      if (plain) parts.push(plain);
      pushButtons(payload?.["buttons"]);
      continue;
    }

    const url = readText(att, ["url"]);
    if (!url) continue;
    attachments.push({ type, url });
  }

  return { attachments, templateText: parts.length ? parts.join("\n\n") : null };
}

function joinText(a: string | null, b: string | null): string | null {
  if (a && b) return `${a}\n\n${b}`;
  return a ?? b ?? null;
}

function contentFor(norm: NormalizedMessage): { contentType: string; content: Obj } {
  const first = norm.attachments[0];
  if (first) {
    const kind = (first.type ?? "").toLowerCase();
    const mapped = kind.includes("image")
      ? "image"
      : kind.includes("video")
        ? "video"
        : kind.includes("audio")
          ? "audio"
          : "document";
    return {
      contentType: mapped,
      content: {
        mediaUrl: first.url,
        ...(norm.text ? { caption: norm.text } : {}),
        ...(norm.attachments.length > 1
          ? { extraAttachments: norm.attachments.slice(1) }
          : {}),
      },
    };
  }
  return { contentType: "text", content: { text: norm.text ?? "" } };
}

function previewFor(norm: NormalizedMessage): string {
  if (norm.text) return norm.text;
  const first = norm.attachments[0];
  if (first) return `[${first.type ?? "anexo"}]`;
  return "[Mensagem]";
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json(405, { error: "Método não permitido" });
  }

  // Extract channelId from URL path (multi-tenant auth pattern)
  const url = new URL(req.url);
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const channelId = url.pathname.match(uuidRegex)?.[0] ?? null;
  if (!channelId) {
    return json(400, { error: "channel_id ausente na URL" });
  }

  // Raw body FIRST: the signature is computed over it.
  const rawBody = await req.text();

  let payload: Obj;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    const obj = asObj(parsed);
    if (!obj) throw new Error("not an object");
    payload = obj;
  } catch {
    return json(400, { error: "JSON inválido" });
  }

  // Setup Supabase client
  const supabaseUrl = Deno.env.get("CRM_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL");
  const serviceKey =
    Deno.env.get("CRM_SUPABASE_SECRET_KEY") ??
    Deno.env.get("CRM_SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceKey) {
    return json(500, { error: "Supabase não configurado no runtime" });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Fetch channel by ID (not by account — avoids attacker-controlled lookup)
  const { data: urlChannel, error: channelErr } = await supabase
    .from("messaging_channels")
    .select("id, organization_id, business_unit_id, channel_type, external_identifier, status, credentials")
    .eq("id", channelId)
    .eq("provider", "zernio")
    .in("status", ["connected", "active"])
    .maybeSingle();

  if (channelErr) {
    console.error("[Zernio] Error fetching channel:", channelErr);
    return json(200, { ok: false, error: "Erro ao buscar canal" });
  }

  if (!urlChannel) {
    return json(200, { ok: false, error: "Canal não encontrado" });
  }

  // ---------------------------------------------------------------------------
  // AUTH — default deny.
  // ---------------------------------------------------------------------------
  const credentials = (urlChannel.credentials as Record<string, string>) ?? {};
  const signatureSecret = Deno.env.get("ZERNIO_WEBHOOK_SECRET") ?? credentials.webhookSecret;
  const signatureHeader =
    req.headers.get("x-zernio-signature") ?? req.headers.get("x-late-signature");

  let authorized = false;

  if (signatureSecret && signatureHeader) {
    const expected = await hmacHex(signatureSecret, rawBody);
    const received = signatureHeader.trim().toLowerCase().replace(/^sha256=/, "");
    authorized = await timingSafeEqual(expected, received);
  }

  if (!authorized) {
    // Fallback: shared key header (used until Zernio hands us a signing secret)
    const apiKeyHeader = req.headers.get("x-api-key") ?? "";
    const expectedKey = credentials.apiKey ?? "";
    if (apiKeyHeader && expectedKey) {
      authorized = await timingSafeEqual(apiKeyHeader.trim(), expectedKey);
    }
  }

  if (!authorized) {
    return json(401, { error: "Assinatura/chave inválida" });
  }

  const event = (readText(payload, ["event"]) ?? "unknown").toLowerCase();

  // ---------------------------------------------------------------------------
  // ROTEAMENTO POR CONTA (ARK #52)
  // A Zernio manda TODAS as contas (Instagram, TikTok, YouTube) para o mesmo
  // webhook, cuja URL aponta para o canal do Instagram. Quando o evento é de
  // outra conta, trocamos para o canal que tem aquele accountId (mesma
  // organização, mesma chave). Conta sem canal no CRM → só auditoria.
  // ---------------------------------------------------------------------------
  const eventAccountId = readText(asObj(payload["account"]), ["id", "accountId"]);
  let channel = urlChannel;
  if (eventAccountId && eventAccountId !== credentials.accountId) {
    const { data: sibling } = await supabase
      .from("messaging_channels")
      .select("id, organization_id, business_unit_id, channel_type, external_identifier, status, credentials")
      .eq("organization_id", urlChannel.organization_id)
      .eq("provider", "zernio")
      .in("status", ["connected", "active"])
      .eq("credentials->>accountId", eventAccountId)
      .maybeSingle();
    if (sibling) channel = sibling;
  }
  const accountRouted =
    !eventAccountId ||
    readText((channel.credentials as Obj | null) ?? null, ["accountId"]) === eventAccountId;

  // ---------------------------------------------------------------------------
  // AUDIT LOGGING & DEDUPLICATION
  // ---------------------------------------------------------------------------
  const message = asObj(payload["message"]);
  const conversation = asObj(payload["conversation"]);
  const stableId =
    readText(message, ["id", "platformMessageId"]) ??
    readText(conversation, ["id"]) ??
    (await hmacHex("zernio-event", rawBody)).slice(0, 32);
  if (event === "crm.backfill") {
    const offset = Number(readText(payload, ["offset"]) ?? 0) || 0;
    const limit = Math.min(Number(readText(payload, ["limit"]) ?? 40) || 40, 60);
    const result = await backfillChannel(supabase, channel as unknown as ChannelRow, offset, limit);
    return json(200, { ok: true, event, ...result });
  }

  // Carga inicial de uma conta (ARK #52): lista as conversas da conta na
  // Zernio e cria no CRM as que ainda não existem, com histórico. Usado ao
  // ligar um canal novo cujas DMs chegaram antes de o CRM escutá-las.
  if (event === "crm.import_conversations") {
    if (!accountRouted) return json(400, { ok: false, error: "Conta sem canal no CRM" });
    const limit = Math.min(Number(readText(payload, ["limit"]) ?? 50) || 50, 100);
    const result = await importAccountConversations(supabase, channel as unknown as ChannelRow, limit);
    return json(200, { ok: true, event, ...result });
  }

  // Vínculo explícito do YouTube: antes de persistir, confirmamos pela própria
  // API Zernio que a conta pertence à chave do canal desta organização.
  if (event === "crm.authorize_youtube_comment_account") {
    const accountId = readText(payload, ["accountId"]);
    const channelRow = channel as unknown as ChannelRow;
    const current = (channelRow.credentials ?? {}) as Record<string, unknown>;
    const apiKey = typeof current["apiKey"] === "string" ? current["apiKey"] : null;
    if (!accountId || !apiKey) return json(400, { ok: false, error: "Conta/canal inválido" });
    const verify = await fetch(`${ZERNIO_API}/accounts?platform=youtube`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const verified = verify.ok ? (await verify.json()) as Obj : {};
    const accounts = Array.isArray(verified["accounts"]) ? verified["accounts"] : Array.isArray(verified["data"]) ? verified["data"] : [];
    const belongsToChannel = accounts.some((raw) => {
      const account = asObj(raw);
      return account && readText(account, ["id", "_id", "accountId"]) === accountId && readText(account, ["platform"])?.toLowerCase() === "youtube";
    });
    if (!belongsToChannel) return json(403, { ok: false, error: "Conta YouTube não pertence à integração" });
    const configured = Array.isArray(current["commentAccountIds"])
      ? (current["commentAccountIds"] as unknown[]).filter((id): id is string => typeof id === "string")
      : [];
    const primary = typeof current["accountId"] === "string" ? [current["accountId"]] : [];
    const ids = Array.from(new Set([...primary, ...configured, accountId]));
    const { error } = await supabase.from("messaging_channels").update({ credentials: { ...current, commentAccountIds: ids } }).eq("id", channelId);
    if (error) return json(500, { ok: false, error: "Não foi possível autorizar a conta" });
    return json(200, { ok: true, event, accountId, allowedAccountIds: ids });
  }

  const externalEventId = `zernio:${event}:${stableId}`;

  const { error: eventInsertErr } = await supabase
    .from("messaging_webhook_events")
    .insert({
      channel_id: channel.id,
      event_type: event,
      external_event_id: externalEventId,
      payload: payload as unknown as Record<string, unknown>,
      processed: false,
    });

  if (eventInsertErr?.message?.toLowerCase().includes("duplicate")) {
    console.log(`[Zernio] Duplicate event ignored: ${externalEventId}`);
    return json(200, { ok: true, duplicate: true, event_id: externalEventId });
  }

  if (eventInsertErr) {
    console.error("[Zernio] Error logging webhook event:", eventInsertErr);
  }

  try {
    if (!accountRouted) {
      console.log(`[Zernio] evento de conta sem canal no CRM (${eventAccountId}) — só auditoria`);
    } else if (event === "message.received" || event === "message.sent") {
      await handleMessage(supabase, channel, payload);
    } else if (event === "conversation.started") {
      await handleConversationStarted(supabase, channel, payload);
    } else {
      // comment.received and everything else: audit-logged, not processed (v1)
      console.log(`[Zernio] Unhandled event: ${event}`);
    }

    await supabase
      .from("messaging_webhook_events")
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq("channel_id", channel.id)
      .eq("external_event_id", externalEventId);

    return json(200, { ok: true, event });
  } catch (error) {
    console.error("[Zernio] Webhook processing error:", error);

    await supabase
      .from("messaging_webhook_events")
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
        error: errMsg(error),
      })
      .eq("channel_id", channel.id)
      .eq("external_event_id", externalEventId);

    // Always return 200 to avoid retry storms
    return json(200, {
      ok: false,
      error: "Erro ao processar webhook",
      details: errMsg(error),
    });
  }
});

// =============================================================================
// EVENT HANDLERS
// =============================================================================

type ChannelRow = {
  id: string;
  organization_id: string;
  business_unit_id: string;
  channel_type: string;
  external_identifier: string;
  credentials?: Record<string, unknown> | null;
};

const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };
function platformLabel(channel: ChannelRow): string {
  return PLATFORM_LABEL[channel.channel_type] ?? channel.channel_type;
}

/**
 * Ensures contact + conversation exist for a Zernio conversation id and
 * returns the conversation. Contact identity: Instagram has no phone, so the
 * contact is created with source "instagram" and the Zernio ids in metadata
 * are kept on the conversation (external_contact_id = Zernio conversation id).
 */
async function ensureConversation(
  supabase: ReturnType<typeof createClient>,
  channel: ChannelRow,
  params: {
    conversationExternalId: string;
    displayName: string | null;
    username: string | null;
    avatar: string | null;
    identityTrusted?: boolean;
  }
): Promise<{ conversationId: string; contactId: string | null; created: boolean }> {
  const placeholder = `Contato do ${platformLabel(channel)}`;
  const trustedDisplayName = params.identityTrusted ? params.displayName : null;
  const trustedUsername = params.identityTrusted ? params.username : null;
  const contactName =
    trustedDisplayName ?? (trustedUsername ? `@${trustedUsername.replace(/^@/, "")}` : null) ?? placeholder;
  const hasRealName = contactName !== placeholder;

  const { data: existingConv, error: convFindErr } = await supabase
    .from("messaging_conversations")
    .select("id, contact_id, external_contact_name")
    .eq("channel_id", channel.id)
    .eq("external_contact_id", params.conversationExternalId)
    .maybeSingle();

  if (convFindErr) throw convFindErr;

  if (existingConv) {
    // conversation.started chega com participantName vazio e cria o registro
    // genérico; quando um evento posterior traz o nome real, promovemos.
    if (params.identityTrusted && hasRealName && existingConv.external_contact_name !== contactName) {
      await supabase
        .from("messaging_conversations")
        .update({
          external_contact_name: contactName,
          ...(params.avatar ? { external_contact_avatar: params.avatar } : {}),
        })
        .eq("id", existingConv.id);

      if (existingConv.contact_id) {
        await supabase
          .from("contacts")
          .update({
            name: contactName,
            ...(params.avatar ? { avatar: params.avatar } : {}),
          })
          .eq("id", existingConv.contact_id)
          .in("name", [placeholder, existingConv.external_contact_name]);
      }
    }
    return { conversationId: existingConv.id, contactId: existingConv.contact_id, created: false };
  }

  // ARK (Onda 2B): porta unica de identidade. Instagram/TikTok nao tem telefone, mas tem o @:
  // a RPC procura por @ (instagram_username / tiktok_username) e reaproveita o contato em vez
  // de criar um por conversa. Sem @ confiavel (conversation.started vazio), cria o placeholder.
  // (Onda 2A) DM automatica/abordagem sem resposta nao vira contato (lifecycle 'conversa');
  // a promocao acontece por trigger (resposta/negocio) ou pelo botao em Mensagens.
  let contactId: string | null = null;
  const usernameKey = channel.channel_type === "tiktok" ? "p_tiktok_username" : "p_instagram_username";
  const { data: identity, error: contactCreateErr } = await supabase.rpc("upsert_contact_identity", {
    p_organization_id: channel.organization_id,
    p_name: hasRealName ? contactName : null,
    [usernameKey]: trustedUsername,
    p_source: channel.channel_type,
    p_channel: channel.channel_type,
    p_lifecycle: "conversa",
    p_avatar: params.avatar,
  });

  if (contactCreateErr) {
    console.error("[Zernio] upsert_contact_identity:", contactCreateErr);
  } else if (identity && typeof identity === "object" && (identity as { contact_id?: string }).contact_id) {
    contactId = (identity as { contact_id: string }).contact_id;
  }

  const { data: newConv, error: convCreateErr } = await supabase
    .from("messaging_conversations")
    .insert({
      organization_id: channel.organization_id,
      channel_id: channel.id,
      business_unit_id: channel.business_unit_id,
      external_contact_id: params.conversationExternalId,
      external_contact_name: contactName,
      ...(params.avatar ? { external_contact_avatar: params.avatar } : {}),
      contact_id: contactId,
      status: "open",
      priority: "normal",
      metadata: {
        zernio_conversation_id: params.conversationExternalId,
        ...(params.username ? { [`${channel.channel_type}_username`]: params.username } : {}),
      },
    })
    .select("id")
    .single();

  if (convCreateErr) {
    // ARK (Onda 0 / 0.2): message.received e conversation.started chegam com ~30 ms de
    // diferenca e os dois passam pelo "nao existe" acima. O segundo INSERT viola
    // messaging_conversations_unique (channel_id, external_contact_id). Em vez de derrubar
    // o evento (era a 3a DM do TikTok perdida em 24/10), relemos a conversa que o outro
    // criou e descartamos o contato orfao que acabamos de inserir.
    if (isUniqueViolation(convCreateErr)) {
      const { data: raced } = await supabase
        .from("messaging_conversations")
        .select("id, contact_id")
        .eq("channel_id", channel.id)
        .eq("external_contact_id", params.conversationExternalId)
        .maybeSingle();
      if (raced) {
        if (contactId && contactId !== raced.contact_id) {
          await supabase.from("contacts").delete().eq("id", contactId);
        }
        return { conversationId: raced.id, contactId: raced.contact_id, created: false };
      }
    }
    throw convCreateErr;
  }

  // Auto-create deal if lead routing rule exists
  if (contactId) {
    const routingRule = await getLeadRoutingRule(supabase, channel.id);
    if (routingRule) {
      await autoCreateDeal(supabase, {
        organizationId: channel.organization_id,
        contactId,
        boardId: routingRule.boardId,
        stageId: routingRule.stageId,
        conversationId: newConv.id,
        contactName,
        channelLabel: platformLabel(channel),
      });
    }
  }

  return { conversationId: newConv.id, contactId, created: true };
}

async function handleMessage(
  supabase: ReturnType<typeof createClient>,
  channel: ChannelRow,
  payload: Obj
) {
  const norm = normalizeMessageEvent(payload);
  if (!norm) {
    console.warn("[Zernio] message event could not be normalized");
    return;
  }

  // Nothing to store (e.g. reaction-only events)
  if (!norm.text && norm.attachments.length === 0) return;

  const { conversationId } = await ensureConversation(supabase, channel, {
    conversationExternalId: norm.conversationExternalId,
    displayName: norm.senderName,
    username: norm.senderUsername,
    avatar: norm.senderAvatar,
    identityTrusted: norm.direction === "inbound",
  });

  const inserted = await storeMessage(supabase, conversationId, norm, channel.channel_type);
  if (!inserted) return;
  const { contentType, content } = contentFor(norm);
  const isOutbound = norm.direction === "outbound";
  const insertedMsg = { id: inserted };

  // Only trigger AI for inbound text messages
  if (!isOutbound && contentType === "text" && insertedMsg?.id) {
    const textContent = (content as { text?: string }).text;
    if (textContent) {
      triggerAIProcessing({
        conversationId,
        organizationId: channel.organization_id,
        messageText: textContent,
        messageId: insertedMsg.id,
      }).catch((err) => {
        console.error("[Zernio] AI processing trigger error:", err);
      });
    }
  }

  // A Zernio não dispara webhook para tudo que sai por fora dela (ManyChat e
  // outras automações). Quando a conversa se mexe, buscamos o fio recente e
  // completamos o que faltar.
  await syncConversationHistory(supabase, channel, norm.conversationExternalId, conversationId).catch(
    (err) => console.error("[Zernio] sync error:", err)
  );
}

/**
 * Grava a mensagem se ela ainda não existe. Retorna o id novo, ou null quando
 * já estava lá. Dedup em duas camadas: external_id (índice único) e, como o
 * webhook e a API da Zernio usam ids diferentes para a mesma mensagem,
 * direção + texto + horário próximo.
 */
async function storeMessage(
  supabase: ReturnType<typeof createClient>,
  conversationId: string,
  norm: NormalizedMessage,
  platform = "instagram"
): Promise<string | null> {
  const { contentType, content } = contentFor(norm);
  const isOutbound = norm.direction === "outbound";
  const preview = previewFor(norm);

  const windowMs = 90_000;
  const { data: near } = await supabase
    .from("messaging_messages")
    .select("id, external_id, content, content_type")
    .eq("conversation_id", conversationId)
    .eq("direction", norm.direction)
    .gte("created_at", new Date(norm.timestamp.getTime() - windowMs).toISOString())
    .lte("created_at", new Date(norm.timestamp.getTime() + windowMs).toISOString());

  const myText = (norm.text ?? "").trim();
  for (const row of near ?? []) {
    if (norm.externalMessageId && row.external_id === norm.externalMessageId) return null;
    const c = (row.content ?? {}) as { text?: string; caption?: string };
    const existing = (c.text ?? c.caption ?? "").trim();
    if (myText && existing === myText) return null;
    if (!myText && !existing && row.content_type === contentType) return null;
  }

  const { data: insertedMsg, error: msgErr } = await supabase
    .from("messaging_messages")
    .insert({
      conversation_id: conversationId,
      external_id: norm.externalMessageId,
      direction: norm.direction,
      content_type: contentType,
      content,
      status: isOutbound ? "sent" : "delivered",
      // A tela ordena por created_at: mensagem que entra atrasada (sync)
      // precisa cair no lugar certo do fio, não no fim.
      created_at: norm.timestamp.toISOString(),
      ...(isOutbound
        ? { sent_at: norm.timestamp.toISOString() }
        : { delivered_at: norm.timestamp.toISOString() }),
      sender_name: isOutbound ? null : norm.senderName ?? norm.senderUsername,
      metadata: {
        zernio_conversation_id: norm.conversationExternalId,
        ...(norm.senderUsername ? { [`${platform}_username`]: norm.senderUsername } : {}),
      },
    })
    .select("id")
    .maybeSingle();

  if (msgErr) {
    if (isUniqueViolation(msgErr)) return null;
    throw msgErr;
  }

  // Só avança a "última mensagem" se esta for de fato a mais nova.
  const { data: conv } = await supabase
    .from("messaging_conversations")
    .select("last_message_at")
    .eq("id", conversationId)
    .maybeSingle();
  const newer = !conv?.last_message_at || new Date(conv.last_message_at as string) <= norm.timestamp;

  const { error: convUpdateErr } = await supabase
    .from("messaging_conversations")
    .update({
      ...(newer
        ? {
            last_message_at: norm.timestamp.toISOString(),
            last_message_preview: preview.slice(0, 100),
            last_message_direction: norm.direction,
          }
        : {}),
      ...(isOutbound
        ? {}
        : {
            status: "open",
            window_expires_at: new Date(norm.timestamp.getTime() + 24 * 60 * 60 * 1000).toISOString(),
          }),
    })
    .eq("id", conversationId);
  if (convUpdateErr) {
    console.error("[Zernio] Failed to update conversation:", convUpdateErr, { conversationId });
  }

  return insertedMsg?.id ?? null;
}

const ZERNIO_API = "https://zernio.com/api/v1";

/** Mensagem vinda da API de inbox (vocabulário: `message`, `createdAt`). */
function normalizeApiMessage(conversationExternalId: string, m: Obj): NormalizedMessage | null {
  if (m["isDeleted"] === true) return null;
  const direction =
    (readText(m, ["direction"]) ?? "incoming").toLowerCase() === "outgoing" ? "outbound" : "inbound";
  const { attachments, templateText } = parseAttachments(m["attachments"]);
  const text = joinText(readText(m, ["message", "text"]), templateText);
  if (!text && attachments.length === 0) return null;
  return {
    conversationExternalId,
    externalMessageId: readText(m, ["id"]),
    direction,
    text,
    attachments,
    senderName: direction === "inbound" ? readText(m, ["senderName"]) : null,
    senderUsername: null,
    senderAvatar: null,
    timestamp: parseDate(readText(m, ["sentAt", "createdAt"])),
  };
}

async function syncConversationHistory(
  supabase: ReturnType<typeof createClient>,
  channel: ChannelRow,
  conversationExternalId: string,
  conversationId: string,
  mode: "recent" | "full" = "recent"
): Promise<number> {
  const creds = (channel.credentials ?? {}) as Record<string, string>;
  if (!creds.apiKey || !creds.accountId) return 0;

  // recent: só as 50 últimas (dia a dia). full: fio inteiro, página a página
  // pelo cursor (a API entrega no máximo 100 por vez).
  const base =
    `${ZERNIO_API}/inbox/conversations/${encodeURIComponent(conversationExternalId)}/messages` +
    `?accountId=${encodeURIComponent(creds.accountId)}&limit=${mode === "full" ? 100 : 50}` +
    `&sortOrder=${mode === "full" ? "asc" : "desc"}`;

  let added = 0;
  let cursor: string | null = null;
  const maxPages = mode === "full" ? 30 : 1;

  for (let page = 0; page < maxPages; page++) {
    const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${creds.apiKey}` } });
    if (!res.ok) {
      console.warn(`[Zernio] sync ${conversationExternalId}: HTTP ${res.status}`);
      break;
    }
    const body = (await res.json()) as Obj;
    const list = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];

    for (const raw of list) {
      const m = asObj(raw);
      if (!m) continue;
      const norm = normalizeApiMessage(conversationExternalId, m);
      if (!norm) continue;
      if (await storeMessage(supabase, conversationId, norm, channel.channel_type)) added++;
    }

    const pagination = asObj(body["pagination"]);
    const next = readText(pagination, ["nextCursor"]);
    // o cursor é inclusivo: a 1ª mensagem da página seguinte repete a última
    // desta — o dedup absorve.
    if (pagination?.["hasMore"] !== true || !next || next === cursor) break;
    cursor = next;
  }

  if (added) console.log(`[Zernio] sync ${conversationExternalId} (${mode}): +${added}`);
  return added;
}

/**
 * Carga do que ficou para trás: percorre as conversas do canal e sincroniza
 * cada uma. Disparado manualmente (event "crm.backfill"), em lotes.
 */
async function backfillChannel(
  supabase: ReturnType<typeof createClient>,
  channel: ChannelRow,
  offset: number,
  limit: number
) {
  const { data: convs, error } = await supabase
    .from("messaging_conversations")
    .select("id, external_contact_id, external_contact_name")
    .eq("channel_id", channel.id)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  let added = 0;
  const details: { id: string; name: string; added: number }[] = [];
  for (const c of convs ?? []) {
    const n = await syncConversationHistory(
      supabase,
      channel,
      c.external_contact_id as string,
      c.id as string,
      "full"
    );
    added += n;
    details.push({ id: c.id as string, name: c.external_contact_name as string, added: n });
    // limite da Zernio: 60 req/min
    await new Promise((r) => setTimeout(r, 1100));
  }
  return { processed: convs?.length ?? 0, added, nextOffset: offset + (convs?.length ?? 0), details };
}

/**
 * Carga inicial de uma conta (ARK #52): percorre as conversas da conta na
 * Zernio, garante contato + conversa no CRM e puxa o fio inteiro de cada uma.
 * Quando a lista vem sem nome do participante, promove o nome pelo remetente
 * da primeira mensagem recebida.
 */
async function importAccountConversations(
  supabase: ReturnType<typeof createClient>,
  channel: ChannelRow,
  limit: number
) {
  const creds = (channel.credentials ?? {}) as Record<string, string>;
  if (!creds.apiKey || !creds.accountId) return { processed: 0, created: 0, added: 0, details: [] };

  const res = await fetch(
    `${ZERNIO_API}/inbox/conversations?accountId=${encodeURIComponent(creds.accountId)}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${creds.apiKey}` } }
  );
  if (!res.ok) throw new Error(`Zernio conversations HTTP ${res.status}`);
  const body = (await res.json()) as Obj;
  const list = Array.isArray(body["data"]) ? (body["data"] as unknown[]) : [];

  let created = 0;
  let added = 0;
  const details: { id: string; name: string | null; created: boolean; added: number }[] = [];
  for (const raw of list) {
    const c = asObj(raw);
    const externalId = readText(c, ["id"]);
    if (!c || !externalId) continue;
    const displayName = readText(c, ["participantName"]);
    const username = readText(c, ["participantUsername"]);
    const ensured = await ensureConversation(supabase, channel, {
      conversationExternalId: externalId,
      displayName,
      username,
      avatar: readText(c, ["participantPicture", "participantAvatar"]),
      identityTrusted: true,
    });
    if (ensured.created) created++;
    const n = await syncConversationHistory(supabase, channel, externalId, ensured.conversationId, "full");
    added += n;

    if (!displayName && !username) {
      const { data: firstIn } = await supabase
        .from("messaging_messages")
        .select("sender_name")
        .eq("conversation_id", ensured.conversationId)
        .eq("direction", "inbound")
        .not("sender_name", "is", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (firstIn?.sender_name) {
        await ensureConversation(supabase, channel, {
          conversationExternalId: externalId,
          displayName: firstIn.sender_name as string,
          username: null,
          avatar: null,
          identityTrusted: true,
        });
      }
    }
    details.push({ id: externalId, name: displayName ?? username, created: ensured.created, added: n });
    // limite da Zernio: 60 req/min
    await new Promise((r) => setTimeout(r, 1100));
  }
  return { processed: list.length, created, added, details };
}

async function handleConversationStarted(
  supabase: ReturnType<typeof createClient>,
  channel: ChannelRow,
  payload: Obj
) {
  const conversation = asObj(payload["conversation"]);
  if (!conversation) return;

  const conversationExternalId = readText(conversation, ["id"]);
  if (!conversationExternalId) return;

  // conversation.started frequentemente chega ANTES da Zernio resolver o
  // perfil (participantName vazio). Criar aqui geraria o contato genérico
  // "Contato do Instagram" — deixamos o message.received (que traz o nome)
  // criar a conversa.
  const displayName = readText(conversation, ["participantName"]);
  const username = readText(conversation, ["participantUsername"]);
  if (!displayName && !username) {
    console.log("[Zernio] conversation.started sem participante resolvido — ignorando (message.received cria)");
    return;
  }

  await ensureConversation(supabase, channel, {
    conversationExternalId,
    displayName,
    username,
    avatar: readText(conversation, ["participantAvatar", "participantPicture"]),
  });
}
