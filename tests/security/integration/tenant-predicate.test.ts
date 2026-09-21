/**
 * SEC-206 / SEC-21x — a false negative in A10's own tenant-scope check, and the
 * synthetic-data safety property.
 *
 * ## Why SEC-206 exists
 *
 * `SEC-202` in `source-scan.test.ts` passes a statement when `workspace_id` appears
 * ANYWHERE in it. That is too generous, and I wrote it, so it is mine to fix.
 *
 *     SELECT id, workspace_id FROM evidence WHERE expires_at <= ? ORDER BY id LIMIT ?
 *
 * is a deliberately cross-tenant sweep. It passes SEC-202 only because `workspace_id` is
 * in the SELECT list — the check reads a column name as if it were a predicate. Four
 * statements in `apps/app/src/db` pass for exactly that reason today. They are all
 * correct, but they are passing by accident, and an accidental pass is indistinguishable
 * from a real one when a genuinely unscoped query is added next to them.
 *
 * SEC-206 therefore looks only at what constrains the rows: the `WHERE` clause, an
 * `ON CONFLICT` target, and `JOIN ... ON` conditions. `INSERT` is excluded — an insert
 * has no predicate and its `workspace_id` column value is precisely how the new row gets
 * scoped, so requiring one there would be nonsense.
 *
 * Measured before writing, over `apps/app/src/db`: 576 string literals, 221 that look
 * like SQL, 108 touching a customer-scoped table. SEC-202's rule flags 16 of those;
 * the predicate rule flags the same 16 plus 4 retention/due-run SELECTs that were
 * passing on their column list, minus the INSERTs. Every one of the extra 4 is correct
 * and needs a marker, not a code change. That is the whole delta, and it is why this is
 * an additive case rather than an edit to SEC-202 — the lead measured that rule's
 * baseline and I am not going to invalidate it silently.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Blank comments while preserving byte offsets, so exempt markers stay findable. */
function blankComments(source: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:])(\/\/[^\n]*)/gm,
      (_all, before: string, comment: string) => before + blank(comment),
    );
}

function stringLiterals(source: string): { readonly text: string; readonly index: number }[] {
  const re = /`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"/g;
  const out: { text: string; index: number }[] = [];
  for (const m of source.matchAll(re)) out.push({ text: m[0], index: m.index ?? 0 });
  return out;
}

const READ_OR_WRITE = /\b(SELECT|UPDATE|DELETE FROM)\b/;
const SQL_CLAUSE = /\b(FROM|WHERE|SET|JOIN|ON CONFLICT)\b/;

const WORKSPACE_SCOPED_TABLES = [
  'memberships',
  'invitations',
  'connections',
  'credential_versions',
  'workflows',
  'workflow_versions',
  'source_events',
  'runs',
  'run_attempts',
  'assertions',
  'evidence',
  'orders',
  'subscriptions',
  'entitlements',
  'refunds',
  // Added after the retention sweep for these four carried `workspace_id` in its SELECT
  // list with no predicate constraining it — legitimate for an expiry-driven global sweep,
  // the same shape already established for evidence/source_events above, but invisible to
  // this check because the table itself was never on this list. A column in the SELECT list
  // is not a predicate, and this list is what makes that distinction reachable at all.
  'webhook_receipts',
  'audit_events',
  'notification_deliveries',
  'support_cases',
];

const EXEMPT_MARKER = 'tenant-scope:exempt';

/**
 * Everything that constrains which rows are touched: the WHERE clause onwards, plus each
 * `JOIN ... ON` condition. A column list is not a predicate.
 */
function predicateOf(sql: string): string {
  const where = /\b(WHERE|ON CONFLICT)\b/.exec(sql);
  const joins = [...sql.matchAll(/\bJOIN\b[\s\S]*?\bON\b([\s\S]*?)(?=\bJOIN\b|\bWHERE\b|$)/g)]
    .map((m) => m[1] ?? '')
    .join(' ');
  return `${where === null ? '' : sql.slice(where.index)} ${joins}`;
}

describe('tenant scope: the predicate, not the column list', () => {
  it('SEC-206 every SELECT/UPDATE/DELETE on a customer table is scoped in its PREDICATE', () => {
    const dbDir = join(ROOT, 'apps', 'app', 'src', 'db');
    expect(existsSync(dbDir)).toBe(true);
    const offenders: string[] = [];
    for (const file of walk(dbDir)) {
      const source = readFileSync(file, 'utf8');
      const blanked = blankComments(source);
      for (const literal of stringLiterals(blanked)) {
        const sql = literal.text;
        if (!READ_OR_WRITE.test(sql) || !SQL_CLAUSE.test(sql)) continue;
        // An INSERT has no predicate; its workspace_id column IS the scoping.
        if (
          /\bINSERT INTO\b/.test(sql) &&
          !/\b(SELECT|UPDATE|DELETE FROM)\b.*\bWHERE\b/.test(sql)
        ) {
          continue;
        }
        if (!WORKSPACE_SCOPED_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(sql))) continue;
        if (/\bworkspace_id\b/.test(predicateOf(sql))) continue;
        if (source.slice(Math.max(0, literal.index - 400), literal.index).includes(EXEMPT_MARKER)) {
          continue;
        }
        offenders.push(`${relative(ROOT, file)}: ${sql.slice(0, 120).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SEC-207 the exempt marker is a per-statement decision, not a blanket over a table map', () => {
    // A marker in a doc comment above a 130-line `const RETENTION = { ... }` covering ten
    // tables exempts every statement in it, including the ones added next month by
    // somebody who never read the comment. The marker's 400-character look-back is what
    // keeps it honest: it has to sit near the statement it excuses.
    //
    // This case asserts the look-back is not widened to "anywhere in the file".
    const selfSource = readFileSync(
      join(ROOT, 'tests', 'security', 'integration', 'source-scan.test.ts'),
      'utf8',
    );
    const m = /index - (\d+)\), index\)/.exec(selfSource);
    expect(m, 'isExempt no longer uses a bounded look-back').not.toBeNull();
    expect(Number(m?.[1] ?? Infinity)).toBeLessThanOrEqual(600);
  });
});

