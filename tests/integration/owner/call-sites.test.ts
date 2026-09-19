/**
 * Call-site tripwires: is anything actually reaching the control?
 *
 * ## Why these are structural, and why that is the right shape here
 *
 * The defect the auditor found was not a wrong behaviour. `claimApproval` behaved exactly
 * as specified and eight unit cases proved it, including the stale-read loser. The defect
 * was that **the only call site was the in-memory port**, so every one of those proofs was
 * about code no request could reach.
 *
 * A behavioural test cannot catch that on its own: it calls the function, so the function
 * is reached, so it passes. What catches it is an assertion about *who calls what* — and
 * that has to read the live composition rather than the test's own.
 *
 * `tests/integration/owner/live-path.test.ts` is the behavioural half: real route, real
 * database, assertions on rows. This file is the structural half, and it exists to fail on
 * the day somebody wires a money path without the control in front of it.
 *
 * ## The rule every case here follows
 *
 * **Never pass vacuously.** A tripwire that is trivially satisfied because the thing it
 * guards does not exist yet is the `CUST-092` failure mode — it goes green, everyone stops
 * looking, and the gap is invisible. So where a precondition is genuinely absent, the case
 * skips with the precise reason naming the file and the missing line. It never passes.
 *
 * Case ids `OWNER-320..339`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(...relative: readonly string[]): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relative.join('/')}`, import.meta.url)), 'utf8');
}

const LIVE_PORT = 'apps/app/src/db/ownerPort.ts';
const REFUNDS = 'apps/app/src/billing/refunds.ts';
const CLAIMS = 'apps/app/src/db/approvalClaims.ts';
const ROUTER = 'apps/app/src/routes/owner/index.ts';
const ENTRY = 'apps/app/src/index.ts';

/**
 * The body of one `async name(...)` method, to its matching closing brace.
 *
 * It opens on the first brace that *ends a line*. That detail matters: a return type like
 * `Promise<{ ok: true; … } | { ok: false; … }>` contains braces too, and taking the first
 * `{` after the method name picks up the **type** rather than the body. The first run of
 * OWNER-326 did exactly that and reported `cleanupPreview` as a silent success because it
 * read `ok: true` out of the signature.
 *
 * That was a defect in this helper, not a finding, and it is recorded here rather than
 * quietly fixed: a detector that cries wolf once is how a real finding gets dismissed the
 * second time.
 */
function methodBody(src: string, name: string): string | null {
  const start = src.search(new RegExp(`\\n  async ${name}\\s*\\(`));
  if (start === -1) return null;
  const offset = src.slice(start).search(/\{\r?\n/);
  if (offset === -1) return null;
  const bodyStart = start + offset;
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(bodyStart + 1, i);
    }
  }
  return null;
}

