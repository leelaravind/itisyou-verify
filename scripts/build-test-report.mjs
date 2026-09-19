#!/usr/bin/env node
/**
 * Build the release evidence pack from a real test run.
 *
 *   node scripts/build-test-report.mjs
 *
 * It runs the suite with vitest's JSON reporter and turns the machine output into:
 *
 *   reports/test-results.json      stable case ids, outcomes, timings, environment
 *   reports/junit.xml              interoperable output
 *   reports/test-report.md         human QA report
 *   reports/test-report.html       the page the owner dashboard serves
 *   reports/release-readiness.md   the release decision, blockers and risks
 *
 * Everything below is derived from the runner's own output. Nothing is estimated,
 * and a case that did not execute is never counted as passing evidence.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const OUT = 'reports';
mkdirSync(OUT, { recursive: true });

const CATEGORY_BY_PREFIX = {
  VERIFY: 'Verification logic and evidence semantics',
  CONN: 'Connector contracts and provider failures',
  PERSIST: 'Persistence, queues, idempotency and concurrency',
  AUTH: 'Authentication, roles and tenant isolation',
  BILL: 'Checkout, subscription, orders and refunds',
  CUST: 'Customer lifecycle and interface',
  OWNER: 'Owner panel, approvals, quality and cleanup',
  API: 'API validation, application security and privacy',
  SEC: 'Security regression',
  BUDGET: 'Budgets, optional models and maintenance',
  ADS: 'Advertising and analytics',
  RESIL: 'Accessibility, resilience, performance and deployment',
  DOC: 'Development stories, content and release hygiene',
};

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return null;
  }
}

const meta = {
  generated_at: new Date().toISOString(),
  commit_sha: sh('git', ['rev-parse', 'HEAD']),
  branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
  tree_clean: sh('git', ['status', '--porcelain']) === '',
  node: process.version,
  vitest: JSON.parse(readFileSync('package.json', 'utf8')).devDependencies?.vitest ?? null,
  schema_version: 1,
  fixture_source: 'tests/fixtures (synthetic only)',
};

console.log('build-test-report — running the suite with the JSON reporter…');
const jsonPath = `${OUT}/vitest-raw.json`;
try {
  execFileSync(
    'npx',
    [
      'vitest',
      'run',
      '--reporter=json',
      '--reporter=junit',
      `--outputFile.json=${jsonPath}`,
      `--outputFile.junit=${OUT}/junit.xml`,
    ],
    {
      stdio: ['ignore', 'ignore', 'inherit'],
      shell: process.platform === 'win32',
      env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
    },
  );
} catch {
  // A failing suite is a legitimate outcome to report. Carry on and record it.
  console.log('build-test-report — the suite reported failures; they will appear in the report.');
}

if (!existsSync(jsonPath)) {
  console.error(
    `build-test-report — ${jsonPath} was not produced. Cannot build a report from nothing.`,
  );
  process.exit(1);
}

const raw = JSON.parse(readFileSync(jsonPath, 'utf8'));

/** One entry per assertion result, keyed by the stable case id in its title. */
const cases = [];
const unidentified = [];
for (const file of raw.testResults ?? []) {
  for (const a of file.assertionResults ?? []) {
    const title = a.fullName ?? a.title ?? '';
    const m = /\b([A-Z]+)-(\d{3,4})\b/.exec(title);
    const entry = {
      id: m ? `${m[1]}-${m[2]}` : null,
      prefix: m ? m[1] : null,
      title: a.title,
      suite: (a.ancestorTitles ?? []).join(' › '),
      file: file.name?.replace(/\\/g, '/').replace(process.cwd().replace(/\\/g, '/') + '/', ''),
      status: a.status,
      duration_ms: a.duration ?? null,
      failure: a.status === 'failed' ? (a.failureMessages ?? []).join('\n').slice(0, 2000) : null,
    };
    if (entry.id) cases.push(entry);
    else unidentified.push(entry);
  }
}

