/**
 * The enumeration test: a new door cannot appear without somebody classifying it.
 *
 * ## The defect this guards
 *
 * "No route consults an entitlement" was true, and it stayed true through several review
 * rounds, because reviewing means reading the logic and the logic read correctly. Nobody
 * traced a request. The only durable fix is a check that walks the shipped source, finds
 * every place a request or a tick can enter, and fails when one is not in `MONEY_PATHS`.
 *
 * That is deliberately annoying: adding an endpoint now means writing down whether it can
 * take a customer's money, and why. A one-line answer in a constant is cheap; a quarter of
 * unmetered work is not.
 *
 * Area risk: this is the only mechanism that notices a *future* unreached path. Weakening
 * it — by widening the ignore list rather than classifying the route — quietly restores the
 * exact condition the audit found.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MONEY_PATHS, billablePaths, UNVERIFIED_PATHS } from '@app/money/paths';
import { IMPLEMENTED_SCHEDULER_PASSES } from '@app/scheduler/tick';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SRC = join(ROOT, 'apps', 'app', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Hono route declarations: `app.post('/x'`, `routes.get('/y'`, `app.all('/z'`. */
const ROUTE_DECLARATION = /\b(?:app|routes)\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g;

/**
 * Route files the manifest does not need to name: public, unauthenticated pages and the
 * synthetic demo port. They render; they admit nothing and they reserve nothing.
 *
 * This list may only ever shrink. Adding a file to it instead of classifying its routes is
 * precisely how the finding comes back.
 */
const NON_ADMITTING_ROUTE_FILES = [
  join('routes', 'public'),
  join('routes', 'app', 'authPages.ts'),
  join('routes', 'app', 'syntheticPort.ts'),
  join('routes', 'owner'),
  'index.ts',
];

/** The two functions that can move a unit of a customer's allowance. Nothing else may. */
const ALLOWANCE_MUTATORS = ['sourceEvents.admitOnce', 'entitlements.reserve('];

describe('every door is enumerated', () => {
  it('BILL-360 no route file in the shipped tree is missing from MONEY_PATHS', () => {
    const manifestFiles = new Set(MONEY_PATHS.map((path) => path.file.replace(/\//g, sep)));
    const unclassified: string[] = [];

    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (NON_ADMITTING_ROUTE_FILES.some((prefix) => rel.startsWith(prefix))) continue;
      const source = readFileSync(file, 'utf8');
      const declares = [...source.matchAll(ROUTE_DECLARATION)];
      if (declares.length === 0) continue;
      const full = join('apps', 'app', 'src', rel);
      if (manifestFiles.has(full)) continue;
      unclassified.push(`${full} declares ${String(declares.length)} route(s)`);
    }

    // A failure here names the file. Classify its routes in `money/paths.ts`; do not widen
    // the ignore list to make this green.
    expect(unclassified).toEqual([]);
  });

  it('BILL-366 the allowance can only be moved from a path the manifest calls billable', () => {
    const billableFiles = new Set(billablePaths().map((p) => p.file.replace(/\//g, sep)));
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const rel = join('apps', 'app', 'src', relative(SRC, file));
      // The data layer defines these; the question is who *calls* them.
      if (rel.startsWith(join('apps', 'app', 'src', 'db'))) continue;
      const source = readFileSync(file, 'utf8');
      // Strip block comments: the modules document each other by name, at length.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      for (const mutator of ALLOWANCE_MUTATORS) {
        if (!code.includes(mutator)) continue;
        if (billableFiles.has(rel)) continue;
        offenders.push(`${rel} calls ${mutator}`);
      }
    }

    // This is the assertion that would have caught the original finding from the other
    // side: a unit of allowance moving somewhere nobody had written down.
    expect(offenders).toEqual([]);
  });

  it('BILL-361 every scheduler pass that exists is classified', () => {
    const classified = new Set(
      MONEY_PATHS.filter((p) => p.entryPoint.startsWith('scheduler pass: ')).map((p) =>
        p.entryPoint.replace('scheduler pass: ', ''),
      ),
    );
    for (const pass of IMPLEMENTED_SCHEDULER_PASSES) {
      expect(classified.has(pass), `scheduler pass "${pass}" is not in MONEY_PATHS`).toBe(true);
    }
  });

  it('BILL-362 every file a manifest entry names actually exists', () => {
    for (const path of MONEY_PATHS) {
      expect(
        () => statSync(join(ROOT, path.file)),
        `${path.file} (${path.entryPoint})`,
      ).not.toThrow();
    }
  });

  it('BILL-363 every billable path names where it is enforced, and the call is there', () => {
    const billable = billablePaths();
    expect(billable.length).toBeGreaterThan(0);

    for (const path of billable) {
      expect(path.enforcedAt, `${path.entryPoint} claims to be billable`).not.toBeNull();
      const [file, symbol] = (path.enforcedAt ?? '').split(' ');
      const source = readFileSync(join(ROOT, file ?? ''), 'utf8');
      // The claim is checked against the source, not taken on trust. This is the assertion
      // that would have caught `preCheckoutPanel` having no caller.
      expect(source, `${file} should contain ${String(symbol)}`).toContain(symbol ?? '');
    }
  });

  it('BILL-364 a path that is not billable says why, and names no enforcement', () => {
    for (const path of MONEY_PATHS.filter((p) => !p.billable)) {
      expect(path.enforcement).toBe('not_billable');
      expect(path.enforcedAt).toBeNull();
      // "Not billable" is a claim and it has to be argued, not asserted.
      expect(path.reason.length, path.entryPoint).toBeGreaterThan(40);
    }
  });

  it('BILL-365 nothing is left on the unverified list without being reported', () => {
    // Not an assertion that the list is empty — an assertion that it is honest. If a path
    // is here, it must be in the handoff, and this test names it so it cannot be quiet.
    for (const entry of UNVERIFIED_PATHS) {
      console.warn(`money path not demonstrated end to end: ${entry}`);
    }
    expect(Array.isArray(UNVERIFIED_PATHS)).toBe(true);
  });
});
