/**
 * Visit analytics — plan §25.5.
 *
 * The brief for this file is short: count visits honestly, and never store anything that
 * identifies a person.
 *
 *  - **No raw IP is ever stored or returned.** An address goes into `visitSessionId` and
 *    a hash comes out. The returned `VisitSession` has no field an address could live in.
 *  - **The session id rotates daily.** The salt is `ANALYTICS_SALT` combined with the UTC
 *    date, so the same visitor on two days produces two unrelated ids. That is a
 *    deliberate loss of information: we give up cross-day tracking in exchange for not
 *    holding a durable identifier for anybody.
 *  - **Deduplicated sessions are an estimate.** They are never called "unique people".
 *    One person on a phone and a laptop is two sessions; two people behind one office NAT
 *    with the same browser build may be one.
 *  - **The numbers are reported separately and never reconciled.** Platform impressions,
 *    platform clicks, landing sessions, signups and paid customers each come from a
 *    different system with a different definition. Forcing them to agree would be a lie
 *    dressed as tidiness; clicks exceeding landing sessions is normal and expected.
 */
import { sha256Hex } from '@verify/security';

export type VisitClassification = 'external' | 'internal_test' | 'bot_suspected' | 'unknown';

// ---------------------------------------------------------------------------
// Session identity
// ---------------------------------------------------------------------------

/** The UTC date component that rotates the salt. Never local time. */
export function utcDateKey(now: Date): string {
  const iso = now.toISOString();
  return iso.slice(0, 10);
}

export interface VisitIdentityInput {
  /** Used only to compute the hash. Never stored, never logged, never returned. */
  readonly ip: string;
  readonly user_agent: string;
  /** Optional extra entropy that is also not an identifier on its own. */
  readonly accept_language?: string;
}

/**
 * A daily-rotating salted hash.
 *
 * The salt is required. Without it the hash would be a plain digest of an IP address,
 * which is reversible by brute force over the IPv4 space in seconds — so a missing salt
 * throws rather than silently degrading to something worse than useless.
 */
/**
 * Field separator for the hash input. A unit separator cannot occur in an IP address, a
 * user-agent or an Accept-Language header, so two different field splits can never produce
 * the same hash input. Written as an escape so the source file stays plain ASCII.
 */
const FIELD_SEPARATOR = '';

