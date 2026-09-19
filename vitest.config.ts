import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@verify/contracts': r('./packages/contracts/src/index.ts'),
      '@verify/domain': r('./packages/domain/src/index.ts'),
      '@verify/security': r('./packages/security/src/index.ts'),
      '@verify/connectors': r('./packages/connectors/src/index.ts'),
      '@verify/ui': r('./packages/ui/src/index.ts'),
      '@app': r('./apps/app/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: './reports/junit.xml' },
    coverage: {
      provider: 'v8',
      reportsDirectory: './reports/coverage',
      include: ['packages/*/src/**/*.ts', 'apps/app/src/**/*.ts'],
    },
    // Tests must never reach a real provider. Any accidental fetch fails loudly.
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
