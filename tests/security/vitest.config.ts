/**
 * Vitest configuration for the A10 security-regression suite.
 *
 * WHY THIS FILE EXISTS: the repository-root `vitest.config.ts` restricts `include` to
 * `tests/unit/**` and `tests/integration/**`, so `tests/security/**` is invisible to
 * `pnpm test` and to `npx vitest run tests/security`. Until the lead adds
 * `'tests/security/**\/*.test.ts'` to the root `include` array, the security suite must
 * be run explicitly:
 *
 *     npx vitest run --config tests/security/vitest.config.ts
 *
 * A security suite that CI never executes is not a control. Adding the glob to the root
 * config is security-acceptance item SEC-ACC-01 and is blocking for launch.
 */
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
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
    include: ['tests/security/**/*.test.ts'],
    setupFiles: [r('../setup.ts')],
    testTimeout: 15_000,
    hookTimeout: 20_000,
  },
});
