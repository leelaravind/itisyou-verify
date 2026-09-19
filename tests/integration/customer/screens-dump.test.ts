/**
 * Not a test — a one-off dump of the exact bytes the Worker serves for each authenticated
 * customer screen, so they can be opened in a browser and screenshotted at real viewports.
 * Delete after use.
 */
import { describe, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSignedIn, seedRunsFor, signedInWorkspace } from './harness.js';

const OUT = process.env['SHOT_DIR'] ?? '';

describe('dump', () => {
  it('writes each customer screen', async () => {
    if (OUT === '') return;
    mkdirSync(OUT, { recursive: true });

    const empty = await signedInWorkspace();
    for (const [name, path] of [
      ['app-empty', '/app'],
      ['app-connections', '/app/connections'],
      ['app-runs-empty', '/app/runs'],
      ['app-signin', '/app/sign-in'],
      ['app-onboarding-connect', '/app/onboarding/connect'],
      ['app-onboarding-compatibility', '/app/onboarding/compatibility'],
      ['app-run-notfound', '/app/runs/nope'],
      ['app-support', '/app/support'],
      ['app-cancel', '/app/cancel'],
    ] as const) {
      const { html } = await getSignedIn(empty, path);
      writeFileSync(join(OUT, `${name}.html`), html, 'utf8');
    }
    empty.h.close();

    const pending = await signedInWorkspace();
    seedRunsFor(pending, [
      { id: 'run_p1', status: 'PENDING' },
      { id: 'run_p2', status: 'PENDING' },
    ]);
    writeFileSync(join(OUT, 'app-pending.html'), (await getSignedIn(pending, '/app')).html, 'utf8');
    pending.h.close();

    const used = await signedInWorkspace({ consumed: 499, runLimit: 500 });
    seedRunsFor(used, [
      { id: 'run_v1', status: 'VERIFIED' },
      { id: 'run_f1', status: 'FAILED' },
      { id: 'run_u1', status: 'UNVERIFIED' },
      { id: 'run_p3', status: 'PENDING' },
    ]);
    writeFileSync(join(OUT, 'app-usage.html'), (await getSignedIn(used, '/app/usage')).html, 'utf8');
    writeFileSync(join(OUT, 'app-mixed.html'), (await getSignedIn(used, '/app')).html, 'utf8');
    writeFileSync(join(OUT, 'app-runs.html'), (await getSignedIn(used, '/app/runs')).html, 'utf8');
    used.h.close();
  });
});