describe('synthetic data can never be mistaken for a real workspace', () => {
  it('SEC-210 the customer port declares whether it is synthetic, and the chrome reads it', () => {
    // `/app` is served today by `SyntheticCustomerDataPort`, which fabricates a session.
    // That is safe only because every page renders a visible notice. If the flag existed
    // but nothing consumed it, a demo workspace would be indistinguishable from a real
    // one — and a customer would read invented verification results as their own.
    const port = readFileSync(join(ROOT, 'apps', 'app', 'src', 'routes', 'app', 'port.ts'), 'utf8');
    expect(port).toMatch(/readonly synthetic: boolean/);
    const index = readFileSync(
      join(ROOT, 'apps', 'app', 'src', 'routes', 'app', 'index.ts'),
      'utf8',
    );
    expect(index).toMatch(/syntheticNotice\(port\.synthetic\)/);
    expect(index).toMatch(/syntheticStripe\(port\.synthetic\)/);
  });

  it('SEC-211 the synthetic port reports synthetic = true and cannot claim otherwise', () => {
    const synthetic = readFileSync(
      join(ROOT, 'apps', 'app', 'src', 'routes', 'app', 'syntheticPort.ts'),
      'utf8',
    );
    // A readonly literal `true`, not a constructor parameter something could pass `false` to.
    expect(synthetic).toMatch(/readonly synthetic = true;/);
    expect(synthetic).not.toMatch(/synthetic\s*[:=]\s*(false|options|params)/);
  });

  it('SEC-212 a synthetic workspace has no billing portal and nothing to buy', () => {
    // Verified against the deployed site on 2026-09-19: POST /app/onboarding/checkout
    // answers 503 with no stack trace and no secret, and the synthetic port's billing
    // portal returns null with a reason. Pinned here so a future wiring cannot quietly
    // make a demo workspace purchasable.
    //
    // `billingPortalLink` became TWO methods on 21 September 2026: `billingPortalAvailability`
    // (asks Stripe nothing, decides whether to draw the control) and `openBillingPortal`
    // (mints one session per click). Both are checked, because a synthetic workspace
    // becoming purchasable through either half is the thing this case is here to prevent.
    const synthetic = readFileSync(
      join(ROOT, 'apps', 'app', 'src', 'routes', 'app', 'syntheticPort.ts'),
      'utf8',
    );
    expect(synthetic).toMatch(/billingPortalAvailability[\s\S]{0,400}canOpen:\s*false/);
    expect(synthetic).toMatch(/openBillingPortal[\s\S]{0,400}href:\s*null/);
    expect(synthetic).not.toMatch(/https:\/\/checkout\.stripe\.com/);
  });

  it('SEC-213 the authenticated shell refuses a request with no session at 401', () => {
    // Not a redirect that loses the reason, and never a blank page that looks like data.
    const index = readFileSync(
      join(ROOT, 'apps', 'app', 'src', 'routes', 'app', 'index.ts'),
      'utf8',
    );
    expect(index).toMatch(
      /const session = await port\.session\(\);\s*\n\s*if \(session === null\)/,
    );
    expect(index).toMatch(/status: 401/);
  });
});
