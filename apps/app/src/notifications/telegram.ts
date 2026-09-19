/**
 * The owner's Telegram channel.
 *
 * This is a **private 1:1 chat with one person**, reached through the founder's existing
 * "Aravind Official Automation" bot. Three facts about that bot shape everything here,
 * and all three were verified by the lead rather than assumed:
 *
 *  1. **The bot is long-polling, with no webhook.** It is already running, serving the
 *     founder's own automation. Calling `getUpdates` from here would consume updates that
 *     poller is waiting for and break it. **`sendMessage` is the only method this module
 *     may ever call** — never `getUpdates`, never `setWebhook`, never `deleteWebhook`.
 *     `TELEGRAM_METHOD_ALLOWLIST` states that as data, and `assertMethodPermitted`
 *     enforces it, so a future edit that adds a second call fails a test instead of
 *     silently breaking somebody else's system.
 *
 *  2. **It is a shared bot.** The founder's own automation posts there too, so every
 *     message we send is prefixed `ITISYOU Verify` — at a glance, whose message this is.
 *
 *  3. **It is a person's phone, not a log sink.** So the routing is deliberately narrow:
 *     owner actions and concise milestones only. None of the twelve customer templates
 *     goes here. `OWNER_ALERT_ROUTING` is the whole policy, in one typed table.
 *
 * ## The content guard is structural, not a convention
 *
 * A private chat on a phone is the worst possible place for a credential or a customer
 * record to land: it is backed up to a cloud account we do not control, it is searchable
 * forever, and it cannot be recalled. So this channel is built to be *incapable* of
 * carrying one rather than careful about it:
 *
 *  - a **kind allowlist**, default-deny: a message with no kind, or a kind outside
 *    `TELEGRAM_PERMITTED_KINDS`, is refused;
 *  - a **shape guard** over the fully assembled text: an email address, a token shape, a
 *    card-like number, a JWT or a JSON blob causes a **refusal**, not a redaction.
 *
 * Refusing rather than masking is the deliberate choice. A redactor that runs on every
 * message is a redactor whose failures are invisible — it quietly ships whatever shape it
 * did not recognise. A refusal is loud, is recorded against the notification key, and
 * sends the owner to the dashboard, where the data belongs anyway. The refusal reason
 * names the *rule*, never the offending value, so the guard cannot become the leak.
 *
 * ## The token
 *
 * Read from Worker secrets, held in memory, and placed in a request path because the
 * Telegram API requires it there. It is never stored, never returned and never put in an
 * error: `redactTelegramToken` is applied to everything this module produces and to
 * everything it catches. That last part is the one that matters — an HTTP client which
 * includes the request URL in a failure message will otherwise hand the token to the
 * first log line written after the network drops. This follows the approach in the
 * founder's own `packages/telegram/src/config.ts`, for the same reason.
 */
import type {
  NotificationTransport,
  OutboundMessage,
  SupportDataPort,
  TransportResult,
} from '../support/port';
import { dispatchNotification, type SendDependencies, type SendResult } from './send';

/* -------------------------------------------------------------------------- */
/* what may be said, and where                                                */
/* -------------------------------------------------------------------------- */

/**
 * The only things this product ever tells the owner directly.
 *
 * Deliberately six. A seventh should have to argue for itself: every addition makes the
 * previous six less likely to be read.
 */
export const OWNER_ALERT_KIND = [
  /** Something is waiting on the owner's approval and will not proceed without it. */
  'approval_needed',
  /** A sign-in, an MFA prompt or a card entry that only a person can complete. */
  'authentication_required',
  /** Money is about to be spent, or a spending limit has been reached. */
  'spending_decision',
  /** The service is failing in a way customers can see. */
  'critical_incident',
  /** HubSpot or Resend is unreachable, so verification is degraded. */
  'provider_outage',
  /** A milestone worth knowing about. Concise, and never more than one line of numbers. */
  'milestone_reached',
] as const;
export type OwnerAlertKind = (typeof OWNER_ALERT_KIND)[number];

export type AlertChannel = 'telegram' | 'email' | 'dashboard';

