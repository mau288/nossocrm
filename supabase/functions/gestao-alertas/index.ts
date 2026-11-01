// =============================================================================
// Gestao — Alertas do gestor no WhatsApp — Edge Function (ARK Onda 3 / 3.4)
// =============================================================================
// Chamada a cada 10 min pelo pg_cron (via pg_net), com o header x-dispatch-secret
// (mesmo segredo do scheduled-messages-dispatch). Para cada organizacao com
// gestao_alert_settings.enabled:
//   1. waiting  — conversas abertas cuja ultima mensagem e do lead ha mais de
//                 sla_minutes (e menos de max_hours). Dois modos:
//                   waiting_hours preenchido -> 1 resumo por hora listada (BRT), por dia
//                     (ex.: {9,20}; pedido de 01/11/2026), so dias uteis se marcado;
//                   waiting_hours vazio      -> em horario comercial, 1 por cooldown_minutes.
//                 A mensagem lista as pendentes com nome/telefone (mais antigas primeiro).
//   2. webhook  — >= webhook_error_threshold erros em messaging_webhook_events nos
//                 ultimos 10 min (qualquer hora), 1 por cooldown.
//   3. goals    — metas de funil (boards.goal_*) e de vendedor (seller_goals) abaixo
//                 de 80% do ritmo esperado, 1 vez por dia na hora goals_hour.
// Envio: Evolution (chip escolhido em channel_id), 1 mensagem por destinatario.
// Tudo que sai (ou falha) vai para gestao_alert_log — e o cooldown le dali.
// Body opcional: { "test": true, "organization_id": "<uuid>" } manda uma mensagem de
// teste para os destinatarios daquela org, ignorando horario e cooldown.
// =============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

type Supa = ReturnType<typeof createClient>;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Recipient = { name?: string; phone: string };

type Settings = {
  organization_id: string;
  enabled: boolean;
  channel_id: string | null;
  recipients: Recipient[] | null;
  alert_waiting: boolean;
  alert_webhook: boolean;
  alert_goals: boolean;
  sla_minutes: number;
  max_hours: number;
  hours_start: number;
  hours_end: number;
  weekdays_only: boolean;
  webhook_error_threshold: number;
  cooldown_minutes: number;
  goals_hour: number;
  waiting_hours: number[] | null;
};

/** Quantas conversas pendentes aparecem nominalmente na mensagem. */
const MAX_LISTA = 15;

const PAINEL_URL = "https://crm.arkacademy.com.br/reports?view=gestao";

// -----------------------------------------------------------------------------
// Tempo em Sao Paulo
// -----------------------------------------------------------------------------
function brtNow(): { hour: number; weekday: string; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour: "numeric",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(get("hour")) % 24, weekday: get("weekday"), date: `${get("year")}-${get("month")}-${get("day")}` };
}

function fmtMin(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) {
    const m = min % 60;
    return m > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
  }
  return `${Math.floor(h / 24)} dias`;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

