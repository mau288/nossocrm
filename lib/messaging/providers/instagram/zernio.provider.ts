/**
 * @fileoverview Zernio Instagram Messaging Provider
 *
 * Instagram DM provider using the Zernio API (https://zernio.com/api/v1).
 * Zernio is a social-inbox aggregator: the Instagram account is connected on
 * Zernio's side (OAuth with Meta) and this provider talks only to Zernio.
 *
 * Key differences from the Meta provider:
 * - Auth: single Bearer API key (no Meta app/page tokens)
 * - Recipient addressing: messages are sent to a Zernio *conversation id*,
 *   not to a user id. For zernio channels the conversation's
 *   `external_contact_id` IS the Zernio conversation id (a DM thread is 1:1
 *   with a participant, so uniqueness per contact still holds).
 * - Media: v1 supports text only (Zernio send endpoint is text + url buttons).
 * - 24h window: outside the window Meta only accepts HUMAN_AGENT-tagged
 *   messages; on a window rejection we retry once with that tag (messages
 *   sent from the CRM are typed by humans or supervised AI).
 *
 * @module lib/messaging/providers/instagram/zernio
 */

import { BaseChannelProvider } from '../base.provider';
import type {
  ChannelType,
  ProviderConfig,
  ValidationResult,
  ValidationError,
  ConnectionStatusResult,
  SendMessageParams,
  SendMessageResult,
  WebhookHandlerResult,
  MessageReceivedEvent,
  ErrorEvent,
  MessageContent,
  TextContent,
} from '../../types';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Zernio credentials configuration.
 */
export interface ZernioCredentials {
  /** Zernio API key (Bearer) */
  apiKey: string;
  /** Zernio account id of the connected Instagram profile */
  accountId: string;
  /** Instagram @username (informational) */
  username?: string;
  /** HMAC secret returned by Zernio when the webhook was registered */
  webhookSecret?: string;
}

type Obj = Record<string, unknown>;

// =============================================================================
// CONSTANTS
// =============================================================================

const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

// =============================================================================
// PROVIDER IMPLEMENTATION
// =============================================================================

/**
 * Zernio Instagram messaging provider implementation.
 *
 * Features:
 * - Text DMs into existing conversations
 * - Automatic HUMAN_AGENT retry when the 24h window is closed
 * - Rate-limit aware (Zernio 429 + Retry-After -> retryable error)
 *
 * Limitations (v1):
 * - Text only (media arrives inbound as attachment URLs, but outbound
 *   messages are text)
 * - Requires the Instagram account to be connected on Zernio first
 */
export class ZernioInstagramProvider extends BaseChannelProvider {
  readonly channelType: ChannelType = 'instagram';
  readonly providerName = 'zernio';

  private apiKey: string = '';
  private accountId: string = '';

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async initialize(config: ProviderConfig): Promise<void> {
    await super.initialize(config);

    const credentials = config.credentials as unknown as ZernioCredentials;
    this.apiKey = credentials.apiKey;
    this.accountId = credentials.accountId;

    this.log('info', 'Zernio Instagram provider initialized', {
      accountId: this.accountId,
    });
  }

