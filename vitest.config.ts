import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const alias = {
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
    // A single project. `pnpm test:unit` / `test:integration` / `test:security`
    // select by path rather than by a named project, which keeps this working on
    // the installed vitest 3.0.x where `test.projects` does not exist.
    include: [
      'tests/unit/**/*.test.ts',
      'tests/integration/**/*.test.ts',
      'tests/security/**/*.test.ts',
    ],
  },
});
