/**
 * SEC-6xx / AUTH-2xx — structural regression checks over the source tree.
 *
 * These are cheap grep-shaped invariants that catch the specific mistakes this codebase
 * cannot survive. They are NOT a substitute for behavioural tests; they exist because a
 * behavioural test only covers the route someone remembered to write a test for, whereas
 * "no query on a customer table without workspace_id" covers the route nobody thought
 * about — including the one written next week.
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
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Strips line and block comments so a doc-comment example cannot trip a check. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Every string literal in a source file, with the offset where it started. */
function stringLiterals(source: string): { readonly text: string; readonly index: number }[] {
  const re = /`(?:[^`\\]|\\[\s\S])*`|'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"/g;
  const out: { text: string; index: number }[] = [];
  for (const m of source.matchAll(re)) out.push({ text: m[0], index: m.index ?? 0 });
  return out;
}

const SQL_KEYWORD = /\b(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/i;

/** Tables holding data that belongs to exactly one paying customer. */
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
];

/**
 * A cross-tenant query is sometimes correct — the scheduler's due-job sweep, the
 * retention delete, the owner's user-scoped TOTP secret. It must never be ACCIDENTAL.
 * A query touching a customer-scoped table without naming workspace_id is allowed only
 * when the author wrote `tenant-scope:exempt <reason>` in a comment just above it, which
 * turns an oversight into a decision somebody signed their name to.
 */
const EXEMPT_MARKER = 'tenant-scope:exempt';

function isExempt(source: string, index: number): boolean {
  return source.slice(Math.max(0, index - 400), index).includes(EXEMPT_MARKER);
}

function scopedTablesIn(sql: string): string[] {
  return WORKSPACE_SCOPED_TABLES.filter((t) => new RegExp(`\\b${t}\\b`).test(sql));
}

describe('tenant scope: every SQL statement that reads customer data is scoped', () => {
  const dbDir = join(ROOT, 'apps', 'app', 'src', 'db');

  it('AUTH-201 no customer-scoped table is queried outside apps/app/src/db', () => {
    expect(existsSync(dbDir), `${dbDir} must exist (owner: A02)`).toBe(true);
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, 'apps', 'app', 'src'))) {
      if (file.startsWith(dbDir)) continue;
      for (const literal of stringLiterals(read(file))) {
        if (!SQL_KEYWORD.test(literal.text)) continue;
        if (scopedTablesIn(literal.text).length === 0) continue;
        offenders.push(`${relative(ROOT, file)}: ${literal.text.slice(0, 90).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AUTH-202 every query on a customer-scoped table names workspace_id or is marked exempt', () => {
    const offenders: string[] = [];
    for (const file of walk(dbDir)) {
      const source = read(file);
      for (const literal of stringLiterals(source)) {
        const sql = literal.text;
        if (!SQL_KEYWORD.test(sql)) continue;
        if (scopedTablesIn(sql).length === 0) continue;
        if (/\bworkspace_id\b/.test(sql)) continue;
        if (isExempt(source, literal.index)) continue;
        offenders.push(`${relative(ROOT, file)}: ${sql.slice(0, 110).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AUTH-203 no query interpolates a runtime value into SQL instead of binding it', () => {
    // Interpolating a constant column list (`${RUN_COLUMNS}`) or a locally-built list of
    // literal predicates (`${where.join(' AND ')}`) is safe. Interpolating anything else
    // is how a workspace id, a status or a limit ends up concatenated into a statement.
    const SAFE =
      /^\s*(?:[A-Z][A-Z0-9_]*(?:\.[A-Za-z0-9_]+(?:\([^)]*\))?)*|[A-Za-z_$][\w$]*\.join\([^)]*\))\s*$/;
    const offenders: string[] = [];
    for (const file of walk(dbDir)) {
      for (const literal of stringLiterals(read(file))) {
        if (!literal.text.startsWith('`') || !SQL_KEYWORD.test(literal.text)) continue;
        for (const m of literal.text.matchAll(/\$\{([^}]*)\}/g)) {
          const expression = (m[1] ?? '').replace(/\s+/g, ' ');
          if (SAFE.test(expression)) continue;
          offenders.push(`${relative(ROOT, file)}: \${${expression.slice(0, 70)}}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AUTH-204 a child-row read proves parentage inside the same statement', () => {
    // The dangerous shape is: `getRun(runId)`, then `getEvidence(evidenceId)`, then a
    // separate `if (evidence.run_id === run.id)`. Any read of a child row must carry the
    // workspace predicate in the SAME statement, so no unscoped row ever exists in
    // memory where a later branch can forget to check it.
    const offenders: string[] = [];
    for (const file of walk(dbDir)) {
      const source = read(file);
      for (const literal of stringLiterals(source)) {
        const sql = literal.text;
        const child = /\bFROM\s+(assertions|evidence|run_attempts|workflow_versions|credential_versions)\b/i;
        if (!child.test(sql)) continue;
        if (/\bworkspace_id\b/.test(sql)) continue;
        if (/\bJOIN\b[\s\S]*\bworkspace_id\b/i.test(sql)) continue;
        if (isExempt(source, literal.index)) continue;
        offenders.push(`${relative(ROOT, file)}: ${sql.slice(0, 110).replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('SSRF: no outbound request bypasses the URL guard', () => {
  const connectorsDir = join(ROOT, 'packages', 'connectors', 'src');

  it('SEC-601 packages/connectors/src exists (owner: A04)', () => {
    expect(existsSync(connectorsDir), `${connectorsDir} must exist`).toBe(true);
  });

  it('SEC-602 every connector file that calls fetch also routes through the URL guard', () => {
    const offenders: string[] = [];
    for (const file of walk(connectorsDir)) {
      const source = stripComments(read(file));
      if (!/\bfetch\s*\(/.test(source)) continue;
      if (!/checkUrl|assertSafeUrl|urlGuard|url-guard|safeFetch/i.test(source)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SEC-603 no connector uses redirect:"follow" — redirects must be re-checked per hop', () => {
    const offenders: string[] = [];
    for (const file of walk(connectorsDir)) {
      if (/redirect\s*:\s*['"]follow['"]/.test(stripComments(read(file)))) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('SEC-604 no provider base URL is read from the database or from a request', () => {
    const offenders: string[] = [];
    for (const file of walk(connectorsDir)) {
      const source = stripComments(read(file));
      if (/(baseUrl|base_url|apiHost|endpoint)\s*[:=]\s*(row|record|req|request|body|params|query)\b/i.test(source)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('secret hygiene in a public repository', () => {
  it('SEC-610 .dev.vars.example contains only placeholders, never a real-shaped key', () => {
    const example = read(join(ROOT, '.dev.vars.example'));
    expect(example).not.toMatch(/\bsk_(?:live|test)_[A-Za-z0-9]{20,}/);
    expect(example).not.toMatch(/\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}/);
    expect(example).not.toMatch(/\bwhsec_[A-Za-z0-9]{24,}/);
    expect(example).not.toMatch(/\bpat-(?:na|eu)[0-9]?-[0-9a-f]{8}-/);
  });

  it('SEC-611 .gitignore excludes every real secret file shape', () => {
    const ignore = read(join(ROOT, '.gitignore'));
    for (const pattern of ['.dev.vars', '.env', '*.pem', '*.key', '.wrangler/']) {
      expect(ignore, pattern).toContain(pattern);
    }
    expect(ignore).toContain('!.dev.vars.example');
  });

  it('SEC-612 wrangler.jsonc declares no secret in plaintext vars', () => {
    const wrangler = read(join(ROOT, 'apps', 'app', 'wrangler.jsonc'));
    for (const forbidden of [
      'CREDENTIAL_KEY',
      'SESSION_SIGNING_KEY',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'RESEND_API_KEY',
      'RESEND_WEBHOOK_SECRET',
      'OPENROUTER_API_KEY',
      'OWNER_BOOTSTRAP_TOKEN',
      'ANALYTICS_SALT',
    ]) {
      expect(wrangler, forbidden).not.toContain(forbidden);
    }
  });

  it('SEC-613 source maps are not emitted, so the worker bundle ships no source', () => {
    const base = JSON.parse(read(join(ROOT, 'tsconfig.base.json'))) as {
      compilerOptions?: Record<string, unknown>;
    };
    expect(base.compilerOptions?.['sourceMap']).toBe(false);
  });

  it('SEC-614 no server-only secret name is referenced from a public asset', () => {
    const publicDir = join(ROOT, 'apps', 'app', 'public');
    const files = existsSync(publicDir)
      ? readdirSync(publicDir)
          .map((f) => join(publicDir, f))
          .filter((f) => statSync(f).isFile())
      : [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of [
        'STRIPE_SECRET_KEY',
        'CREDENTIAL_KEY',
        'SESSION_SIGNING_KEY',
        'RESEND_API_KEY',
        'OPENROUTER_API_KEY',
      ]) {
        expect(source, `${relative(ROOT, file)} / ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('public CI posture', () => {
  const workflowPath = join(ROOT, '.github', 'workflows', 'ci.yml');

  it('SEC-620 the CI workflow exists and pins top-level permissions to contents: read', () => {
    expect(existsSync(workflowPath)).toBe(true);
    const ci = read(workflowPath);
    expect(ci).toMatch(/^permissions:\s*\n\s+contents:\s*read\s*$/m);
    expect(ci).not.toMatch(/permissions:\s*write-all/);
  });

  it('SEC-621 CI never uses pull_request_target', () => {
    const triggers = read(workflowPath).replace(/^\s*#.*$/gm, '');
    expect(triggers).not.toContain('pull_request_target');
  });

  it('SEC-622 every action in CI is pinned to a 40-character commit SHA', () => {
    const ci = read(workflowPath);
    const uses = [...ci.matchAll(/uses:\s*([^\s#]+)/g)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref, ref).toMatch(/@[0-9a-f]{40}$/);
  });

  it('SEC-623 CI references no deployment secret', () => {
    // Comments explain WHY these must never appear, so strip them before checking.
    const ci = read(workflowPath).replace(/^\s*#.*$/gm, '');
    for (const forbidden of [
      'CLOUDFLARE_API_TOKEN',
      'STRIPE_SECRET_KEY',
      'RESEND_API_KEY',
      'secrets.CF_',
      'wrangler deploy',
    ]) {
      expect(ci, forbidden).not.toContain(forbidden);
    }
  });

  it('SEC-624 the secret scanner recognises every provider key shape we actually use', () => {
    const scanner = read(join(ROOT, 'scripts', 'scan-secrets.mjs'));
    for (const rule of [
      'stripe-secret',
      'stripe-webhook-secret',
      'resend-key',
      'hubspot-token',
      'openrouter-key',
      'private-key-block',
      'jwt-with-payload',
    ]) {
      expect(scanner, rule).toContain(rule);
    }
  });
});