export interface AlertRoute {
  readonly kind: OwnerAlertKind;
  readonly channels: readonly AlertChannel[];
  /** Why this kind earns a phone notification, or why it does not. Argue with this. */
  readonly why: string;
}

/**
 * The routing policy, as a table so it can be disagreed with in one place.
 *
 * The founder's instruction was "essential owner-action notifications and concise
 * milestones only". Every row either needs the owner to *do* something, or is a single
 * fact worth a glance. Nothing here is informational-but-optional; that is what the
 * dashboard is for.
 */
export const OWNER_ALERT_ROUTING: readonly AlertRoute[] = [
  {
    kind: 'approval_needed',
    channels: ['telegram', 'dashboard'],
    why: 'Something is blocked until the owner answers. A blocked queue nobody knows about is the failure this exists to prevent.',
  },
  {
    kind: 'authentication_required',
    channels: ['telegram', 'dashboard'],
    why: 'Only a person can complete a sign-in, an MFA prompt or a card entry, and they have to be at their phone to do it. This is the case the channel is for.',
  },
  {
    kind: 'spending_decision',
    channels: ['telegram', 'email', 'dashboard'],
    why: 'Money about to leave the account. Also emailed, because a spending decision should leave a written trail that is not a chat message.',
  },
  {
    kind: 'critical_incident',
    channels: ['telegram', 'dashboard'],
    why: 'Customers can see it. The owner should not learn about it from a customer.',
  },
  {
    kind: 'provider_outage',
    channels: ['telegram', 'dashboard'],
    why: 'Verification is degraded and runs are going unverified. Grouped by `grouping.ts`, so an outage is one message rather than forty.',
  },
  {
    kind: 'milestone_reached',
    channels: ['telegram', 'dashboard'],
    why: 'One line, worth a glance, never actionable. The founder asked for concise milestones; anything longer belongs on the dashboard.',
  },
];

/** Kinds permitted on Telegram. Everything absent from this set is refused. */
export const TELEGRAM_PERMITTED_KINDS: ReadonlySet<string> = new Set(
  OWNER_ALERT_ROUTING.filter((r) => r.channels.includes('telegram')).map((r) => r.kind),
);

export function channelsFor(kind: OwnerAlertKind): readonly AlertChannel[] {
  return OWNER_ALERT_ROUTING.find((r) => r.kind === kind)?.channels ?? [];
}

/* -------------------------------------------------------------------------- */
/* the API surface we are permitted to touch                                  */
/* -------------------------------------------------------------------------- */

/**
 * The complete list of Telegram Bot API methods this module may call.
 *
 * One entry, and it must stay one entry. The bot is long-polling for somebody else's
 * system; `getUpdates` from here would steal their updates, and `setWebhook` or
 * `deleteWebhook` would stop their poller receiving anything at all. This is a constraint
 * about *another running system*, which is exactly the kind a code comment fails to
 * protect and a test does.
 */
export const TELEGRAM_METHOD_ALLOWLIST: readonly string[] = ['sendMessage'];

/** Methods that would break the founder's running poller. Named so a test can assert. */
export const TELEGRAM_FORBIDDEN_METHODS: readonly string[] = [
  'getUpdates',
  'setWebhook',
  'deleteWebhook',
];