  async disconnect(): Promise<void> {
    this.log('info', 'Zernio Instagram provider disconnected');
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<ConnectionStatusResult> {
    try {
      const raw = await this.request<unknown>('GET', '/accounts');
      const accounts = extractList(raw);
      const mine = accounts.find((a) => readText(a, ['id', '_id', 'accountId', 'account_id']) === this.accountId);

      if (!mine) {
        return {
          status: 'disconnected',
          message: 'Conta não encontrada na Zernio. Reconecte o perfil do Instagram.',
        };
      }

      return {
        status: 'connected',
        message: 'Connected to Instagram via Zernio',
        details: {
          accountId: this.accountId,
          username: readText(mine, ['username', 'handle', 'name']) ?? undefined,
        },
      };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  async sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
    const { to, content } = params;

    const text = this.contentToText(content);
    if (text === null) {
      return this.errorResult(
        'UNSUPPORTED_CONTENT',
        `Zernio não suporta envio de ${content.type} — envie texto.`,
        false
      );
    }

    const path = `/inbox/conversations/${encodeURIComponent(to)}/messages`;

    // First attempt: plain message (inside the 24h window).
    const first = await this.trySend(path, { accountId: this.accountId, message: text });
    if (first.ok) return this.successResult(first.externalId ?? `zernio-${Date.now()}`);

    // Window closed (Meta policy error surfaces as 4xx): retry once tagged as
    // HUMAN_AGENT — allowed up to 7 days for human responses.
    if (first.status !== null && first.status >= 400 && first.status < 500 && first.status !== 429) {
      this.log('warn', 'Zernio send rejected; retrying with HUMAN_AGENT tag', {
        status: first.status,
      });
      const second = await this.trySend(path, {
        accountId: this.accountId,
        message: text,
        tag: 'HUMAN_AGENT',
        messagingType: 'MESSAGE_TAG',
      });
      if (second.ok) return this.successResult(second.externalId ?? `zernio-${Date.now()}`);
      return this.zernioError(second.status, second.retryAfterMs);
    }

    return this.zernioError(first.status, first.retryAfterMs);
  }

  /** Flatten CRM message content into the text Zernio accepts. */
  private contentToText(content: MessageContent): string | null {
    if (content.type === 'text') {
      return (content as TextContent).text;
    }
    // Media with caption: deliver the caption rather than failing silently.
    const withCaption = content as { caption?: string };
    if (typeof withCaption.caption === 'string' && withCaption.caption.trim()) {
      return withCaption.caption;
    }
    return null;
  }

  private async trySend(
    path: string,
    body: Obj
  ): Promise<{ ok: boolean; status: number | null; externalId?: string; retryAfterMs?: number }> {
    let response: Response;
    try {
      response = await fetch(`${ZERNIO_BASE_URL}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, status: null };
    }

    if (!response.ok) {
      // Never log the body: it may echo tokens back.
      this.log('error', `Zernio send failed with status ${response.status}`);
      let retryAfterMs: number | undefined;
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header ? Number(header) : NaN;
        retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;
      }
      return { ok: false, status: response.status, retryAfterMs };
    }

    let parsed: unknown = {};
    try {
      const textBody = await response.text();
      parsed = textBody ? JSON.parse(textBody) : {};
    } catch {
      parsed = {};
    }

    const externalId =
      readText(asObj(parsed), ['id', 'messageId', 'message_id', 'platformMessageId']) ??
      readText(asObj(asObj(parsed)?.['data']), ['id', 'messageId', 'platformMessageId']) ??
      undefined;

    return { ok: true, status: response.status, externalId };
  }

  private zernioError(status: number | null, retryAfterMs?: number): SendMessageResult {
    if (status === null) {
      return this.errorResult('NETWORK_ERROR', 'Não foi possível falar com a Zernio.', true);
    }
    if (status === 401 || status === 403) {
      return this.errorResult('AUTH_FAILED', 'A Zernio recusou a chave da API. Confira em Configurações.', false);
    }
    if (status === 429) {
      return {
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'A Zernio pediu para esperar antes de enviar de novo.',
          retryable: true,
          details: { retryAfterMs: retryAfterMs ?? 5000 },
        },
      };
    }
    if (status >= 500) {
      return this.errorResult('PROVIDER_ERROR', `Erro no servidor da Zernio (${status}).`, true);
    }
    return this.errorResult('SEND_REJECTED', `A Zernio recusou o envio (código ${status}).`, false);
  }

  // ---------------------------------------------------------------------------
  // Webhook Handler
  // ---------------------------------------------------------------------------

  /**
   * Normalizes a Zernio webhook payload. The production path runs inside the
   * `messaging-webhook-zernio` edge function (which persists directly), but the
   * same shapes are handled here for parity/tests.
   *
   * Events: `message.received` / `message.sent` (direction incoming|outgoing),
   * `conversation.started`, `comment.received` (ignored in v1).
   */
  async handleWebhook(payload: unknown): Promise<WebhookHandlerResult> {
    const root = asObj(payload);
    const event = root ? readText(root, ['event']) ?? '' : '';

    if (!root || (event !== 'message.received' && event !== 'message.sent')) {
      return this.webhookError('UNSUPPORTED_EVENT', `Evento não tratado: ${event || 'desconhecido'}`);
    }

    const message = asObj(root['message']);
    if (!message) {
      return this.webhookError('INVALID_PAYLOAD', 'Payload da Zernio sem message.');
    }

    const conversation = asObj(root['conversation']);
    const sender = asObj(message['sender']);
    const conversationId =
      readText(message, ['conversationId']) ?? (conversation ? readText(conversation, ['id']) : null);
    const externalMessageId = readText(message, ['id', 'platformMessageId']);
    const text = readText(message, ['text']);

    if (!conversationId) {
      return this.webhookError('INVALID_PAYLOAD', 'Payload da Zernio sem conversationId.');
    }

    const sentAtRaw = readText(message, ['sentAt']) ?? readText(root, ['timestamp']);
    const sentAt = sentAtRaw ? new Date(sentAtRaw) : new Date();

    const eventData: MessageReceivedEvent = {
      type: 'message_received',
      from: conversationId,
      content: { type: 'text', text: text ?? '' },
      externalMessageId: externalMessageId ?? '',
      timestamp: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
      fromName: sender ? readText(sender, ['name', 'username']) ?? undefined : undefined,
    };

    return {
      type: 'message_received',
      externalId: externalMessageId ?? undefined,
      data: eventData,
      raw: payload,
    };
  }

  private webhookError(code: string, message: string): WebhookHandlerResult {
    const eventData: ErrorEvent = {
      type: 'error',
      code,
      message,
      timestamp: new Date(),
    };
    return { type: 'error', data: eventData, raw: null };
  }

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------

  validateConfig(config: ProviderConfig): ValidationResult {
    const baseResult = super.validateConfig(config);
    if (!baseResult.valid) {
      return baseResult;
    }

    const errors: ValidationError[] = [];
    const credentials = config.credentials as unknown as ZernioCredentials;

    if (!credentials.apiKey) {
      errors.push({
        field: 'credentials.apiKey',
        message: 'Zernio API Key is required',
        code: 'REQUIRED',
      });
    }

    if (!credentials.accountId) {
      errors.push({
        field: 'credentials.accountId',
        message: 'Zernio Account ID is required',
        code: 'REQUIRED',
      });
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // HTTP Client
  // ---------------------------------------------------------------------------

  private async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: Obj): Promise<T> {
    const response = await fetch(`${ZERNIO_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) {
      // Never log the body: it may carry connection tokens.
      throw new Error(`Zernio ${path} failed with status ${response.status}`);
    }

    const textBody = await response.text();
    if (!textBody) return {} as T;
    try {
      return JSON.parse(textBody) as T;
    } catch {
      return {} as T;
    }
  }
}

// =============================================================================
// DEFENSIVE PARSING HELPERS
// =============================================================================
// Zernio responses vary between environments: lists may come at the root, in
// `data`, in `accounts`, or nested. Same approach as the reference client.

function asObj(value: unknown): Obj | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null;
}

function readText(obj: Obj | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function extractList(value: unknown): Obj[] {
  if (Array.isArray(value)) return value.filter((v): v is Obj => !!asObj(v));
  const root = asObj(value);
  if (!root) return [];
  for (const key of ['data', 'accounts', 'results']) {
    const inner = root[key];
    if (Array.isArray(inner)) return inner.filter((v): v is Obj => !!asObj(v));
    const innerObj = asObj(inner);
    if (innerObj && Array.isArray(innerObj['accounts'])) {
      return (innerObj['accounts'] as unknown[]).filter((v): v is Obj => !!asObj(v));
    }
  }
  return [];
}

export default ZernioInstagramProvider;