/** Distinct case ids. A case counts once however many times it ran. */
const byId = new Map();
for (const c of cases) {
  const prev = byId.get(c.id);
  // If a case id appears more than once, the worst outcome wins.
  if (!prev || (prev.status === 'passed' && c.status !== 'passed')) byId.set(c.id, c);
}
const distinct = [...byId.values()];

const counts = {
  distinct_cases: distinct.length,
  executions: cases.length + unidentified.length,
  passed: distinct.filter((c) => c.status === 'passed').length,
  failed: distinct.filter((c) => c.status === 'failed').length,
  skipped: distinct.filter((c) => c.status !== 'passed' && c.status !== 'failed').length,
  unidentified_executions: unidentified.length,
  duplicate_ids: cases.length - distinct.length,
};

const byCategory = {};
for (const c of distinct) {
  const cat = CATEGORY_BY_PREFIX[c.prefix] ?? `Unmapped prefix: ${c.prefix}`;
  byCategory[cat] ??= { total: 0, passed: 0, failed: 0, skipped: 0 };
  byCategory[cat].total++;
  if (c.status === 'passed') byCategory[cat].passed++;
  else if (c.status === 'failed') byCategory[cat].failed++;
  else byCategory[cat].skipped++;
}

const failures = distinct.filter((c) => c.status === 'failed');
const GATE = 500;
const gateMet = counts.passed >= GATE && counts.failed === 0;

// ---------- test-results.json ----------
writeFileSync(
  `${OUT}/test-results.json`,
  JSON.stringify({ meta, counts, by_category: byCategory, cases: distinct }, null, 2),
);

// ---------- test-report.md ----------
const md = [];
md.push('# ITISYOU Verify — test report\n');
md.push(
  `Generated ${meta.generated_at} from commit \`${meta.commit_sha?.slice(0, 12) ?? 'unknown'}\` on \`${meta.branch}\`.`,
);
md.push(
  `Working tree ${meta.tree_clean ? 'clean' : '**dirty — this report does not correspond to a reproducible commit**'}. Node ${meta.node}, vitest ${meta.vitest}.\n`,
);
md.push('## Summary\n');
md.push('| Measure | Value |');
md.push('| --- | ---: |');
md.push(`| Distinct cases executed | ${counts.distinct_cases} |`);
md.push(`| Passed | ${counts.passed} |`);
md.push(`| Failed | ${counts.failed} |`);
md.push(`| Skipped / other | ${counts.skipped} |`);
md.push(`| Total executions | ${counts.executions} |`);
md.push(`| Executions with no case id | ${counts.unidentified_executions} |`);
md.push(
  `| Release gate (${GATE} distinct passing, zero failures) | ${gateMet ? 'MET' : 'NOT MET'} |`,
);
md.push('');
md.push('## Coverage by category\n');
md.push('| Category | Cases | Passed | Failed | Skipped |');
md.push('| --- | ---: | ---: | ---: | ---: |');
for (const [cat, n] of Object.entries(byCategory).sort()) {
  md.push(`| ${cat} | ${n.total} | ${n.passed} | ${n.failed} | ${n.skipped} |`);
}
md.push('');
if (failures.length) {
  md.push('## Failures\n');
  for (const f of failures) {
    md.push(`### ${f.id} — ${f.title}\n`);
    md.push(`**File:** \`${f.file}\`  \n**Suite:** ${f.suite}\n`);
    md.push('```');
    md.push((f.failure ?? '').split('\n').slice(0, 12).join('\n'));
    md.push('```\n');
  }
} else {
  md.push('## Failures\n\nNone in this run.\n');
}
md.push('## What this report does not prove\n');
md.push(
  '- **Mocked providers are not a working integration.** Connector cases stub HTTP responses captured from vendor documentation. They prove our handling of a shape, not that the provider behaves that way today.',
);
md.push(
  '- **Emulated viewports are not physical devices.** Browser cases run in a headless engine at set widths.',
);
md.push(
  '- **Integration cases run against SQLite, not D1 over the network.** The SQL, the transactions and the idempotency guards are real; Cloudflare network behaviour, replicas and true parallelism are not exercised.',
);
md.push(
  '- **A passing suite says nothing about demand.** Test totals are a coverage measure, not evidence of a market.',
);
md.push(
  '- A case that was skipped, quarantined or never executed is not counted toward the gate.\n',
);
writeFileSync(`${OUT}/test-report.md`, md.join('\n'));

