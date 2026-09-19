/**
 * Creating the one platform owner, once.
 *
 * The platform owner is never created by public signup and never by a row somebody edits
 * by hand. It is created exactly once, from the `OWNER_BOOTSTRAP_TOKEN` deployment secret,
 * and the path closes behind itself.
 *
 * A10 (T-OWN-05) asked for this to be structural rather than a runbook step, because
 * "remember to delete the secret afterwards" is a step nobody performs. Four conditions,
 * all required:
 *
 *  1. `OWNER_BOOTSTRAP_TOKEN` is configured on the deployment.
 *  2. The presented token matches it, compared in constant time.
 *  3. The caller has **already proved possession of an email address** — a redeemed magic
 *     link, not a form field. The token authorises *promotion*; it is not an identity.
 *     The proved address must equal `OWNER_BOOTSTRAP_EMAIL`, normalised.
 *  4. No `users.is_platform_owner = 1` row exists yet.
 *
 * Condition 4 is what disables the path after first use, and it is a property of the data
 * rather than of a flag somebody could reset: once an owner exists, this function refuses
 * for the lifetime of the deployment whether or not the secret is still present.
 *
 * Every outcome — including every refusal — writes an audit row. A bootstrap attempt that
 * failed is exactly the event an owner wants to see.
 */
import { timingSafeEqual } from '@verify/security';

export const OWNER_BOOTSTRAP_AUDIT_ACTION = 'owner.bootstrap';

export type BootstrapRefusal =
  /** No `OWNER_BOOTSTRAP_TOKEN` on this deployment. The path does not exist here. */
  | 'not_configured'
  /** The presented token is not the deployment token. */
  | 'token_mismatch'
  /** Nobody has proved an email address; a bootstrap token is not an identity. */
  | 'unverified_subject'
  /** The proved address is not the configured bootstrap address. */
  | 'subject_mismatch'
  /** An owner already exists. This is the permanent state after first use. */
  | 'already_bootstrapped';

export type BootstrapResult =
  | { readonly ok: true; readonly userId: string; readonly authSubject: string }
  | { readonly ok: false; readonly refusal: BootstrapRefusal; readonly message: string };

export interface BootstrapInput {
  /** The token pasted into the bootstrap form. Never logged, never echoed. */
  readonly presentedToken: string;
  /**
   * The email address this session has ALREADY proved, by redeeming a magic link. `null`
   * when the caller has proved nothing — which is itself a refusal, not a prompt.
   */
  readonly verifiedAuthSubject: string | null;
}

export interface BootstrapDeps {
  /** `OWNER_BOOTSTRAP_TOKEN`, or null when the deployment does not carry one. */
  readonly configuredToken: string | null;
  /** `OWNER_BOOTSTRAP_EMAIL`, or null. Absent means no address is authorised. */
  readonly configuredEmail: string | null;
  /** True when any `users.is_platform_owner = 1` row exists. */
  readonly platformOwnerExists: () => Promise<boolean>;
  /** Promote the already-existing, already-verified user. Returns its id. */
  readonly promote: (authSubject: string) => Promise<string>;
  /** Writes the audit row. Metadata is redacted by this module before it is handed over. */
  readonly recordAudit: (entry: {
    readonly action: string;
    readonly actor: string;
    readonly outcome: 'granted' | BootstrapRefusal;
    readonly occurredAt: string;
  }) => Promise<void>;
  readonly now: Date;
}

/** Same normalisation A02 uses for `users.auth_subject`: trimmed, lower-cased. */
export function normaliseAuthSubject(value: string): string {
  return value.trim().toLowerCase();
}

function refusal(r: BootstrapRefusal, message: string): BootstrapResult {
  return { ok: false, refusal: r, message };
}

const MESSAGES: Record<BootstrapRefusal, string> = {
  not_configured:
    'This deployment carries no owner bootstrap secret, so there is nothing to bootstrap from.',
  token_mismatch: 'That bootstrap token is not the one this deployment was given.',
  unverified_subject:
    'Sign in with the magic link for the bootstrap address first. A bootstrap token proves a deployment, not a person.',
  subject_mismatch:
    'The address you signed in with is not the address this deployment authorises for bootstrap.',
  already_bootstrapped:
    'A platform owner already exists. Bootstrap is closed permanently on this deployment; ' +
    'to change owner, sign in as the existing one.',
};

/**
 * Attempt the one-time promotion.
 *
 * The ordering matters and is deliberate: configuration, then token, then identity, then
 * the existence check last. An unconfigured deployment and a wrong token are answered
 * without any database access at all, so a token-guessing loop cannot be used to probe
 * whether an owner exists.
 */
export async function bootstrapOwner(
  input: BootstrapInput,
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const occurredAt = deps.now.toISOString();
  const actor =
    input.verifiedAuthSubject === null
      ? 'anonymous'
      : normaliseAuthSubject(input.verifiedAuthSubject);

  async function refuse(r: BootstrapRefusal): Promise<BootstrapResult> {
    await deps.recordAudit({ action: OWNER_BOOTSTRAP_AUDIT_ACTION, actor, outcome: r, occurredAt });
    return refusal(r, MESSAGES[r]);
  }

  const configured = deps.configuredToken;
  if (configured === null || configured.length === 0) return refuse('not_configured');
  if (!timingSafeEqual(configured, input.presentedToken)) return refuse('token_mismatch');

  if (input.verifiedAuthSubject === null || input.verifiedAuthSubject.length === 0) {
    return refuse('unverified_subject');
  }
  const subject = normaliseAuthSubject(input.verifiedAuthSubject);
  const expected =
    deps.configuredEmail === null ? null : normaliseAuthSubject(deps.configuredEmail);
  if (expected === null || expected !== subject) return refuse('subject_mismatch');

  if (await deps.platformOwnerExists()) return refuse('already_bootstrapped');

  const userId = await deps.promote(subject);
  await deps.recordAudit({
    action: OWNER_BOOTSTRAP_AUDIT_ACTION,
    actor: subject,
    outcome: 'granted',
    occurredAt,
  });
  return { ok: true, userId, authSubject: subject };
}
