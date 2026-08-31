// =============================================================================
// Zernio (Instagram) Webhook — Edge Function
// =============================================================================
// Receives Zernio events (message.received / message.sent / conversation.started)
// and persists them as CRM conversations + messages, mirroring the structure of
// messaging-webhook-evolution.
//
// URL pattern (multi-tenant): /messaging-webhook-zernio/{channelId}
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
        title: `${params.contactName} - Instagram`,
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

  const platform = (readText(message, ["platform"]) ?? "instagram").toLowerCase();
  if (platform !== "instagram") return null;

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

  const attachments: { type: string | null; url: string }[] = [];
  const rawAttachments = Array.isArray(message["attachments"]) ? (message["attachments"] as unknown[]) : [];
  for (const item of rawAttachments) {
    const att = asObj(item);
    if (!att) continue;
    const url = readText(att, ["url"]);
    if (!url) continue;
    attachments.push({ type: readText(att, ["type"]), url });
  }

  return {
    conversationExternalId,
    externalMessageId: readText(message, ["id", "platformMessageId"]),
    direction,
    text: readText(message, ["text"]),
    attachments,
    senderName,
    senderUsername,
    senderAvatar,
    timestamp: parseDate(readText(message, ["sentAt"]) ?? readText(root, ["timestamp"])),
  };
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
  const { data: channel, error: channelErr } = await supabase
    .from("messaging_channels")
    .select("id, organization_id, business_unit_id, external_identifier, status, credentials")
    .eq("id", channelId)
    .eq("provider", "zernio")
    .in("status", ["connected", "active"])
    .maybeSingle();

  if (channelErr) {
    console.error("[Zernio] Error fetching channel:", channelErr);
    return json(200, { ok: false, error: "Erro ao buscar canal" });
  }

  if (!channel) {
    return json(200, { ok: false, error: "Canal não encontrado" });
  }

  // ---------------------------------------------------------------------------
  // AUTH — default deny.
  // ---------------------------------------------------------------------------
  const credentials = (channel.credentials as Record<string, string>) ?? {};
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
  // AUDIT LOGGING & DEDUPLICATION
  // ---------------------------------------------------------------------------
  const message = asObj(payload["message"]);
  const conversation = asObj(payload["conversation"]);
  const stableId =
    readText(message, ["id", "platformMessageId"]) ??
    readText(conversation, ["id"]) ??
    (await hmacHex("zernio-event", rawBody)).slice(0, 32);
  const externalEventId = `zernio:${event}:${stableId}`;

  const { error: eventInsertErr } = await supabase
    .from("messaging_webhook_events")
    .insert({
      channel_id: channelId,
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
    if (event === "message.received" || event === "message.sent") {
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
      .eq("channel_id", channelId)
      .eq("external_event_id", externalEventId);

    return json(200, { ok: true, event });
  } catch (error) {
    console.error("[Zernio] Webhook processing error:", error);

    await supabase
      .from("messaging_webhook_events")
      .update({
        processed: true,
        processed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown error",
      })
      .eq("channel_id", channelId)
      .eq("external_event_id", externalEventId);

    // Always return 200 to avoid retry storms
    return json(200, {
      ok: false,
      error: "Erro ao processar webhook",
      details: error instanceof Error ? error.message : "Unknown error",
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
  external_identifier: string;
};

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
  }
): Promise<{ conversationId: string; contactId: string | null; created: boolean }> {
  const contactName =
    params.displayName ?? (params.username ? `@${params.username.replace(/^@/, "")}` : null) ?? "Contato do Instagram";
  const hasRealName = contactName !== "Contato do Instagram";

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
    if (hasRealName && existingConv.external_contact_name === "Contato do Instagram") {
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
          .eq("name", "Contato do Instagram");
      }
    }
    return { conversationId: existingConv.id, contactId: existingConv.contact_id, created: false };
  }

  // Instagram has no phone: dedup by name+source would be unsafe, so each new
  // DM thread creates its own contact (merge later via the dedup tools).
  let contactId: string | null = null;
  const { data: newContact, error: contactCreateErr } = await supabase
    .from("contacts")
    .insert({
      organization_id: channel.organization_id,
      name: contactName,
      source: "instagram",
      ...(params.avatar ? { avatar: params.avatar } : {}),
    })
    .select("id")
    .single();

  if (contactCreateErr) {
    console.error("[Zernio] Error auto-creating contact:", contactCreateErr);
  } else {
    contactId = newContact.id;
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
        ...(params.username ? { instagram_username: params.username } : {}),
      },
    })
    .select("id")
    .single();

  if (convCreateErr) throw convCreateErr;

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
  });

  const { contentType, content } = contentFor(norm);
  const isOutbound = norm.direction === "outbound";

  const { data: insertedMsg, error: msgErr } = await supabase
    .from("messaging_messages")
    .insert({
      conversation_id: conversationId,
      external_id: norm.externalMessageId,
      direction: norm.direction,
      content_type: contentType,
      content,
      status: isOutbound ? "sent" : "delivered",
      ...(isOutbound
        ? { sent_at: norm.timestamp.toISOString() }
        : { delivered_at: norm.timestamp.toISOString() }),
      sender_name: isOutbound ? null : norm.senderName ?? norm.senderUsername,
      metadata: {
        zernio_conversation_id: norm.conversationExternalId,
        ...(norm.senderUsername ? { instagram_username: norm.senderUsername } : {}),
      },
    })
    .select("id")
    .maybeSingle();

  if (msgErr) {
    if (!msgErr.message.toLowerCase().includes("duplicate")) {
      throw msgErr;
    }
    console.log(`[Zernio] Duplicate message ignored: ${norm.externalMessageId}`);
    return;
  }

  // Update conversation — reopen and refresh the 24h response window on inbound
  const { error: convUpdateErr } = await supabase
    .from("messaging_conversations")
    .update({
      last_message_at: norm.timestamp.toISOString(),
      last_message_preview: previewFor(norm).slice(0, 100),
      last_message_direction: norm.direction,
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
}

async function handleConversationStarted(
  supabase: ReturnType<typeof createClient>,
  channel: ChannelRow,
  payload: Obj
) {
  const conversation = asObj(payload["conversation"]);
  if (!conversation) return;

  const platform = (readText(conversation, ["platform"]) ?? "instagram").toLowerCase();
  if (platform !== "instagram") return;

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