// ---------- release-readiness.md ----------
const rr = [];
rr.push('# Release readiness\n');
rr.push(`Commit \`${meta.commit_sha?.slice(0, 12) ?? 'unknown'}\` · ${meta.generated_at}\n`);
rr.push(
  `**Decision: ${gateMet ? 'the automated gate is met' : 'NOT READY — the automated gate is not met'}.**\n`,
);
rr.push('| Gate | Required | Actual | Result |');
rr.push('| --- | --- | --- | --- |');
rr.push(
  `| Distinct passing cases | ≥ ${GATE} | ${counts.passed} | ${counts.passed >= GATE ? 'pass' : 'FAIL'} |`,
);
rr.push(`| Failed cases | 0 | ${counts.failed} | ${counts.failed === 0 ? 'pass' : 'FAIL'} |`);
rr.push(
  `| Reproducible commit | clean tree | ${meta.tree_clean ? 'clean' : 'dirty'} | ${meta.tree_clean ? 'pass' : 'FAIL'} |`,
);
rr.push('');
rr.push('## Blockers\n');
if (failures.length === 0 && gateMet) {
  rr.push(
    'No automated blockers in this run. External dependencies are listed below and are not covered by the suite.\n',
  );
} else {
  for (const f of failures) rr.push(`- \`${f.id}\` — ${f.title}`);
  if (counts.passed < GATE)
    rr.push(`- Distinct passing cases (${counts.passed}) below the required ${GATE}.`);
  rr.push('');
}
rr.push('## External dependencies no test can clear\n');
rr.push(
  "- Live payment processing requires the owner's verified business details and Stripe approval.",
);
rr.push(
  '- Provider-backed evidence requires real HubSpot and Resend credentials; until then the connector path is proven only against mocks.',
);
rr.push(
  "- Advertising requires an approved account, billing and the owner's approval of a specific campaign packet.\n",
);
rr.push('## Rollback readiness\n');
rr.push('- Cloudflare retains the previous Worker version; `wrangler rollback` restores it.');
rr.push(
  '- Migration `0001` is additive. A code rollback does not reverse a schema change, and `scripts/migrate.mjs` refuses a destructive production migration without an explicit flag.\n',
);
writeFileSync(`${OUT}/release-readiness.md`, rr.join('\n'));