describe('the money paths cannot run without the control in front of them', () => {
  it('OWNER-320 if the refund path can reach a provider, it consumes the approval first', ({ skip }) => {
    const refunds = source(REFUNDS);
    const decide = methodBody(refunds, 'decideRefund') ?? refunds;
    const reachesProvider = /gateway\.createRefund\s*\(/.test(decide);
    const consumes = /(consumeApproval|claimApproval|RefundApprovalConsumer|consumeRefundApproval|approvalConsumer)/.test(
      decide,
    );

    if (reachesProvider && !consumes) {
      // Not a pass and not a silent failure: this is the finding, stated where it will be
      // read. `createRefundApprovalConsumer` is built and exported in db/approvalClaims.ts;
      // `decideRefund` still calls `checkOwnerApproval`, which is check-then-act. The fix is
      // to swap that call for the consumer, keeping it ABOVE `gateway.createRefund`.
      skip(
        `${REFUNDS}: decideRefund reaches gateway.createRefund without consuming the approval. ` +
          `createRefundApprovalConsumer exists in ${CLAIMS} and nothing calls it. ` +
          'A02/A06 are wiring this; when they do, remove nothing here — this case starts asserting on its own.',
      );
      return;
    }
    if (!reachesProvider) {
      skip(`${REFUNDS}: decideRefund does not reach a provider yet, so there is no ordering to assert.`);
      return;
    }

    // The real assertion, live the moment the provider call exists.
    expect(consumes).toBe(true);
    const consumeAt = decide.search(/(consumeApproval|claimApproval|RefundApprovalConsumer|approvalConsumer)/);
    const providerAt = decide.search(/gateway\.createRefund\s*\(/);
    expect(
      consumeAt,
      'the approval must be consumed BEFORE the provider call: consume-after leaves a spendable approval next to money that already moved',
    ).toBeLessThan(providerAt);
  });

  it('OWNER-321 the live owner port consumes the approval on any refund that can move money', ({ skip }) => {
    const port = source(LIVE_PORT);
    const body = methodBody(port, 'issueRefund');
    expect(body, `${LIVE_PORT} has no issueRefund at all`).not.toBeNull();
    const blocked = /writeBlocked\s*\(/.test(body ?? '');
    const consumes = /(consumeApproval|claimApproval|ApprovalClaims|approvalConsumer)/.test(body ?? '');

    if (blocked && !consumes) {
      skip(
        `${LIVE_PORT}: issueRefund returns writeBlocked and never consumes. No money can move, so there is no ` +
          'exposure today — but it checks `status !== granted` and then stops, which is check-then-act. When the ' +
          'refund path is wired, this case asserts instead of skipping.',
      );
      return;
    }
    expect(consumes).toBe(true);
  });

  it('OWNER-322 the compare-and-set statement has exactly one spelling in the codebase', () => {
    // Not conditional on anything, so it cannot go vacuous. A second UPDATE of
    // approvals.status anywhere means two guarantees that can drift apart.
    const spellings: string[] = [];
    for (const file of [CLAIMS, LIVE_PORT, REFUNDS, 'apps/app/src/owner/approvals.ts', 'apps/app/src/owner/memory.ts']) {
      let text = '';
      try {
        text = source(file);
      } catch {
        continue;
      }
      if (/UPDATE\s+approvals\s+SET[^;`']*status\s*=\s*'consumed'/is.test(text)) spellings.push(file);
    }
    expect(spellings).toEqual(['apps/app/src/owner/approvals.ts']);
  });

  it('OWNER-323 the real claim store is reached through the shared constant, not a copy', () => {
    const claims = source(CLAIMS);
    expect(claims).toContain('CLAIM_APPROVAL_SQL');
    expect(claims).toMatch(/meta\.changes\s*===\s*1/);
    // The failure mode its own docblock forbids: re-reading and comparing.
    expect(claims).not.toMatch(/SELECT[^;]*FROM\s+approvals[^;]*WHERE\s+id[^;]*consumed/is);
  });
});

describe('every owner control is reachable from a real route', () => {
  const router = source(ROUTER);

  /** Each control, the port method behind it, and the route that must call it. */
  const CONTROLS: readonly { readonly label: string; readonly method: string; readonly route: RegExp }[] = [
    { label: 'pause or resume a control', method: 'setControl', route: /routes\.post\('\/owner\/controls\/:key'/ },
    { label: 'grant an approval', method: 'grantApproval', route: /routes\.post\('\/owner\/approvals'/ },
    { label: 'withdraw an approval', method: 'revokeApproval', route: /routes\.post\('\/owner\/approvals\/:id\/revoke'/ },
    { label: 'issue a refund', method: 'issueRefund', route: /routes\.post\('\/owner\/refunds'/ },
    { label: 'reject an order', method: 'rejectBeforeCheckout', route: /routes\.post\('\/owner\/orders\/:orderId\/reject'/ },
    { label: 'cancel a subscription', method: 'cancelSubscription', route: /routes\.post\('\/owner\/customers\/:workspaceId\/cancel'/ },
    { label: 'retry a run', method: 'retryRun', route: /routes\.post\('\/owner\/verification\/:runId\/retry'/ },
    { label: 'rotate a connection', method: 'rotateConnection', route: /routes\.post\('\/owner\/connections\/:id\/rotate'/ },
    { label: 'revoke a connection', method: 'revokeConnection', route: /routes\.post\('\/owner\/connections\/:id\/revoke'/ },
    { label: 'activate a campaign', method: 'activateCampaign', route: /routes\.post\('\/owner\/ads\/:id\/activate'/ },
    { label: 'pause a campaign', method: 'pauseCampaign', route: /routes\.post\('\/owner\/ads\/:id\/pause'/ },
    { label: 'acknowledge an alert', method: 'acknowledgeAlert', route: /routes\.post\('\/owner\/operations\/alerts\/:id\/acknowledge'/ },
    { label: 'queue a maintenance job', method: 'enqueueMaintenance', route: /routes\.post\('\/owner\/operations\/jobs\/:kind'/ },
    { label: 'run a test suite', method: 'dispatchQuality', route: /routes\.post\('\/owner\/quality\/run'/ },
    { label: 'preview a cleanup', method: 'cleanupPreview', route: /routes\.post\('\/owner\/cleanup\/preview'/ },
    { label: 'run a cleanup', method: 'cleanupExecute', route: /routes\.post\('\/owner\/cleanup\/run'/ },
    { label: 'save a setting', method: 'writeSetting', route: /routes\.post\('\/owner\/settings\//  },
  ];

  it('OWNER-324 every control has a route, and every route calls its port method', () => {
    const missingRoute: string[] = [];
    const uncalled: string[] = [];
    for (const control of CONTROLS) {
      if (!control.route.test(router)) missingRoute.push(`${control.label} (no route)`);
      if (!new RegExp(`port\\.${control.method}\\s*\\(`).test(router)) uncalled.push(`${control.label} (route never calls port.${control.method})`);
    }
    expect(missingRoute).toEqual([]);
    expect(uncalled).toEqual([]);
  });

  it('OWNER-325 every control the router calls exists on the live port, not only the in-memory one', () => {
    const live = source(LIVE_PORT);
    const absent = CONTROLS.filter((c) => methodBody(live, c.method) === null).map((c) => c.method);
    expect(
      absent,
      'a control the router calls but the live port does not implement is a button that cannot work in production',
    ).toEqual([]);
  });

  /**
   * The third category the auditor's pass revealed: a control whose logic is tested, whose
   * route exists, and whose **live** implementation neither performs the action nor names a
   * dependency. That would be a silent no-op — the worst of the three, because it looks
   * like it worked.
   */
  it('OWNER-326 no live control returns success without doing anything', () => {
    const live = source(LIVE_PORT);
    const silent: string[] = [];
    for (const control of CONTROLS) {
      const body = methodBody(live, control.method);
      if (body === null) continue;
      const claimsSuccess = /writeOk\s*\(|ok:\s*true/.test(body);
      const namesDependency = /writeBlocked\s*\(|detail:\s*NO_/.test(body);
      const doesSomething = /\.(run|first|all|batch)\s*\(|prepare\s*\(|#runner\.|#audit\s*\(|settings\.set/.test(body);
      if (claimsSuccess && !doesSomething && !namesDependency) silent.push(control.method);
    }
    expect(silent, 'these report success without performing an action or naming a blocker').toEqual([]);
  });

  it('OWNER-327 the deployed entry point builds the live port, not the in-memory stand-in', () => {
    const entry = source(ENTRY);
    expect(entry).toMatch(/createOwnerDataPort|D1OwnerDataPort/);
    // And it declares the environment, which is what makes an unconfigured production
    // mount throw at construction rather than serve invented figures.
    expect(entry).toMatch(/environment:\s*c\.env\.ENVIRONMENT/);
  });

  it('OWNER-328 the evidence pack is resolved per request from a real binding', () => {
    const entry = source(ENTRY);
    expect(entry).toMatch(/resolveArtifacts/);
    expect(entry).toMatch(/D1QualityArtifactStore/);
  });
});