// -----------------------------------------------------------------------------
// Envio pela Evolution
// -----------------------------------------------------------------------------
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
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `Evolution respondeu ${resp.status} ${t.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Falha de rede na Evolution" };
  }
}

async function sendToAll(
  supabase: Supa,
  orgId: string,
  type: string,
  fingerprint: string | null,
  credentials: Record<string, string>,
  recipients: Recipient[],
  text: string
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  const erros: string[] = [];
  for (const r of recipients) {
    const res = await sendViaEvolution(credentials, r.phone, text);
    if (res.ok) ok++;
    else {
      failed++;
      erros.push(`${r.phone}: ${res.error}`);
    }
  }
  await supabase.from("gestao_alert_log").insert({
    organization_id: orgId,
    alert_type: type,
    fingerprint,
    message: text,
    recipients,
    sent_ok: ok > 0,
    error: erros.length ? erros.join(" | ").slice(0, 1000) : null,
  });
  return { ok, failed };
}

async function lastLog(supabase: Supa, orgId: string, type: string): Promise<{ created_at: string; fingerprint: string | null } | null> {
  const { data } = await supabase
    .from("gestao_alert_log")
    .select("created_at, fingerprint")
    .eq("organization_id", orgId)
    .eq("alert_type", type)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { created_at: string; fingerprint: string | null } | null) ?? null;
}

function cooldownPassed(last: { created_at: string } | null, minutes: number): boolean {
  if (!last) return true;
  return Date.now() - new Date(last.created_at).getTime() >= minutes * 60_000;
}

// -----------------------------------------------------------------------------
// 1. Conversas aguardando resposta
// -----------------------------------------------------------------------------
type ConvRow = {
  id: string;
  last_message_at: string;
  external_contact_id: string | null;
  external_contact_name: string | null;
  contact: { name: string | null; phone: string | null } | { name: string | null; phone: string | null }[] | null;
  channel: { name: string; channel_type: string } | { name: string; channel_type: string }[] | null;
};

const soNumero = (s: string) => /^[+\d\s()-]{6,}$/.test(s.trim());

/** "Nome (+5511...)" — nome real do contato ou do WhatsApp; telefone quando houver. */
function quemE(r: ConvRow): string {
  const c = Array.isArray(r.contact) ? r.contact[0] : r.contact;
  const nome = [c?.name, r.external_contact_name].find((n) => n && n.trim() && !soNumero(n)) ?? null;
  const fone = c?.phone || (r.external_contact_id?.startsWith("+") ? r.external_contact_id : null);
  if (nome && fone) return `${nome} (${fone})`;
  return nome ?? fone ?? r.external_contact_name ?? "sem nome";
}

async function alertWaiting(supabase: Supa, s: Settings): Promise<string | null> {
  const now = Date.now();
  const maxAt = new Date(now - s.sla_minutes * 60_000).toISOString();
  const minAt = new Date(now - s.max_hours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("messaging_conversations")
    .select("id, last_message_at, external_contact_id, external_contact_name, contact:contacts!contact_id(name, phone), channel:messaging_channels!channel_id(name, channel_type)")
    .eq("organization_id", s.organization_id)
    .eq("status", "open")
    .eq("last_message_direction", "inbound")
    .lt("last_message_at", maxAt)
    .gt("last_message_at", minAt)
    .order("last_message_at", { ascending: true })
    .limit(500);
  if (error) {
    console.error("[gestao-alertas] waiting:", error);
    return null;
  }
  const rows = (data ?? []) as unknown as ConvRow[];
  if (rows.length === 0) return null;

  const porCanal = new Map<string, { count: number; oldest: number }>();
  for (const r of rows) {
    const ch = Array.isArray(r.channel) ? r.channel[0] : r.channel;
    const nome = ch?.name ?? "Canal";
    const min = Math.round((now - new Date(r.last_message_at).getTime()) / 60_000);
    const cur = porCanal.get(nome) ?? { count: 0, oldest: 0 };
    cur.count++;
    cur.oldest = Math.max(cur.oldest, min);
    porCanal.set(nome, cur);
  }
  const linhas = [...porCanal.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([nome, v]) => `• ${nome}: ${v.count} (mais antiga ${fmtMin(v.oldest)})`);

  // Quem esta pendente (mais antigas primeiro), com nome/telefone para achar no CRM.
  const pendentes = rows.slice(0, MAX_LISTA).map((r, i) => {
    const ch = Array.isArray(r.channel) ? r.channel[0] : r.channel;
    const min = Math.round((now - new Date(r.last_message_at).getTime()) / 60_000);
    return `${i + 1}. ${quemE(r)} · ${ch?.name ?? "canal"} · ${fmtMin(min)}`;
  });
  const resto = rows.length - pendentes.length;

  return [
    `⏳ *CRM — aguardando resposta* (há mais de ${s.sla_minutes} min)`,
    `Total: ${rows.length} conversa${rows.length === 1 ? "" : "s"}`,
    ...linhas,
    "",
    `*Pendentes (mais antigas primeiro):*`,
    ...pendentes,
    ...(resto > 0 ? [`… e mais ${resto}`] : []),
    PAINEL_URL,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// 2. Erros de webhook
// -----------------------------------------------------------------------------
async function alertWebhook(supabase: Supa, s: Settings): Promise<string | null> {
  const { data: channels } = await supabase
    .from("messaging_channels")
    .select("id, name")
    .eq("organization_id", s.organization_id)
    .is("deleted_at", null);
  const nameById = new Map<string, string>((channels ?? []).map((c) => [c.id as string, c.name as string]));
  const ids = [...nameById.keys()];
  if (ids.length === 0) return null;

  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("messaging_webhook_events")
    .select("channel_id, event_type, error, created_at")
    .in("channel_id", ids)
    .not("error", "is", null)
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("[gestao-alertas] webhook:", error);
    return null;
  }
  const rows = (data ?? []) as Array<{ channel_id: string; event_type: string; error: string; created_at: string }>;
  if (rows.length < s.webhook_error_threshold) return null;

  const porCanal = new Map<string, number>();
  for (const r of rows) porCanal.set(nameById.get(r.channel_id) ?? "canal", (porCanal.get(nameById.get(r.channel_id) ?? "canal") ?? 0) + 1);
  const linhas = [...porCanal.entries()].map(([n, c]) => `• ${n}: ${c}`);
  return [
    `🚨 *CRM — erro de webhook*`,
    `${rows.length} erro${rows.length === 1 ? "" : "s"} nos últimos 10 min`,
    ...linhas,
    `Último (${rows[0].event_type}): ${String(rows[0].error).slice(0, 160)}`,
  ].join("\n");
}

// -----------------------------------------------------------------------------
// 3. Metas em risco (funil + vendedor)
// -----------------------------------------------------------------------------
type SellerGoalRow = {
  userName: string;
  boardName: string | null;
  kpi: string;
  goalType: "currency" | "number";
  targetValue: number;
  value: number;
  pct: number;
  expectedPct: number;
  status: string;
};

type BoardRow = {
  id: string;
  name: string;
  goal_kpi: string | null;
  goal_type: string | null;
  goal_target_value: string | null;
  goal_start_date: string | null;
  goal_end_date: string | null;
};

function fmtMeta(goalType: string, v: number): string {
  if (goalType === "currency") return BRL.format(v);
  if (goalType === "percentage") return `${v.toFixed(0)}%`;
  return `${Math.round(v)}`;
}

async function alertGoals(supabase: Supa, s: Settings, today: string): Promise<string | null> {
  const linhas: string[] = [];

  // Vendedores (RPC ja devolve status)
  const { data: sellerGoals, error: sgErr } = await supabase.rpc("get_seller_goals_progress", {
    p_org_id: s.organization_id,
    p_include_archived: false,
  });
  if (sgErr) console.error("[gestao-alertas] seller goals:", sgErr);
  for (const g of ((sellerGoals ?? []) as SellerGoalRow[])) {
    if (g.status !== "risco") continue;
    linhas.push(
      `• ${g.userName}${g.boardName ? ` · ${g.boardName}` : ""}: ${fmtMeta(g.goalType, Number(g.value))} de ${fmtMeta(g.goalType, Number(g.targetValue))} (${Number(g.pct).toFixed(0)}%) com ${Number(g.expectedPct).toFixed(0)}% do período passado`
    );
  }

  // Funis (boards.goal_*), so os com periodo e alvo
  const { data: boards } = await supabase
    .from("boards")
    .select("id, name, goal_kpi, goal_type, goal_target_value, goal_start_date, goal_end_date")
    .eq("organization_id", s.organization_id)
    .is("deleted_at", null)
    .not("goal_target_value", "is", null)
    .not("goal_start_date", "is", null)
    .not("goal_end_date", "is", null)
    .lte("goal_start_date", today)
    .gte("goal_end_date", today);

  for (const b of ((boards ?? []) as BoardRow[])) {
    const alvo = parseFloat(String(b.goal_target_value ?? "").replace(/[^0-9.]/g, ""));
    if (!alvo || !b.goal_start_date || !b.goal_end_date) continue;
    const { data: deals } = await supabase
      .from("deals")
      .select("value, is_won, is_lost, closed_at")
      .eq("board_id", b.id)
      .is("deleted_at", null)
      .or("is_won.eq.true,is_lost.eq.true")
      .gte("closed_at", `${b.goal_start_date}T00:00:00-03:00`)
      .lte("closed_at", `${b.goal_end_date}T23:59:59-03:00`);
    let won = 0;
    let lost = 0;
    let wonValue = 0;
    for (const d of (deals ?? []) as Array<{ value: number | string | null; is_won: boolean; is_lost: boolean }>) {
      if (d.is_won) {
        won++;
        wonValue += Number(d.value ?? 0);
      } else if (d.is_lost) lost++;
    }
    const type = b.goal_type || "currency";
    const valor = type === "currency" ? wonValue : type === "percentage" ? (won + lost > 0 ? (won / (won + lost)) * 100 : 0) : won;
    const pct = (valor / alvo) * 100;
    const ini = new Date(`${b.goal_start_date}T00:00:00-03:00`).getTime();
    const fim = new Date(`${b.goal_end_date}T23:59:59-03:00`).getTime();
    const elapsed = Math.max(0, Math.min(1, (Date.now() - ini) / (fim - ini)));
    const expectedPct = elapsed * 100;
    if (pct >= 100) continue;
    if (elapsed >= 0.25 && pct < 0.8 * expectedPct) {
      linhas.push(`• Funil ${b.name} (${b.goal_kpi ?? "meta"}): ${fmtMeta(type, valor)} de ${fmtMeta(type, alvo)} (${pct.toFixed(0)}%) com ${expectedPct.toFixed(0)}% do período passado`);
    }
  }

  if (linhas.length === 0) return null;
  return [`🎯 *CRM — meta em risco* (abaixo de 80% do ritmo esperado)`, ...linhas, PAINEL_URL].join("\n");
}

// -----------------------------------------------------------------------------
// Por organizacao
// -----------------------------------------------------------------------------
async function processOrg(supabase: Supa, s: Settings, test: boolean): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { organization_id: s.organization_id };
  const recipients = (Array.isArray(s.recipients) ? s.recipients : []).filter(
    (r) => r && typeof r.phone === "string" && r.phone.replace(/\D/g, "").length >= 10
  );
  if (recipients.length === 0) return { ...out, skipped: "sem destinatarios" };
  if (!s.channel_id) return { ...out, skipped: "sem chip de envio" };

  const { data: channel } = await supabase
    .from("messaging_channels")
    .select("id, name, provider, credentials")
    .eq("id", s.channel_id)
    .maybeSingle();
  if (!channel || channel.provider !== "evolution") return { ...out, skipped: "chip nao e Evolution" };
  const credentials = (channel.credentials ?? {}) as Record<string, string>;

  if (test) {
    const text = `✅ *Teste de alerta do CRM*\nOs alertas de gestão vão chegar por este número (chip ${channel.name}).\n${PAINEL_URL}`;
    out.test = await sendToAll(supabase, s.organization_id, "test", null, credentials, recipients, text);
    return out;
  }

  const brt = brtNow();
  const isWeekend = brt.weekday === "Sat" || brt.weekday === "Sun";
  const inHours = brt.hour >= s.hours_start && brt.hour < s.hours_end && !(s.weekdays_only && isWeekend);

  // 1. aguardando resposta
  const horasFixas = (Array.isArray(s.waiting_hours) ? s.waiting_hours : []).filter((h) => Number.isInteger(h) && h >= 0 && h < 24);
  if (!s.alert_waiting) out.waiting = "desligado";
  else if (horasFixas.length > 0) {
    // Modo horarios fixos: 1 envio por hora listada, por dia (fingerprint data:hora).
    if (s.weekdays_only && isWeekend) out.waiting = "fim de semana";
    else if (!horasFixas.includes(brt.hour)) out.waiting = "fora da hora";
    else {
      const fp = `${brt.date}:${String(brt.hour).padStart(2, "0")}`;
      const last = await lastLog(supabase, s.organization_id, "waiting");
      if (last?.fingerprint === fp) out.waiting = "ja enviado nesta hora";
      else {
        const text = await alertWaiting(supabase, s);
        if (text) out.waiting = await sendToAll(supabase, s.organization_id, "waiting", fp, credentials, recipients, text);
        else {
          await supabase.from("gestao_alert_log").insert({
            organization_id: s.organization_id,
            alert_type: "waiting",
            fingerprint: fp,
            message: `Verificação das ${brt.hour}h: nenhuma conversa aguardando resposta.`,
            recipients: [],
            sent_ok: true,
          });
          out.waiting = "fila limpa";
        }
      }
    }
  } else if (inHours) {
    // Modo cooldown (antigo): em horario comercial, 1 por cooldown_minutes.
    const last = await lastLog(supabase, s.organization_id, "waiting");
    if (cooldownPassed(last, s.cooldown_minutes)) {
      const text = await alertWaiting(supabase, s);
      out.waiting = text ? await sendToAll(supabase, s.organization_id, "waiting", brt.date, credentials, recipients, text) : "fila limpa";
    } else out.waiting = "cooldown";
  } else out.waiting = "fora do horario";

  // 2. erro de webhook
  if (s.alert_webhook) {
    const last = await lastLog(supabase, s.organization_id, "webhook");
    if (cooldownPassed(last, s.cooldown_minutes)) {
      const text = await alertWebhook(supabase, s);
      out.webhook = text ? await sendToAll(supabase, s.organization_id, "webhook", brt.date, credentials, recipients, text) : "sem erros";
    } else out.webhook = "cooldown";
  } else out.webhook = "desligado";

  // 3. metas em risco — 1 vez por dia, na hora combinada
  if (s.alert_goals && brt.hour === s.goals_hour) {
    const last = await lastLog(supabase, s.organization_id, "goals");
    if (last?.fingerprint === brt.date) out.goals = "ja verificado hoje";
    else {
      const text = await alertGoals(supabase, s, brt.date);
      if (text) out.goals = await sendToAll(supabase, s.organization_id, "goals", brt.date, credentials, recipients, text);
      else {
        await supabase.from("gestao_alert_log").insert({
          organization_id: s.organization_id,
          alert_type: "goals",
          fingerprint: brt.date,
          message: "Verificação diária: nenhuma meta em risco.",
          recipients: [],
          sent_ok: true,
        });
        out.goals = "sem metas em risco";
      }
    }
  } else out.goals = s.alert_goals ? "fora da hora" : "desligado";

  return out;
}

// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json(405, { error: "Método não permitido" });
  }
  const secret = Deno.env.get("SCHEDULED_DISPATCH_SECRET");
  if (!secret || req.headers.get("x-dispatch-secret") !== secret) {
    return json(401, { error: "Não autorizado" });
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const body = (await req.json().catch(() => ({}))) as { test?: boolean; organization_id?: string };

  let q = supabase.from("gestao_alert_settings").select("*");
  if (body.test && body.organization_id) q = q.eq("organization_id", body.organization_id);
  else q = q.eq("enabled", true);
  const { data: rows, error } = await q;
  if (error) return json(500, { error: error.message });

  const results: Record<string, unknown>[] = [];
  for (const s of (rows ?? []) as Settings[]) {
    try {
      results.push(await processOrg(supabase, s, !!body.test));
    } catch (e) {
      results.push({ organization_id: s.organization_id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return json(200, { ok: true, at: new Date().toISOString(), results });
});
