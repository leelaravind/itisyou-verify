import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const alias = {
  // Subpath aliases come FIRST. Vite matches a string alias as a prefix, so the bare
  // '@verify/connectors' entry below would otherwise rewrite '@verify/connectors/stripe'
  // to '<…>/src/index.ts/stripe'. The package's own `exports` map resolves that subpath at
  // build time; the alias has to resolve it in tests. Without this, importing the Worker
  // entry point (apps/app/src/index.ts) — which is the only honest way to test what a
  // visitor actually sees — fails to load at all.
  '@verify/connectors/stripe': r('./packages/connectors/src/stripe.ts'),
  '@verify/contracts': r('./packages/contracts/src/index.ts'),
  '@verify/domain': r('./packages/domain/src/index.ts'),
  '@verify/security': r('./packages/security/src/index.ts'),
  '@verify/connectors': r('./packages/connectors/src/index.ts'),
  '@verify/ui': r('./packages/ui/src/index.ts'),
  '@app': r('./apps/app/src'),
};

/**
 * Shared per-project settings. `setupFiles` blocks outbound fetch, so a unit or
 * integration test can never quietly reach a real provider.
 */
const shared = {
  globals: false,
  environment: 'node' as const,
  setupFiles: [r('./tests/setup.ts')],
  testTimeout: 15_000,
  hookTimeout: 20_000,
};

export default defineConfig({
  resolve: { alias },
  test: {
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './reports/junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: './reports/coverage',
      include: ['packages/*/src/**/*.ts', 'apps/app/src/**/*.ts'],
    },
    ...shared,
    // A single project. Installed vitest is 3.2.7 (package.json pins `^3.2.6`, bumped
    // from `~3.0.9` in 605509e), so `test.projects` (3.2+) is available here if it's
    // ever wanted. `pnpm test:unit` / `test:integration` / `test:security` still select
    // by path rather than by a named project — that's a simplicity choice now, not a
    // version constraint, so don't reintroduce `test.projects` without also updating
    // these path-based scripts and scripts/run-tests.mjs's INCLUDE_DIRS to match.
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/security/**/*.test.ts',
    ],
  },
});