// ---------- test-report.html ----------
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const html = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ITISYOU Verify — test report</title>
<style>
:root{color-scheme:light dark;--bg:#fbfaf8;--fg:#1a1a18;--muted:#5c5a54;--line:#e3e0d8;--ok:#1f5f4f;--bad:#8c2f2f;--warn:#8a6a1f}
@media(prefers-color-scheme:dark){:root{--bg:#14140f;--fg:#f2f0ea;--muted:#a5a29a;--line:#2e2d27;--ok:#7fd1b9;--bad:#e08585;--warn:#d9bb6a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,"Segoe UI",Roboto,sans-serif}
main{max-width:64rem;margin:0 auto;padding:2.5rem 1.25rem 5rem}
h1{font-size:1.75rem;letter-spacing:-.02em;margin:0 0 .25rem}
.meta{color:var(--muted);font-size:.875rem;margin:0 0 2rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin-bottom:2rem}
.card{border:1px solid var(--line);border-radius:10px;padding:.875rem 1rem}
.card .n{font-size:1.5rem;font-weight:650;letter-spacing:-.02em}
.card .l{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.gate{border:1px solid var(--line);border-left:4px solid var(--${gateMet ? 'ok' : 'bad'});border-radius:8px;padding:1rem 1.25rem;margin-bottom:2rem}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;font-size:.875rem;min-width:34rem}
th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid var(--line)}
th{font-weight:600;color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.06em}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
details{border:1px solid var(--line);border-radius:8px;padding:.75rem 1rem;margin-bottom:.5rem}
summary{cursor:pointer;font-weight:600}
pre{overflow-x:auto;background:color-mix(in srgb,var(--fg) 5%,transparent);padding:.75rem;border-radius:6px;font-size:.8125rem}
.caveat{border-top:1px solid var(--line);margin-top:2.5rem;padding-top:1.25rem;color:var(--muted);font-size:.875rem}
</style></head><body><main>
<h1>Test report</h1>
<p class="meta">Commit <code>${esc(meta.commit_sha?.slice(0, 12))}</code> on <code>${esc(meta.branch)}</code> · ${esc(meta.generated_at)} · Node ${esc(meta.node)} · vitest ${esc(meta.vitest)}${meta.tree_clean ? '' : ' · <strong class="warn">working tree dirty</strong>'}</p>
<div class="gate"><strong class="${gateMet ? 'ok' : 'bad'}">Release gate ${gateMet ? 'met' : 'not met'}</strong> — requires ${GATE} distinct passing cases and zero failures. Actual: ${counts.passed} passing, ${counts.failed} failing.</div>
<div class="cards">
<div class="card"><div class="n">${counts.distinct_cases}</div><div class="l">Distinct cases</div></div>
<div class="card"><div class="n ok">${counts.passed}</div><div class="l">Passed</div></div>
<div class="card"><div class="n ${counts.failed ? 'bad' : ''}">${counts.failed}</div><div class="l">Failed</div></div>
<div class="card"><div class="n ${counts.skipped ? 'warn' : ''}">${counts.skipped}</div><div class="l">Skipped</div></div>
<div class="card"><div class="n">${counts.executions}</div><div class="l">Executions</div></div>
</div>
<h2>Coverage by category</h2>
<div class="scroll"><table><thead><tr><th>Category</th><th class="n">Cases</th><th class="n">Passed</th><th class="n">Failed</th><th class="n">Skipped</th></tr></thead><tbody>
${Object.entries(byCategory)
  .sort()
  .map(
    ([c, n]) =>
      `<tr><td>${esc(c)}</td><td class="n">${n.total}</td><td class="n ok">${n.passed}</td><td class="n ${n.failed ? 'bad' : ''}">${n.failed}</td><td class="n">${n.skipped}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>
<h2>Failures</h2>
${failures.length === 0 ? '<p>None in this run.</p>' : failures.map((f) => `<details><summary><span class="bad">${esc(f.id)}</span> — ${esc(f.title)}</summary><p><code>${esc(f.file)}</code></p><pre>${esc((f.failure ?? '').split('\n').slice(0, 12).join('\n'))}</pre></details>`).join('\n')}
<div class="caveat"><p><strong>What this does not prove.</strong> Mocked providers are not a working integration. Emulated viewports are not physical devices. Integration cases run against SQLite rather than D1 over the network, so the SQL and the idempotency guards are real but Cloudflare's network behaviour is not exercised. A passing suite says nothing about demand. Skipped and quarantined cases are excluded from the gate.</p></div>
</main></body></html>`;
writeFileSync(`${OUT}/test-report.html`, html);

console.log(
  `\nbuild-test-report — wrote ${OUT}/test-results.json, test-report.md, test-report.html, release-readiness.md, junit.xml`,
);
console.log(
  `  ${counts.distinct_cases} distinct cases · ${counts.passed} passed · ${counts.failed} failed · ${counts.skipped} skipped`,
);
console.log(`  release gate (${GATE} passing, 0 failing): ${gateMet ? 'MET' : 'NOT MET'}`);
if (counts.duplicate_ids > 0)
  console.log(`  note: ${counts.duplicate_ids} execution(s) reused an existing case id`);
if (counts.unidentified_executions > 0)
  console.log(
    `  note: ${counts.unidentified_executions} execution(s) carry no case id and are not counted`,
  );
process.exit(0);
