/**
 * Opaque, time-sortable identifiers.
 *
 * Shape: `<prefix>_<10 chars of Crockford base32 time><16 chars of randomness>`.
 *
 * The time prefix makes ids sort in creation order, which is what keeps cursor
 * pagination and due-job scans on an index. The random tail comes from
 * `crypto.randomUUID()`, so an id never encodes a sequence number and an outsider
 * cannot infer how many rows we hold — an auto-increment id would leak exactly that.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

const PREFIX_RE = /^[a-z][a-z0-9]{0,11}$/;

/**
 * Canonical prefixes. Every agent uses these constants rather than a literal so an id
 * never gains a second spelling.
 */
export const ID_PREFIX = {
  user: 'usr',
  workspace: 'ws',
  invitation: 'inv',
  session: 'sess',
  connection: 'conn',
  credential: 'cred',
  workflow: 'wf',
  workflowVersion: 'wfv',
  sourceEvent: 'sev',
  run: 'run',
  runAttempt: 'att',
  assertion: 'asr',
  evidence: 'evd',
  webhookReceipt: 'whr',
  outbox: 'obx',
  order: 'ord',
  subscription: 'sub',
  entitlement: 'ent',
  refund: 'ref',
  budgetAccount: 'bac',
  budgetEntry: 'bce',
  approval: 'apr',
  auditEvent: 'aud',
  supportCase: 'sup',
  notification: 'ntf',
  campaign: 'cmp',
  maintenanceJob: 'mjb',
  qualityRun: 'qrn',
  cleanupRun: 'clr',
  lease: 'lse',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

function encodeTime(ms: number): string {
  let remaining = Math.max(0, Math.floor(ms));
  let out = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    out = CROCKFORD[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function randomTail(): string {
  // randomUUID() is a CSPRNG in both Workers and Node 22. Hex digits are a subset of the
  // Crockford alphabet, so the resulting id stays in one character class.
  const hex = crypto.randomUUID().replace(/-/g, '').toUpperCase();
  return hex.slice(0, RANDOM_CHARS);
}

/**
 * Mint a new id. `at` exists only so tests can pin the time component; production code
 * should always take the default.
 */
export function newId(prefix: string, at: number = Date.now()): string {
  if (!PREFIX_RE.test(prefix)) {
    throw new TypeError(`id prefix must match ${PREFIX_RE.source}, received: ${prefix}`);
  }
  return `${prefix}_${encodeTime(at)}${randomTail()}`;
}

/** Cheap shape check. Never a substitute for a scoped database lookup. */
export function isId(value: unknown, prefix?: string): value is string {
  if (typeof value !== 'string') return false;
  const underscore = value.indexOf('_');
  if (underscore <= 0) return false;
  const head = value.slice(0, underscore);
  const tail = value.slice(underscore + 1);
  if (!PREFIX_RE.test(head)) return false;
  if (tail.length !== TIME_CHARS + RANDOM_CHARS) return false;
  for (const ch of tail) if (!CROCKFORD.includes(ch)) return false;
  return prefix === undefined || head === prefix;
}
