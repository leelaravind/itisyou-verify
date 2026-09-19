/**
 * A vitest config for ONE thing: driving the real `/app/onboarding/connect` route against
 * a real provider, once, by hand.
 *
 * It is deliberately NOT `vitest.config.ts` and its include pattern is deliberately NOT
 * `tests/**`. The suite's own setup file blocks every outbound fetch with an empty host
 * allowlist, and that guard must stay exactly as it is — a provider call should never be
 * reachable from `pnpm test` by accident. Contacting HubSpot therefore requires choosing
 * this config explicitly on the command line, which is the visible act the connector
 * documentation asks for.
 *
 *   node scripts/run-tests.mjs --config tools/live-connect/vitest.live.config.ts   # refuses
 *   VERIFY_PROVIDER_PROOF=1 VERIFY_PROVIDER_ACCOUNT_KIND=test \
 *     npx vitest run --config tools/live-connect/vitest.live.config.ts            # runs
 *
 * Without both environment variables the case skips: holding a credential is not consent
 * to spend it.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@verify/connectors/stripe': r('../../packages/connectors/src/stripe.ts'),
      '@verify/contracts': r('../../packages/contracts/src/index.ts'),
      '@verify/domain': r('../../packages/domain/src/index.ts'),
      '@verify/security': r('../../packages/security/src/index.ts'),
      '@verify/connectors': r('../../packages/connectors/src/index.ts'),
      '@verify/ui': r('../../packages/ui/src/index.ts'),
      '@app': r('../../apps/app/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // No setupFiles on purpose: this is the one place outbound fetch is allowed, and the
    // guard in tests/setup.ts stays untouched for everything else.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['tools/live-connect/live-connect.test.ts'],
  },
});
