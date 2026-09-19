/**
 * The email `NotificationTransport`: Resend, and nothing else.
 *
 * ## Why this file had to exist before any wiring was worth doing
 *
 * `send.ts` was written against a `NotificationTransport` interface and
 * `transportFromEnv(env, build)` — a factory that takes the *builder* as an argument.
 * Nothing in the repository ever supplied that builder, so every call site would have had
 * `transport: undefined`, every notification would have settled as
 * `no_email_transport_configured`, and the whole delivery path would have been wired,
 * green, and silent. That is the same defect class this task exists to close, one layer
 * down: correct code reached by nothing.
 *
 * ## What it is allowed to do
 *
 *  - One POST to one **fixed** host. `https://api.resend.com/emails` is a constant in this
 *    file. Brief rule 8 — no customer-controlled URL is ever fetched — is kept by there
 *    being no URL input at all.
 *  - Report acceptance. Never delivery. `accepted` here means Resend's API answered 2xx to
 *    a submission; `send.ts` normalises that to `accepted_by_sending_service` and there is
 *    no code path in this repository that can record anything stronger.
 *  - Say whether a retry is worth it. 5xx, 429 and a network fault are retryable; a 4xx
 *    that is not 429 is not, because sending the same rejected message twice is just two
 *    rejections.
 *
 * ## What it must never do
 *
 * Put the API key anywhere it can be read back. `providerStatus` is written into
 * `notification_deliveries.provider_status` and read by the owner queue, so every string
 * that leaves this file goes through `redact()` first. A `fetch` failure whose message
 * contains the request URL, an upstream error body that echoes the `Authorization`
 * header — both have happened to other people, and both are one log line away from a
 * credential in a database the owner dashboard renders. Brief rule 7.
 */
import type { NotificationTransport, OutboundMessage, TransportResult } from '../support/port';

/** The only host this file will ever talk to. Not configurable, deliberately. */
export const RESEND_SEND_ENDPOINT = 'https://api.resend.com/emails';

/** A submission that has not answered by now is treated as a network fault and retried. */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * Anything shaped like a Resend API key, removed from every string this file returns.
 *
 * Deliberately broader than the exact key we hold: the point is that no token-shaped
 * substring reaches the database, whether it came from our own configuration or from an
 * upstream error body echoing something back.
 */
const KEY_SHAPE = /re_[A-Za-z0-9_-]{4,}/g;

function redact(value: string, apiKey: string): string {
  let out = value.replace(KEY_SHAPE, 're_[redacted]');
  if (apiKey.length > 0) out = out.split(apiKey).join('[redacted]');
  return out.slice(0, 200);
}

export interface ResendEmailTransportOptions {
  readonly apiKey: string;
  /** The `From:` header. A verified sender on the Resend account; never customer input. */
  readonly fromAddress: string;
  /** Injected in tests. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class ResendEmailTransport implements NotificationTransport {
  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ResendEmailTransportOptions) {
    this.#apiKey = options.apiKey;
    this.#from = options.fromAddress;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  }

  async send(message: OutboundMessage): Promise<TransportResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    try {
      const response = await this.#fetch(RESEND_SEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        // Exactly the four fields a transactional message needs. No tracking pixel, no
        // click rewriting, no tags carrying a workspace id into a third party's analytics.
        body: JSON.stringify({
          from: this.#from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: controller.signal,
      });

      if (response.ok) {
        // The body carries Resend's message id. It is not read: it would be a provider
        // identifier stored against a customer for no purpose we can act on, and the only
        // thing this result may assert is that the submission was accepted.
        return { accepted: true, providerStatus: 'accepted', retryable: false };
      }

      const detail = await readErrorDetail(response);
      const retryable = response.status === 429 || response.status >= 500;
      return {
        accepted: false,
        providerStatus: redact(`http_${String(response.status)}${detail}`, this.#apiKey),
        retryable,
      };
    } catch (error) {
      // An abort, a DNS failure, a dropped socket. All retryable, and none of them may
      // carry the request URL — which holds no secret today, but the message may also be
      // an upstream string we did not write.
      const name = error instanceof Error ? error.name : 'unknown';
      return {
        accepted: false,
        providerStatus: redact(`network_${name}`, this.#apiKey),
        retryable: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Resend's error bodies name the problem; the name is useful, the body is not trusted. */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      const name = (parsed as Record<string, unknown>)['name'];
      if (typeof name === 'string' && name.length > 0) return `_${name}`;
      const message = (parsed as Record<string, unknown>)['message'];
      if (typeof message === 'string' && message.length > 0) return `_${message}`;
    }
  } catch {
    // A non-JSON error body tells us nothing we can record honestly.
  }
  return '';
}

/**
 * The bindings the email transport reads. A structural subset of the Worker's `Env`, so
 * this file does not depend on `index.ts` and `index.ts` can depend on it.
 */
export interface EmailTransportEnv {
  readonly RESEND_API_KEY?: string | undefined;
  readonly RESEND_FROM_ADDRESS?: string | undefined;
}

/**
 * Build the transport, or `undefined` when this deployment cannot send email.
 *
 * **`undefined` is a supported configuration, not an error.** Every caller passes it
 * straight into `SendDependencies.transport`, and `dispatchNotification` then records
 * `no_email_transport_configured` against the key and returns normally. Nothing on a
 * request path or a cron tick depends on email having gone out.
 *
 * Both values are required. A key with no verified sender cannot send, and guessing a
 * `From:` address is how a deployment starts sending as somebody else's domain.
 */
export function createEmailTransport(
  env: EmailTransportEnv,
  options: { readonly fetchImpl?: typeof fetch } = {},
): NotificationTransport | undefined {
  const apiKey = env.RESEND_API_KEY;
  const fromAddress = env.RESEND_FROM_ADDRESS;
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) return undefined;
  if (typeof fromAddress !== 'string' || fromAddress.trim().length === 0) return undefined;
  return new ResendEmailTransport({
    apiKey: apiKey.trim(),
    fromAddress: fromAddress.trim(),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
}
