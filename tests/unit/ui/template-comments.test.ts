/**
 * CUST-390 — no backtick inside an HTML comment in a rendered template.
 *
 * ## Why this test exists
 *
 * Every page in this app is built from `html` tagged template literals, and the team writes
 * long explanatory notes inside them as HTML comments — a good habit, and the reason the
 * rationale for a control sits next to the control. The habit has one fatal interaction with
 * the medium: a backtick used for markdown emphasis inside such a comment **closes the
 * template literal**. Everything after it is parsed as expressions, and the file stops being
 * valid TypeScript.
 *
 * The failure is not local. `apps/app/src/routes/app/authPages.ts` and
 * `.../onboardingPages.ts` each carried one, and the symptom was that
 * `apps/app/src/index.ts` — the Worker entry point, and therefore *every* integration test
 * that asserts what a visitor is actually served — failed to transform at all:
 *
 *     ERROR: Expected ";" but found "GET"
 *
 * Not one test failed with a useful message; the whole suite reported "no tests". A build
 * break that presents as an empty test run is the worst shape a regression can take, because
 * a green-looking summary is one careless glance away.
 *
 * `tsc` and `esbuild` both catch it, but only once something imports the file — and this
 * repository's habit of running targeted test files means the broken module can sit
 * untouched for a while. This test reads the source directly, so it fails with the file, the
 * line and the reason, rather than with a parser error a hundred frames away.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['apps/app/src', 'packages/ui/src'].map((relative) =>
  fileURLToPath(new URL(`../../../${relative}/`, import.meta.url)),
);

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * Offending lines, as `path:line`.
 *
 * Deliberately a simple scanner rather than a parser: it walks HTML comments, which only
 * ever appear inside a rendered template in this codebase, and reports any backtick found
 * between `<!--` and `-->`. That is exactly the hazard and nothing else, so it has no
 * opinion about backticks in JSDoc, in `//` comments or in ordinary template text.
 */
function backticksInHtmlComments(file: string): readonly string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const hits: string[] = [];
  let inComment = false;
  lines.forEach((line, index) => {
    let rest = line;
    while (rest.length > 0) {
      if (!inComment) {
        const open = rest.indexOf('<!--');
        if (open === -1) return;
        rest = rest.slice(open + 4);
        inComment = true;
        continue;
      }
      const close = rest.indexOf('-->');
      const body = close === -1 ? rest : rest.slice(0, close);
      if (body.includes('`')) hits.push(`${file}:${String(index + 1)}`);
      if (close === -1) return;
      rest = rest.slice(close + 3);
      inComment = false;
    }
  });
  return hits;
}

describe('rendered templates stay parseable', () => {
  it('CUST-390 no HTML comment inside a template literal contains a backtick', () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(root)).flatMap((file) =>
      backticksInHtmlComments(file),
    );

    expect(
      offenders,
      'A backtick in an HTML comment closes the html`` template it sits in. The file stops ' +
        'compiling, apps/app/src/index.ts fails to transform, and every integration test ' +
        'reports "no tests" rather than a failure. Use plain words or quotes instead.',
    ).toEqual([]);
  });
});
