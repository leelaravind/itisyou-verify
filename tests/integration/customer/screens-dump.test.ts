/**
 * Not a test of behaviour — a dump of the exact bytes the Worker serves for each customer
 * screen and state, so they can be rendered in a real browser at real viewports and
 * screenshotted for `docs/screenshots/`.
 *
 * It exists because the authenticated screens cannot be reached by the Playwright suite
 * until the seeded identity has a workspace, and because several states (a database
 * outage, a run with a mixed comparator, an allowance one run from full) are easier to
 * seed here than through a running Worker. Skipped, visibly, unless `SHOT_DIR` is set —
 * a case with no assertion must never read as a pass in a summary.
 *
 *   SHOT_DIR=<dir> node scripts/run-tests.mjs tests/integration/customer/screens-dump.test.ts
 */
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getAnonymous,
  getSignedIn,
  getSignedInAgainst,
  postSignedIn,
  seedAssertionsFor,
  seedRunsFor,
  signedInWorkspace,
  unreachableDb,
} from './harness.js';

const OUT = process.env['SHOT_DIR'] ?? '';

describe('screen dump for the screenshot pass', () => {
  it.skipIf(OUT === '')('writes each customer screen and state as served', async () => {
    mkdirSync(OUT, { recursive: true });
    const write = (name: string, html: string): void =>
      writeFileSync(join(OUT, `${name}.html`), html, 'utf8');

    const empty = await signedInWorkspace();
    for (const [name, path] of [
      ['app-empty', '/app'],
      ['app-connections', '/app/connections'],
      ['app-runs-empty', '/app/runs'],
      ['app-onboarding-connect', '/app/onboarding/connect'],
      ['app-onboarding-compatibility', '/app/onboarding/compatibility'],
      ['app-onboarding-mapping', '/app/onboarding/mapping'],
      ['app-onboarding-outcome', '/app/onboarding/outcome'],
      ['app-onboarding-proof', '/app/onboarding/proof'],
      ['app-onboarding-review', '/app/onboarding/review'],
      ['app-onboarding-activation', '/app/onboarding/activation'],
      ['app-billing', '/app/billing'],
      ['app-run-notfound', '/app/runs/nope'],
      ['app-support', '/app/support'],
      ['app-cancel', '/app/cancel'],
    ] as const) {
      write(name, (await getSignedIn(empty, path)).html);
    }
    // The proof step with a result on it: the POST that runs the proof answers the page
    // directly, so this is the served state after pressing "Run the proof".
    write('app-onboarding-proof-result', (await postSignedIn(empty, '/app/onboarding/proof', {})).html);
    // Sign-in is a signed-out page: with a session it answers 303 and an empty body.
    write('app-signin', (await getAnonymous(empty, '/app/sign-in')).html);
    // The permission-denied state: a signed-out request for a signed-in page.
    write('app-signed-out-401', (await getAnonymous(empty, '/app/runs')).html);
    // The failure state: the same request, against a database that fails at execution.
    write('app-failure', (await getSignedInAgainst(unreachableDb(), '/app/runs')).html);
    empty.h.close();

    const pending = await signedInWorkspace();
    seedRunsFor(pending, [
      { id: 'run_p1', status: 'PENDING' },
      { id: 'run_p2', status: 'PENDING' },
    ]);
    write('app-pending', (await getSignedIn(pending, '/app')).html);
    pending.h.close();

    const used = await signedInWorkspace({ consumed: 499, runLimit: 500 });
    seedRunsFor(used, [
      { id: 'run_v1', status: 'VERIFIED' },
      { id: 'run_f1', status: 'FAILED' },
      { id: 'run_u1', status: 'UNVERIFIED' },
      { id: 'run_p3', status: 'PENDING' },
    ]);
    seedAssertionsFor(used, 'run_u1', [
      {
        ruleId: 'r1_crm',
        label: 'A CRM record was created',
        status: 'SUPPORTED',
        reasonCode: 'MATCHED',
        expected: 'a contact carrying enq_0000000000000001',
        observed: 'contact crm-rec-1 carrying enq_0000000000000001',
      },
      {
        ruleId: 'r2_corr',
        label: 'The CRM record carries this enquiry reference',
        status: 'SUPPORTED',
        reasonCode: 'MATCHED',
        expected: 'verify_correlation_id = enq_0000000000000001',
        observed: 'verify_correlation_id = enq_0000000000000001',
      },
      {
        ruleId: 'r3_email',
        label: 'The acknowledgement email was delivered',
        status: 'UNKNOWN',
        reasonCode: 'CONNECTION_UNAVAILABLE',
        expected: 'a delivered event for a**@example.test',
        observed: null,
      },
      {
        ruleId: 'r4_recipient',
        label: 'The acknowledgement went to the address the enquiry named',
        status: 'UNKNOWN',
        reasonCode: 'CONNECTION_UNAVAILABLE',
        expected: 'a**@example.test',
        observed: null,
      },
    ]);
    seedAssertionsFor(used, 'run_f1', [
      {
        ruleId: 'r1_crm',
        label: 'A CRM record was created',
        status: 'SUPPORTED',
        reasonCode: 'MATCHED',
        expected: 'a contact carrying enq_0000000000000002',
        observed: 'contact crm-rec-2 carrying enq_0000000000000002',
      },
      {
        ruleId: 'r3_email',
        label: 'The acknowledgement email was delivered',
        status: 'CONTRADICTED',
        reasonCode: 'STATUS_NOT_REACHED',
        expected: 'status delivered for b**@example.test',
        observed: 'status bounced for b**@example.test',
      },
    ]);
    write('app-usage', (await getSignedIn(used, '/app/usage')).html);
    write('app-mixed', (await getSignedIn(used, '/app')).html);
    write('app-runs', (await getSignedIn(used, '/app/runs')).html);
    write('app-run-unverified', (await getSignedIn(used, '/app/runs/run_u1')).html);
    write('app-run-failed', (await getSignedIn(used, '/app/runs/run_f1')).html);
    used.h.close();
  });
});
