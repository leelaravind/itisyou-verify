/**
 * AUTH-4xx — the data ports, as a shape rather than as a promise.
 *
 * A05 designed `CustomerDataPort` so that **no method takes a workspace id**: the port is
 * resolved per request from the session, so a page cannot ask for another tenant's data
 * even by mistake. That is a genuinely better control than "remember the WHERE clause",
 * because it removes the parameter a developer could get wrong.
 *
 * A property like that decays silently. One method added with a `workspaceId` argument
 * "just for the owner view" and the guarantee is gone, with nothing to notice. So it is
 * asserted here, over the shipped interface source, and it stays asserted.
 *
 * The deliberate exception is A09's `getCaseForOwner(id)` — a cross-tenant read the owner
 * support queue genuinely needs. Exceptions are fine. Unmarked exceptions are not.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

/**
 * Method signatures declared inside a TypeScript interface body, as `name(args): Type`.
 * Deliberately simple: this runs over hand-written interface files, not arbitrary code.
 */
function methodSignatures(source: string): { readonly name: string; readonly args: string }[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const out: { name: string; args: string }[] = [];
  for (const m of withoutComments.matchAll(/^\s{2}(\w+)\(([^)]*)\)\s*:/gm)) {
    out.push({ name: m[1] ?? '', args: (m[2] ?? '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

const WORKSPACE_ARG = /\bworkspace(_?id|Id)\b/i;

describe('CustomerDataPort: the tenant cannot be named', () => {
  const source = read('apps', 'app', 'src', 'routes', 'app', 'port.ts');

  it('AUTH-401 the interface file exists and declares methods', () => {
    const methods = methodSignatures(source);
    expect(methods.length, 'no method signatures parsed — has the file shape changed?').toBeGreaterThan(
      5,
    );
  });

  it('AUTH-402 no CustomerDataPort method accepts a workspace id', () => {
    // THE property. If this fails, a page can now ask for a tenant by name, and every
    // customer-facing route needs re-reviewing for who supplies that argument.
    const offenders = methodSignatures(source)
      .filter((m) => WORKSPACE_ARG.test(m.args))
      .map((m) => `${m.name}(${m.args})`);
    expect(offenders).toEqual([]);
  });

  it('AUTH-403 no customer-facing page passes a workspace id into the port', () => {
    // The interface could stay clean while a page smuggles the id through an options
    // object. Check the call sites too.
    const offenders: string[] = [];
    for (const file of [
      'runPages.ts',
      'workspacePage.ts',
      'accountPages.ts',
      'onboardingPages.ts',
      'authPages.ts',
      'index.ts',
    ]) {
      const page = read('apps', 'app', 'src', 'routes', 'app', file);
      const body = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      for (const m of body.matchAll(/\bport\.(\w+)\(([^)]*)\)/g)) {
        if (WORKSPACE_ARG.test(m[2] ?? '')) offenders.push(`${file}: port.${m[1]}(${m[2]})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('AUTH-404 the session view carries the workspace, so the page never has to ask', () => {
    // The positive half: the id exists exactly once, on the server-resolved session.
    expect(source).toMatch(/interface SessionView[\s\S]*?readonly workspaceId: string/);
  });

  it('AUTH-405 no port method accepts a price, plan or entitlement from the caller', () => {
    // Engineering rule 5: never trust a browser-supplied price or entitlement. The port is
    // where such a value would enter if it ever did.
    const offenders = methodSignatures(source)
      .filter((m) => /\b(price|amountMinor|planVersion|entitlement|runLimit)\b/i.test(m.args))
      .map((m) => `${m.name}(${m.args})`);
    expect(offenders).toEqual([]);
  });
});

describe('SupportDataPort: the one deliberate cross-tenant read', () => {
  const source = read('apps', 'app', 'src', 'support', 'port.ts');

  it('AUTH-410 getCaseForOwner is documented as the single by-id-without-workspace read', () => {
    expect(source).toMatch(/getCaseForOwner/);
    // The exception must be stated where a reader of the interface will see it, not only
    // in a commit message.
    expect(source).toMatch(/There is no "by id" without a workspace, except `getCaseForOwner`/);
  });

  it('AUTH-411 getCaseForOwner is the ONLY support method that takes a bare id', () => {
    // Any other `something(id: string)` on this port is an undeclared cross-tenant read.
    const offenders = methodSignatures(source)
      .filter((m) => m.name !== 'getCaseForOwner')
      .filter((m) => /^id: string$/.test(m.args))
      .map((m) => `${m.name}(${m.args})`);
    expect(offenders).toEqual([]);
  });
});

describe('BillingDataPort: provider identifiers never arrive from a browser', () => {
  const source = read('apps', 'app', 'src', 'billing', 'port.ts');

  it('AUTH-420 the checkout-session reverse lookup exists only on the billing port', () => {
    // It is legitimate — Stripe hands us a session id in a signature-verified webhook and
    // nothing else — but it must not be reachable from a customer page. `CustomerDataPort`
    // is what the pages hold, and it must not expose it.
    expect(source).toMatch(/findOrderByCheckoutSession/);
    const customerPort = read('apps', 'app', 'src', 'routes', 'app', 'port.ts');
    expect(customerPort).not.toMatch(/findOrderByCheckoutSession|checkoutSessionId\s*:/);
  });

  it('AUTH-421 the reverse lookup is reachable only from the billing and data layers', () => {
    // If a customer-facing route ever calls it with a session id from a query string, that
    // is T-TEN-05: paste another tenant's `cs_...` and read their order. The lookup is
    // legitimate exactly once — inside the signature-verified webhook path.
    const offenders: string[] = [];
    for (const relative of [
      ['apps', 'app', 'src', 'routes', 'app', 'index.ts'],
      ['apps', 'app', 'src', 'routes', 'app', 'accountPages.ts'],
      ['apps', 'app', 'src', 'routes', 'app', 'runPages.ts'],
      ['apps', 'app', 'src', 'routes', 'app', 'workspacePage.ts'],
      ['apps', 'app', 'src', 'routes', 'public', 'index.ts'],
      ['apps', 'app', 'src', 'routes', 'owner', 'index.ts'],
      ['apps', 'app', 'src', 'support', 'cases.ts'],
      ['apps', 'app', 'src', 'privacy', 'export.ts'],
    ]) {
      let text = '';
      try {
        text = read(...relative);
      } catch {
        continue; // a file this agent has not written yet is not a finding
      }
      if (/findOrderByCheckoutSession/.test(text)) offenders.push(relative.join('/'));
    }
    expect(offenders).toEqual([]);
  });
});