export async function visitSessionId(input: VisitIdentityInput, salt: string, now: Date): Promise<string> {
  if (salt.length < 16) {
    throw new TypeError('ANALYTICS_SALT must be at least 16 characters; a short salt makes the hash reversible');
  }
  const material = [
    'verify.visit.v1',
    utcDateKey(now),
    salt,
    input.ip,
    input.user_agent,
    input.accept_language ?? '',
  ].join(FIELD_SEPARATOR);
  return sha256Hex(material);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Substrings that identify a non-human agent. Lower-cased comparison. This list excludes
 * traffic; it never includes it — an agent not on this list is not therefore a human, it
 * is merely not known to be a crawler, which is why `unknown` exists as a separate class.
 */
export const CRAWLER_UA_MARKERS: readonly string[] = [
  'bot',
  'crawler',
  'spider',
  'slurp',
  'archiver',
  'facebookexternalhit',
  'bingpreview',
  'yandex',
  'ahrefs',
  'semrush',
  'mj12',
  'dotbot',
  'petalbot',
  'gptbot',
  'claudebot',
  'ccbot',
  'perplexitybot',
  'headlesschrome',
  'phantomjs',
  'python-requests',
  'python-urllib',
  'curl/',
  'wget/',
  'go-http-client',
  'java/',
  'okhttp',
  'axios/',
  'node-fetch',
  'libwww-perl',
  'lighthouse',
  'pingdom',
  'uptimerobot',
  'monitoring',
  'preview',
];

export interface VisitRequestInput extends VisitIdentityInput {
  readonly path: string;
  /** Raw query string, with or without a leading `?`. */
  readonly query: string;
  readonly referrer?: string;
  /** True when our internal-test cookie or header is present. */
  readonly internal_test_marker: boolean;
  /** Daily session ids belonging to the owner's own devices, if they have declared any. */
  readonly owner_session_ids?: readonly string[];
  /** `GET` is a visit. `HEAD` is a probe. */
  readonly method: string;
}

export function classifyVisit(input: VisitRequestInput, sessionId: string): VisitClassification {
  // An internal marker wins over everything: our own traffic is our own traffic even if
  // it looks perfect. It must never count toward the ten.
  if (input.internal_test_marker) return 'internal_test';
  if ((input.owner_session_ids ?? []).includes(sessionId)) return 'internal_test';

  const ua = input.user_agent.trim().toLowerCase();
  if (ua.length === 0) return 'unknown';
  if (CRAWLER_UA_MARKERS.some((marker) => ua.includes(marker))) return 'bot_suspected';
  if (input.method.toUpperCase() !== 'GET') return 'bot_suspected';
  // A browser-shaped agent that is not a known crawler. Still only "external", not "human".
  if (ua.includes('mozilla/') || ua.includes('safari/') || ua.includes('firefox/')) return 'external';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// The stored row
// ---------------------------------------------------------------------------

/** Mirrors `visit_sessions` in `migrations/0001_init.sql`. There is no address field. */
export interface VisitSession {
  readonly id: string;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly landing_path: string;
  readonly utm_source: string | null;
  readonly utm_medium: string | null;
  readonly utm_campaign: string | null;
  readonly classification: VisitClassification;
  readonly page_views: number;
  readonly expires_at: string;
}

export interface Utm {
  readonly source: string | null;
  readonly medium: string | null;
  readonly campaign: string | null;
}

const UTM_MAX_LENGTH = 64;
const UTM_SAFE = /^[A-Za-z0-9_.\-]{1,64}$/;

/** UTM values are attacker-controlled. Anything not plainly safe is dropped, not escaped. */
export function parseUtm(query: string): Utm {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  const pick = (key: string): string | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const trimmed = raw.trim().slice(0, UTM_MAX_LENGTH);
    return UTM_SAFE.test(trimmed) ? trimmed : null;
  };
  return { source: pick('utm_source'), medium: pick('utm_medium'), campaign: pick('utm_campaign') };
}

/**
 * How long a visit row lives before A09's retention sweep deletes it.
 *
 * The sweep reads `visit_sessions.expires_at`, not this number, so this is the only place
 * the policy is expressed and it must match A09's policy exactly. Fourteen days.
 */
export const VISIT_RETENTION_DAYS = 14;

export async function buildVisitSession(
  input: VisitRequestInput,
  salt: string,
  now: Date,
): Promise<VisitSession> {
  const id = await visitSessionId(input, salt, now);
  const utm = parseUtm(input.query);
  const iso = now.toISOString();
  const expires = new Date(now.getTime() + VISIT_RETENTION_DAYS * 86_400_000).toISOString();
  return {
    id,
    first_seen_at: iso,
    last_seen_at: iso,
    landing_path: input.path,
    utm_source: utm.source,
    utm_medium: utm.medium,
    utm_campaign: utm.campaign,
    classification: classifyVisit(input, id),
    page_views: 1,
    expires_at: expires,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface PlatformMetrics {
  /** From the ad platform. `null` means we have not read it. */
  readonly impressions: number | null;
  readonly clicks: number | null;
  readonly spend_minor: number | null;
  readonly retrieved_at: string | null;
}

export interface GrowthReportInput {
  readonly sessions: readonly VisitSession[];
  readonly platform: PlatformMetrics;
  /** The campaign tag we expect in `utm_campaign` for ad-attributed traffic. */
  readonly campaign_utm: string;
  /** Counted elsewhere, from the application's own records. */
  readonly qualified_signups: number;
  readonly paid_customers: number;
  readonly max_metric_age_seconds: number;
  readonly now: Date;
}

export interface GrowthReport {
  /** Straight from the platform. Never inferred, never back-filled. */
  readonly platform_impressions: number | null;
  readonly platform_clicks: number | null;
  readonly platform_spend_minor: number | null;
  readonly platform_metrics_retrieved_at: string | null;
  readonly platform_metrics_stale: boolean;

  /** From our own logs. Deduplicated by daily session id — an estimate, not people. */
  readonly observed_landing_sessions: number;
  /** Of those, the ones carrying our campaign's UTM. */
  readonly ad_attributed_sessions: number;
  /** External sessions with no UTM at all. Still visits; just not attributable. */
  readonly unattributed_sessions: number;

  readonly qualified_signups: number;
  readonly paid_customers: number;

  readonly excluded: {
    readonly bot_suspected: number;
    readonly internal_test: number;
    readonly unknown: number;
  };

  /** Always false. Attribution across an ad platform and a first-party log is never complete. */
  readonly attribution_complete: false;
  readonly caveats: readonly string[];
}

/**
 * Build the report. Deliberately does no reconciliation: if the platform says 14 clicks
 * and we saw 9 landing sessions, both numbers are printed and the gap is named. The gap is
 * information — bounced-before-load, blocked scripts, ad-blockers, misreported clicks —
 * and averaging it away destroys it.
 */
export function summariseGrowth(input: GrowthReportInput): GrowthReport {
  const byClass = { external: 0, internal_test: 0, bot_suspected: 0, unknown: 0 };
  let adAttributed = 0;
  let unattributed = 0;

  const seen = new Set<string>();
  for (const session of input.sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    byClass[session.classification] += 1;
    if (session.classification !== 'external') continue;
    if (session.utm_campaign === input.campaign_utm) {
      adAttributed += 1;
    } else if (session.utm_campaign === null && session.utm_source === null) {
      unattributed += 1;
    }
  }

  const retrievedAt = input.platform.retrieved_at;
  const ageSeconds =
    retrievedAt === null || Number.isNaN(Date.parse(retrievedAt))
      ? null
      : Math.floor((input.now.getTime() - Date.parse(retrievedAt)) / 1000);
  const stale = ageSeconds === null || ageSeconds > input.max_metric_age_seconds;

  const caveats: string[] = [
    'Deduplicated sessions are an estimate of visits, not a count of unique people. The session id rotates every UTC day, so one person returning tomorrow counts twice.',
    'Platform clicks and observed landing sessions come from different systems with different definitions and will not agree. Neither has been adjusted to match the other.',
    'Sessions classified internal_test or bot_suspected are excluded from every figure above and never count toward the ten external visits.',
  ];
  if (stale) {
    caveats.push(
      retrievedAt === null
        ? 'Platform metrics have never been retrieved. Every platform figure above is unknown, not zero.'
        : `Platform metrics were last retrieved at ${retrievedAt} and are stale.`,
    );
  }
  if (input.platform.clicks !== null && input.platform.clicks < byClass.external) {
    caveats.push(
      'More external landing sessions were observed than the platform reported clicks. Some of this traffic did not come from the ad; do not attribute it to the campaign.',
    );
  }
  if (byClass.unknown > 0) {
    caveats.push(
      `${byClass.unknown} session(s) could not be classified and are excluded. They may be human; we are not claiming either way.`,
    );
  }

  return {
    platform_impressions: input.platform.impressions,
    platform_clicks: input.platform.clicks,
    platform_spend_minor: input.platform.spend_minor,
    platform_metrics_retrieved_at: retrievedAt,
    platform_metrics_stale: stale,

    observed_landing_sessions: byClass.external,
    ad_attributed_sessions: adAttributed,
    unattributed_sessions: unattributed,

    qualified_signups: input.qualified_signups,
    paid_customers: input.paid_customers,

    excluded: {
      bot_suspected: byClass.bot_suspected,
      internal_test: byClass.internal_test,
      unknown: byClass.unknown,
    },

    attribution_complete: false,
    caveats,
  };
}

/** The founder's target, stated once so no report has to restate it. */
export const EXTERNAL_VISIT_TARGET = 10;

export interface TargetProgress {
  readonly target: number;
  readonly observed_external_sessions: number;
  readonly met: boolean;
  readonly statement: string;
}

export function targetProgress(report: GrowthReport): TargetProgress {
  const observed = report.observed_landing_sessions;
  return {
    target: EXTERNAL_VISIT_TARGET,
    observed_external_sessions: observed,
    met: observed >= EXTERNAL_VISIT_TARGET,
    statement:
      `${observed} of ${EXTERNAL_VISIT_TARGET} external landing sessions observed. ` +
      'This counts sessions, not people, and excludes our own testing and suspected crawlers.',
  };
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * How long after a visit we are willing to say a signup came from that campaign.
 *
 * It is pinned to `VISIT_RETENTION_DAYS`, and that is not a stylistic choice: we cannot
 * attribute a signup to a session row that has already been deleted. If the window were
 * longer than retention, attribution past the retention boundary would silently return
 * "not attributed" for a reason that has nothing to do with the visitor — which is exactly
 * the kind of number that looks like a finding and is actually a bug.
 *
 * Consequence worth stating plainly: a signup 20 days after the ad click is **not**
 * attributable, and the report will say so rather than guess.
 */
export const ATTRIBUTION_WINDOW_DAYS = VISIT_RETENTION_DAYS;

export type AttributionRefusal =
  | 'outside_window'
  | 'signup_before_visit'
  | 'not_external_traffic'
  | 'no_campaign_utm'
  | 'different_campaign'
  | 'unparseable_times';

export type AttributionResult =
  | { readonly attributed: true; readonly campaign: string; readonly elapsed_days: number }
  | { readonly attributed: false; readonly reason: AttributionRefusal; readonly detail: string };

/**
 * Attribute a signup to a campaign, or refuse and say why.
 *
 * Traffic we classified `internal_test` or `bot_suspected` is **never** attributed to any
 * campaign, regardless of what UTM it carried — our own testing cannot be allowed to make a
 * campaign look successful, and a crawler cannot sign up.
 */
export function attributeSignup(
  session: VisitSession,
  signupAtIso: string,
  campaignUtm: string,
  windowDays: number = ATTRIBUTION_WINDOW_DAYS,
): AttributionResult {
  if (session.classification !== 'external') {
    return {
      attributed: false,
      reason: 'not_external_traffic',
      detail: `session is classified ${session.classification} and is never attributed to a campaign`,
    };
  }
  if (session.utm_campaign === null) {
    return { attributed: false, reason: 'no_campaign_utm', detail: 'the session carried no utm_campaign' };
  }
  if (session.utm_campaign !== campaignUtm) {
    return {
      attributed: false,
      reason: 'different_campaign',
      detail: `session carried ${session.utm_campaign}, not ${campaignUtm}`,
    };
  }
  const visited = Date.parse(session.first_seen_at);
  const signed = Date.parse(signupAtIso);
  if (Number.isNaN(visited) || Number.isNaN(signed)) {
    return { attributed: false, reason: 'unparseable_times', detail: 'visit or signup time is not an ISO-8601 instant' };
  }
  if (signed < visited) {
    return {
      attributed: false,
      reason: 'signup_before_visit',
      detail: 'the signup happened before the visit; it cannot have been caused by it',
    };
  }
  const elapsedDays = Math.floor((signed - visited) / 86_400_000);
  if (elapsedDays >= windowDays) {
    return {
      attributed: false,
      reason: 'outside_window',
      detail: `${elapsedDays} days elapsed, which is outside the ${windowDays}-day attribution window`,
    };
  }
  return { attributed: true, campaign: campaignUtm, elapsed_days: elapsedDays };
}

/**
 * The aggregate view, and the only shape allowed to leave this module for display.
 *
 * It holds counts and nothing else. There is no session id, no landing path and no
 * per-visitor sequence in it, so a caller rendering a growth panel physically cannot
 * expose one visitor's journey — the data is not in the object to expose.
 */
export interface GrowthAggregate {
  readonly external_sessions: number;
  readonly ad_attributed_sessions: number;
  readonly unattributed_sessions: number;
  readonly excluded_bot_suspected: number;
  readonly excluded_internal_test: number;
  readonly excluded_unknown: number;
  readonly qualified_signups: number;
  readonly paid_customers: number;
}

export function aggregateOnly(report: GrowthReport): GrowthAggregate {
  return {
    external_sessions: report.observed_landing_sessions,
    ad_attributed_sessions: report.ad_attributed_sessions,
    unattributed_sessions: report.unattributed_sessions,
    excluded_bot_suspected: report.excluded.bot_suspected,
    excluded_internal_test: report.excluded.internal_test,
    excluded_unknown: report.excluded.unknown,
    qualified_signups: report.qualified_signups,
    paid_customers: report.paid_customers,
  };
}