export function assertMethodPermitted(method: string): void {
  if (!TELEGRAM_METHOD_ALLOWLIST.includes(method)) {
    throw new Error(
      `Telegram method "${method}" is not permitted from this application. The bot is long-polling for another system; only sendMessage may be called.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Worker secret names. These are bindings, not machine environment variables: Worker code
 * never reads the developer's shell.
 */
export const TELEGRAM_TOKEN_BINDING = 'TELEGRAM_BOT_TOKEN';
export const TELEGRAM_CHAT_BINDING = 'TELEGRAM_OWNER_CHAT_ID';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Telegram's own limit. Longer text is split at a line boundary, never truncated. */
export const MAX_MESSAGE_CHARACTERS = 4096;

/** Bounded, so one enormous alert cannot turn into a hundred buzzes. */
export const MAX_MESSAGES_PER_ALERT = 4;

/** The prefix that tells the founder whose message this is, at a glance. */
export const MESSAGE_PREFIX = 'ITISYOU Verify';

export interface TelegramConfig {
  /** In memory only. Never persisted, never logged, never in an error or a result. */
  readonly token: string;
  readonly ownerChatId: string;
  readonly apiBase: string;
}

/** What may safely be printed about a configuration. Deliberately carries no measurement. */
export interface SafeTelegramDescription {
  readonly apiBase: string;
  readonly tokenPresent: boolean;
  readonly ownerChatConfigured: boolean;
}

export type TelegramConfigProblem =
  'token_missing' | 'token_malformed' | 'owner_chat_missing' | 'owner_chat_malformed';

export type TelegramConfigResult =
  | { readonly ok: true; readonly config: TelegramConfig }
  | { readonly ok: false; readonly problem: TelegramConfigProblem };

// Telegram tokens are `<digits>:<base64-ish>`.
const TOKEN_SHAPE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const CHAT_ID_SHAPE = /^-?\d{1,20}$/;

/**
 * Read the configuration from named Worker bindings.
 *
 * Each binding is read by name; the environment is never enumerated, so a value nobody
 * asked for cannot end up somewhere it is logged. A malformed token fails here, by shape,
 * rather than as an opaque 404 from the API — and the value itself is never echoed.
 */
export function loadTelegramConfig(env: Readonly<Record<string, unknown>>): TelegramConfigResult {
  const rawToken = env[TELEGRAM_TOKEN_BINDING];
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (token.length === 0) return { ok: false, problem: 'token_missing' };
  if (!TOKEN_SHAPE.test(token)) return { ok: false, problem: 'token_malformed' };

  const rawChat = env[TELEGRAM_CHAT_BINDING];
  const ownerChatId = typeof rawChat === 'string' ? rawChat.trim() : '';
  if (ownerChatId.length === 0) return { ok: false, problem: 'owner_chat_missing' };
  if (!CHAT_ID_SHAPE.test(ownerChatId)) return { ok: false, problem: 'owner_chat_malformed' };

  return { ok: true, config: { token, ownerChatId, apiBase: TELEGRAM_API_BASE } };
}

export function describeTelegramConfig(config: TelegramConfig): SafeTelegramDescription {
  return {
    apiBase: config.apiBase,
    tokenPresent: config.token.length > 0,
    ownerChatConfigured: config.ownerChatId.length > 0,
  };
}

/**
 * Remove anything token-shaped from a string.
 *
 * Matches the *shape*, not a known value, so it also catches a token that arrived from
 * somewhere this code did not put it — which is the case worth defending against, because
 * the predictable one is easy.
 */
export function redactTelegramToken(text: string): string {
  return text.replace(/\d{5,}:[A-Za-z0-9_-]{30,}/g, '[REDACTED-TOKEN]');
}

/* -------------------------------------------------------------------------- */
/* the content guard                                                          */
/* -------------------------------------------------------------------------- */

export const GUARD_REASON = [
  'kind_missing',
  'kind_not_permitted',
  'empty_message',
  'contains_email_address',
  'contains_credential_shape',
  'contains_card_number',
  'contains_raw_payload',
  'too_many_messages',
] as const;
export type GuardReason = (typeof GUARD_REASON)[number];

export type GuardVerdict =
  | { readonly allowed: true; readonly messages: readonly string[] }
  | { readonly allowed: false; readonly reason: GuardReason; readonly explanation: string };

/**
 * Why a message was refused — naming the rule, never the value.
 *
 * If these strings quoted the offending text, the guard would become the leak it exists
 * to prevent: the refusal is recorded, and a recorded refusal containing the credential
 * is worse than having sent it once.
 */
export const GUARD_EXPLANATION: Readonly<Record<GuardReason, string>> = {
  kind_missing:
    'This message carried no alert kind. The owner channel is default-deny: it sends only the kinds on its allowlist, so an unlabelled message is refused rather than sent.',
  kind_not_permitted:
    'This kind of message is not one the owner channel carries. It belongs in email or on the dashboard.',
  empty_message: 'There was nothing to send.',
  contains_email_address:
    'The text contains something shaped like an email address. Customer contact details are not sent to this channel, so the message was refused rather than masked.',
  contains_credential_shape:
    'The text contains something shaped like a credential or an access token. This channel refuses such a message outright; it does not send a redacted version.',
  contains_card_number:
    'The text contains something shaped like a payment card number. We never hold one, so this is almost certainly a mistake — and it is refused either way.',
  contains_raw_payload:
    'The text looks like a raw provider payload or a structured record rather than a sentence. Records belong on the dashboard, behind a login.',
  too_many_messages:
    'This alert would have needed more messages than the channel allows. It was refused rather than sent in pieces; the full detail is on the dashboard.',
};

/**
 * Shapes that must never reach the owner's phone.
 *
 * A denylist over shapes *in addition to* the kind allowlist, not instead of it. The kind
 * allowlist is what makes the channel narrow; this is what catches a permitted kind whose
 * caller interpolated something it should not have.
 */
const FORBIDDEN_SHAPES: readonly { readonly reason: GuardReason; readonly re: RegExp }[] = [
  { reason: 'contains_email_address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  {
    reason: 'contains_credential_shape',
    // The tail allows `_` and `-` on purpose: `sk_live_abcdefghijklmnop` is a Stripe key
    // and an earlier `[A-Za-z0-9]{12,}` tail missed it, because the separator inside the
    // key ended the match after four characters. A prefix rule with a shape blind spot
    // is worse than no prefix rule, because it is trusted.
    re: /\b(?:sk|rk|pk|re|pat|ghp|gho|xoxb|xoxp)[_-][A-Za-z0-9_-]{12,}\b/i,
  },
  { reason: 'contains_credential_shape', re: /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { reason: 'contains_credential_shape', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  // A bot token, including our own. It must never be echoed into a message body.
  { reason: 'contains_credential_shape', re: /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/ },
  {
    reason: 'contains_credential_shape',
    re: /\b(?:api[_-]?key|apikey|secret|token|password|passwd|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*\S{6,}/i,
  },
  // Any unlabelled 24+ character mixed blob: a key, a hash, a session id.
  {
    reason: 'contains_credential_shape',
    re: /\b(?=[A-Za-z0-9+/_-]*[0-9])(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{24,}={0,2}\b/,
  },
  { reason: 'contains_card_number', re: /\b(?:\d[ -]?){13,19}\b/ },
  // A JSON object or array: a raw provider payload, or a serialised customer record.
  { reason: 'contains_raw_payload', re: /[{[]\s*"[^"]+"\s*:/ },
];

/**
 * Identifiers that are references rather than content, and so are allowed through.
 *
 * `ws_01J8…` is an opaque id that means nothing outside our own database. It is the whole
 * mechanism by which this channel says *which* workspace without saying anything *about*
 * it — the founder taps through to the dashboard, where access is checked. Without this
 * exemption the unlabelled-blob rule would refuse every alert that names anything.
 */
const REFERENCE_SHAPE = /\b(?:ws|run|wf|sup|ord|sub|cmp|apr|ntf|mjb)_[0-9A-Z]{26}\b/g;

function withoutReferences(text: string): string {
  return text.replace(REFERENCE_SHAPE, '<ref>');
}

/**
 * Decide whether this text may go to the owner's phone, and split it if so.
 *
 * Pure: no clock, no network, no port. Exported so the refusal paths can be tested
 * exhaustively without a transport anywhere near them.
 */
export function guardOwnerMessage(kind: string | undefined, text: string): GuardVerdict {
  if (kind === undefined || kind.trim().length === 0) {
    return refuse('kind_missing');
  }
  if (!TELEGRAM_PERMITTED_KINDS.has(kind)) {
    return refuse('kind_not_permitted');
  }

  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length === 0) return refuse('empty_message');

  // Opaque ids are references, not content, and are removed before the shape rules run.
  const inspected = withoutReferences(trimmed);
  for (const rule of FORBIDDEN_SHAPES) {
    if (rule.re.test(inspected)) return refuse(rule.reason);
  }

  const messages = splitMessage(trimmed, MAX_MESSAGE_CHARACTERS);
  if (messages.length > MAX_MESSAGES_PER_ALERT) return refuse('too_many_messages');

  return { allowed: true, messages };
}

function refuse(reason: GuardReason): GuardVerdict {
  return { allowed: false, reason, explanation: GUARD_EXPLANATION[reason] };
}

/* -------------------------------------------------------------------------- */
/* splitting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split text into messages within Telegram's limit, **never truncating**.
 *
 * Breaks on a line boundary where one exists, then on a word boundary inside an
 * over-long line, and only as a last resort mid-word — for a single unbroken run of
 * characters longer than the limit, there is nowhere else to break. Every character of
 * the input appears in the output: a silently cut message is worse than two messages,
 * because the reader cannot tell it happened.
 */
export function splitMessage(
  text: string,
  limit: number = MAX_MESSAGE_CHARACTERS,
): readonly string[] {
  if (limit < 1) throw new TypeError('splitMessage needs a positive limit');
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
  };

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      flush();
      for (const piece of splitLongLine(line, limit)) chunks.push(piece);
      continue;
    }
    if (current === '') current = line;
    else if (current.length + 1 + line.length <= limit) current = `${current}\n${line}`;
    else {
      flush();
      current = line;
    }
  }
  flush();
  return chunks;
}

/** Break one over-long line at a space where possible, mid-word only when there is none. */
function splitLongLine(line: string, limit: number): readonly string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breakAt = window.lastIndexOf(' ');
    // A space too close to the start would make a useless sliver; take the hard cut.
    const cut = breakAt > Math.floor(limit / 2) ? breakAt : limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(breakAt > Math.floor(limit / 2) ? cut + 1 : cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/* -------------------------------------------------------------------------- */
/* the transport                                                              */
/* -------------------------------------------------------------------------- */

/** The narrow slice of `fetch` this transport uses. Injected, so tests never reach out. */
export type TelegramFetch = (
  url: string,
  init: {
    readonly method: 'POST';
    readonly headers: Record<string, string>;
    readonly body: string;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

/**
 * A `NotificationTransport` that posts to one private Telegram chat.
 *
 * Satisfies the same interface as the email transport, so at-most-once on
 * `notification_key`, bounded retries, alert grouping and delivery recording all apply
 * unchanged — they are properties of sending, not properties of email.
 */
export class TelegramTransport implements NotificationTransport {
  constructor(
    private readonly config: TelegramConfig,
    private readonly fetchImpl: TelegramFetch,
  ) {}

  async send(message: OutboundMessage): Promise<TransportResult> {
    const body = composeOwnerText(message);
    const verdict = guardOwnerMessage(message.kind, body);
    if (!verdict.allowed) {
      // Refused, not masked, and not retryable: the same message would be refused again.
      return {
        accepted: false,
        providerStatus: `refused:${verdict.reason}`,
        retryable: false,
      };
    }

    let lastStatus = 'no_messages';
    for (const chunk of verdict.messages) {
      const result = await this.postOne(chunk);
      // Partial delivery is possible across chunks and is reported honestly: the first
      // failure stops the sequence and the whole send is recorded as not accepted.
      if (!result.accepted) return result;
      lastStatus = result.providerStatus;
    }
    return { accepted: true, providerStatus: lastStatus, retryable: false };
  }

  private async postOne(text: string): Promise<TransportResult> {
    const method = 'sendMessage';
    assertMethodPermitted(method);
    const url = `${this.config.apiBase}/bot${this.config.token}/${method}`;
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.ownerChatId,
          text,
          // No parse mode: the text is plain, so nothing in it can be interpreted as
          // markup, and there is no escaping bug to get wrong.
          disable_web_page_preview: true,
        }),
      });
      if (response.ok) {
        return { accepted: true, providerStatus: 'accepted', retryable: false };
      }
      const retryable = response.status === 429 || response.status >= 500;
      return {
        accepted: false,
        // The status code only. A body could echo the request URL, and the request URL
        // contains the token.
        providerStatus: redactTelegramToken(`http_${String(response.status)}`),
        retryable,
      };
    } catch (caught) {
      // The catch that matters. A fetch failure commonly includes the request URL.
      return {
        accepted: false,
        providerStatus: redactTelegramToken(
          caught instanceof Error ? `transport_error:${caught.message}` : 'transport_error',
        ),
        retryable: true,
      };
    }
  }
}

/**
 * Assemble the text actually sent: the prefix, the headline, then the body.
 *
 * The prefix is not decoration. The founder's own automation posts to this chat, and a
 * message they cannot attribute in one glance is a message they will eventually ignore.
 */
export function composeOwnerText(message: OutboundMessage): string {
  const headline = message.subject.trim();
  const detail = message.text.trim();
  const head = headline.length > 0 ? `${MESSAGE_PREFIX} — ${headline}` : MESSAGE_PREFIX;
  return detail.length > 0 ? `${head}\n\n${detail}` : head;
}

/**
 * Build the transport from Worker bindings.
 *
 * Returns `undefined` when the channel is not configured — which is an ordinary state,
 * not an error. Every caller treats it the way the email path treats a missing
 * `RESEND_API_KEY`: record the intent, mark it suppressed, carry on.
 */
export function telegramTransportFromEnv(
  env: Readonly<Record<string, unknown>>,
  fetchImpl: TelegramFetch,
): NotificationTransport | undefined {
  const loaded = loadTelegramConfig(env);
  if (!loaded.ok) return undefined;
  return new TelegramTransport(loaded.config, fetchImpl);
}

/* -------------------------------------------------------------------------- */
/* sending an owner alert                                                     */
/* -------------------------------------------------------------------------- */

export interface OwnerAlert {
  readonly kind: OwnerAlertKind;
  /**
   * Stable, clock-free, and unique to the *event*. `approval_needed:apr_01J8…`, not
   * `approval_needed:1758240000`. This is what makes the send at-most-once.
   */
  readonly notificationKey: string;
  /** One short line. Appears after the `ITISYOU Verify` prefix. */
  readonly headline: string;
  /**
   * The body. Keep it to references and numbers: an opaque id the owner can tap through,
   * a count, an amount. Anything descriptive about a customer will be refused by the
   * guard, which is the intended behaviour rather than an obstacle.
   */
  readonly detail: string;
  readonly workspaceId?: string | null;
}

export interface OwnerAlertDependencies {
  readonly port: SupportDataPort;
  /** Absent when the channel is not configured. Ordinary, never an error. */
  readonly transport?: NotificationTransport | undefined;
  readonly wait?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * A stable reference for the owner's chat, hashed before storage. Never the chat id
   * itself: `recipient_hash` is a hash column, and a chat id in it would be a stored
   * identifier for a private channel.
   */
  readonly ownerReference?: string;
}

/**
 * Send one owner alert to Telegram.
 *
 * Goes through `dispatchNotification`, so a duplicate `notification_key` sends once here
 * exactly as it does on email, the outcome is recorded in `notification_deliveries`, and
 * a missing transport is a `suppressed` row rather than a thrown error. Never throws.
 */
export async function sendOwnerAlert(
  deps: OwnerAlertDependencies,
  alert: OwnerAlert,
): Promise<SendResult> {
  const dependencies: SendDependencies = {
    port: deps.port,
    ...(deps.transport === undefined ? {} : { transport: deps.transport }),
    ...(deps.wait === undefined ? {} : { wait: deps.wait }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };

  return dispatchNotification(dependencies, {
    notificationKey: alert.notificationKey,
    workspaceId: alert.workspaceId ?? null,
    channel: 'telegram',
    recipient: deps.ownerReference ?? 'owner:telegram',
    template: alert.kind,
    message: {
      to: deps.ownerReference ?? 'owner:telegram',
      subject: alert.headline,
      text: alert.detail,
      // Telegram has no HTML body. The plain text is the whole message, which is also why
      // there is no second rendering that could disagree with the first.
      html: '',
      kind: alert.kind,
    },
    noTransportStatus: 'no_telegram_transport_configured',
  });
}
