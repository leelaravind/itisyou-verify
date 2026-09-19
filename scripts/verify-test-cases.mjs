#!/usr/bin/env node
/**
 * verify-test-cases.mjs — integrity checker for the release test ledger.
 *
 * Reads docs/test-cases.json, proves the count is real rather than inflated, and
 * reconciles the plan against the test files that actually exist.
 *
 * Exits 1 on any integrity failure. Node built-ins only; no dependencies.
 *
 * Usage:
 *   node scripts/verify-test-cases.mjs            # check and reconcile
 *   node scripts/verify-test-cases.mjs --strict   # release gate: reconciliation defects also fail
 *   node scripts/verify-test-cases.mjs --quiet    # failures only
 *   node scripts/verify-test-cases.mjs --json     # machine-readable summary
 *
 * Exit codes:
 *   0  the ledger is internally honest (and, under --strict, agrees with the test tree)
 *   1  a ledger integrity rule is broken, or --strict and the test tree disagrees
 *
 * A ledger integrity failure is always fatal. A reconciliation defect — a test title using
 * a prefix outside the allowlist, a case id that no designed case corresponds to — is
 * reported by default and fatal under --strict, because it is somebody else's file to fix.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const LEDGER_PATH = join(ROOT, 'docs', 'test-cases.json');
const TESTS_DIR = join(ROOT, 'tests');

const ARGS = new Set(process.argv.slice(2));
const QUIET = ARGS.has('--quiet');
const AS_JSON = ARGS.has('--json');
const STRICT = ARGS.has('--strict');

// ---------------------------------------------------------------------------
// The frozen expectations. These mirror docs/agent-brief.md and docs/test-plan.md.
// Changing a minimum here is a change to the launch gate, not a tidy-up.
// ---------------------------------------------------------------------------

const TOTAL_MINIMUM = 500;

/** id prefix -> category. The prefix allowlist is the one in docs/agent-brief.md. */
const PREFIX_CATEGORY = {
  VERIFY: 'verification_logic',
  CONN: 'connector_contracts',
  PERSIST: 'persistence_concurrency',
  AUTH: 'auth_tenancy',
  BILL: 'commerce',
  CUST: 'customer_lifecycle',
  OWNER: 'owner_panel',
  API: 'api_security_privacy',
  BUDGET: 'budgets_models_maintenance',
  ADS: 'advertising_analytics',
  RESIL: 'accessibility_resilience',
  DOC: 'stories_release_hygiene',
  // Lead ruling 2026-09-19: A10's independent security regression suite gets its own
  // prefix rather than being renamed into API/AUTH. Its cases are real and counted.
  SEC: 'api_security_privacy',
};

const CATEGORY_MINIMUM = {
  verification_logic: 65,
  connector_contracts: 45,
  persistence_concurrency: 45,
  auth_tenancy: 55,
  commerce: 50,
  customer_lifecycle: 45,
  owner_panel: 45,
  api_security_privacy: 45,
  budgets_models_maintenance: 35,
  advertising_analytics: 25,
  accessibility_resilience: 30,
  stories_release_hygiene: 15,
};

const CATEGORY_ORDER = Object.keys(CATEGORY_MINIMUM);

const LEVELS = new Set(['unit', 'integration', 'e2e']);
const STATUSES = new Set(['planned', 'implemented', 'passing', 'failing', 'blocked', 'retired']);

const REQUIRED_FIELDS = [
  'id',
  'category',
  'level',
  'requirement',
  'risk',
  'setup',
  'expected',
  'owner_agent',
  'implementation_ref',
  'provider_backed',
  'status',
];

/** Non-empty text fields. A blank here is a case that was never really designed. */
const TEXT_FIELDS = ['requirement', 'risk', 'setup', 'expected', 'owner_agent', 'implementation_ref'];

/** Real-provider cases cost money and need authorisation. Keep the number tiny. */
const PROVIDER_BACKED_CAP = 6;

const ID_PATTERN = /^([A-Z]+)-(\d{3})$/;
/** A case id as it appears inside a test title. */
const ID_IN_TITLE = /\b([A-Z]+)-(\d{3})\b/g;

/**
 * Tokens that look like `PREFIX-NNN` but are not case ids — algorithm names, standards
 * references and status codes that legitimately appear in a test title.
 */
const NOT_A_CASE_PREFIX = new Set([
  'SHA', 'AES', 'RSA', 'HMAC', 'UTF', 'ISO', 'RFC', 'WCAG', 'HTTP', 'TLS', 'CVE', 'ECDSA', 'PBKDF',
]);

/** Cap on how many warnings of one kind are printed before they are summarised. */
const WARN_SAMPLE = 8;

// ---------------------------------------------------------------------------
// Failure collection. Every failure is specific enough to act on without reading
// this script.
// ---------------------------------------------------------------------------

const failures = []; // ledger integrity — always fatal
const defects = []; // reconciliation against the test tree — fatal under --strict
const warnings = [];
const fail = (where, message) => failures.push({ where, message });
const defect = (where, message) => defects.push({ where, message });
const warn = (where, message) => warnings.push({ where, message });

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

let ledger;
try {
  ledger = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
} catch (error) {
  console.error(`FATAL  docs/test-cases.json could not be read or parsed: ${error.message}`);
  process.exit(1);
}

if (ledger.schema_version !== 1) {
  fail('ledger', `schema_version must be 1, found ${JSON.stringify(ledger.schema_version)}`);
}
if (typeof ledger.generated_at !== 'string' || Number.isNaN(Date.parse(ledger.generated_at))) {
  fail('ledger', `generated_at must be an ISO-8601 timestamp, found ${JSON.stringify(ledger.generated_at)}`);
}
if (!Array.isArray(ledger.cases)) {
  console.error('FATAL  docs/test-cases.json has no `cases` array.');
  process.exit(1);
}

const cases = ledger.cases;

// ---------------------------------------------------------------------------
// Per-case structural checks
// ---------------------------------------------------------------------------

const seenIds = new Map(); // id -> first index
const seenPairs = new Map(); // fingerprint -> first id
const numbersByPrefix = new Map(); // prefix -> Set(number)

const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

for (let index = 0; index < cases.length; index += 1) {
  const c = cases[index];
  const at = `cases[${index}]`;

  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    fail(at, 'case is not an object');
    continue;
  }

  const label = typeof c.id === 'string' && c.id !== '' ? c.id : at;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(c, field)) {
      fail(label, `missing required field \`${field}\``);
    }
  }

  for (const field of TEXT_FIELDS) {
    const value = c[field];
    if (value !== undefined && (typeof value !== 'string' || value.trim() === '')) {
      fail(label, `\`${field}\` must be a non-empty string`);
    }
  }

  if (typeof c.provider_backed !== 'boolean') {
    fail(label, '`provider_backed` must be a boolean');
  }

  // --- id shape, prefix allowlist, duplicates, sequential numbering ---
  if (typeof c.id !== 'string') {
    fail(at, '`id` must be a string');
  } else {
    const match = ID_PATTERN.exec(c.id);
    if (match === null) {
      fail(c.id, 'malformed id: expected PREFIX-NNN with a three-digit zero-padded number');
    } else {
      const [, prefix, digits] = match;
      if (!Object.prototype.hasOwnProperty.call(PREFIX_CATEGORY, prefix)) {
        fail(c.id, `prefix \`${prefix}\` is outside the allowlist (${Object.keys(PREFIX_CATEGORY).join(', ')})`);
      } else if (c.category !== undefined && c.category !== PREFIX_CATEGORY[prefix]) {
        fail(
          c.id,
          `prefix \`${prefix}\` belongs to category \`${PREFIX_CATEGORY[prefix]}\` but the case declares \`${c.category}\``,
        );
      }
      if (!numbersByPrefix.has(prefix)) numbersByPrefix.set(prefix, new Set());
      numbersByPrefix.get(prefix).add(Number(digits));
    }

    if (seenIds.has(c.id)) {
      fail(c.id, `duplicate id, first seen at cases[${seenIds.get(c.id)}]`);
    } else {
      seenIds.set(c.id, index);
    }
  }

  // --- category, level, status vocabularies ---
  if (c.category !== undefined && !Object.prototype.hasOwnProperty.call(CATEGORY_MINIMUM, c.category)) {
    fail(label, `category \`${c.category}\` is outside the allowed set`);
  }
  if (c.level !== undefined && !LEVELS.has(c.level)) {
    fail(label, `level \`${c.level}\` is outside {${[...LEVELS].join(', ')}}`);
  }
  if (c.status !== undefined && !STATUSES.has(c.status)) {
    fail(label, `status \`${c.status}\` is outside {${[...STATUSES].join(', ')}}`);
  }

  // --- the padding detector ---
  if (typeof c.requirement === 'string' && typeof c.setup === 'string') {
    const fingerprint = `${norm(c.requirement)} ${norm(c.setup)}`;
    if (seenPairs.has(fingerprint)) {
      fail(
        label,
        `identical requirement + setup as ${seenPairs.get(fingerprint)} — these are one case, not two`,
      );
    } else {
      seenPairs.set(fingerprint, label);
    }
  }
}

// --- numbering within each prefix must be sequential from 001 ---
for (const [prefix, numbers] of [...numbersByPrefix].sort()) {
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) {
      fail(
        `${prefix}-*`,
        `numbering is not sequential from 001: expected ${String(i + 1).padStart(3, '0')}, found ${String(sorted[i]).padStart(3, '0')}`,
      );
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

const countByCategory = new Map(CATEGORY_ORDER.map((k) => [k, 0]));
const countByLevel = new Map([...LEVELS].map((k) => [k, 0]));
const levelByCategory = new Map(CATEGORY_ORDER.map((k) => [k, { unit: 0, integration: 0, e2e: 0 }]));
const statusCounts = new Map();
let providerBacked = 0;

for (const c of cases) {
  if (countByCategory.has(c.category)) countByCategory.set(c.category, countByCategory.get(c.category) + 1);
  if (countByLevel.has(c.level)) countByLevel.set(c.level, countByLevel.get(c.level) + 1);
  if (levelByCategory.has(c.category) && LEVELS.has(c.level)) levelByCategory.get(c.category)[c.level] += 1;
  statusCounts.set(c.status, (statusCounts.get(c.status) ?? 0) + 1);
  if (c.provider_backed === true) providerBacked += 1;
}

for (const category of CATEGORY_ORDER) {
  const actual = countByCategory.get(category);
  const minimum = CATEGORY_MINIMUM[category];
  if (actual < minimum) {
    fail('counts', `category \`${category}\` has ${actual} cases, below its minimum of ${minimum} (short by ${minimum - actual})`);
  }
}

if (cases.length < TOTAL_MINIMUM) {
  fail('counts', `ledger holds ${cases.length} cases, below the launch minimum of ${TOTAL_MINIMUM} (short by ${TOTAL_MINIMUM - cases.length})`);
}

if (providerBacked > PROVIDER_BACKED_CAP) {
  fail('counts', `${providerBacked} cases are provider_backed, above the cap of ${PROVIDER_BACKED_CAP}; real-provider checks cost money and need authorisation`);
}

// ---------------------------------------------------------------------------
// Reconciliation against the test tree
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(test|spec)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

/** Case ids that appear inside a test title — it(), test() or describe(). */
const TITLE_CALL = /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;

const testFiles = walk(TESTS_DIR);
const implemented = new Map(); // id -> Set(relative file)
const foreignPrefixes = new Map(); // prefix -> { count, files: Set }
const malformedInTests = new Map(); // id -> Set(relative file)

for (const file of testFiles) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const rel = relative(ROOT, file).split(sep).join('/');
  let titleMatch;
  TITLE_CALL.lastIndex = 0;
  while ((titleMatch = TITLE_CALL.exec(source)) !== null) {
    const title = titleMatch[2];
    let idMatch;
    ID_IN_TITLE.lastIndex = 0;
    while ((idMatch = ID_IN_TITLE.exec(title)) !== null) {
      const prefix = idMatch[1];
      const digits = idMatch[2];
      const id = `${prefix}-${digits}`;
      if (NOT_A_CASE_PREFIX.has(prefix)) continue;
      if (!Object.prototype.hasOwnProperty.call(PREFIX_CATEGORY, prefix)) {
        if (!foreignPrefixes.has(prefix)) foreignPrefixes.set(prefix, { count: 0, files: new Set() });
        const entry = foreignPrefixes.get(prefix);
        entry.count += 1;
        entry.files.add(rel);
        continue;
      }
      if (digits === '000') {
        if (!malformedInTests.has(id)) malformedInTests.set(id, new Set());
        malformedInTests.get(id).add(rel);
        continue;
      }
      if (!implemented.has(id)) implemented.set(id, new Set());
      implemented.get(id).add(rel);
    }
  }
}

for (const [prefix, entry] of [...foreignPrefixes].sort()) {
  defect(
    'test-tree',
    `test titles use case-id prefix \`${prefix}\`, which is outside the allowlist (${entry.count} occurrence(s) across ${entry.files.size} file(s): ${[...entry.files].sort().join(', ')}). These cases cannot be counted towards the gate until they are renamed to an allowlisted prefix.`,
  );
}
for (const [id, files] of [...malformedInTests].sort()) {
  defect('test-tree', `test title uses \`${id}\`; case numbering starts at 001 (${[...files].sort().join(', ')})`);
}

const plannedIds = new Set(seenIds.keys());
const implementedIds = new Set(implemented.keys());

const implementedAndPlanned = [...implementedIds].filter((id) => plannedIds.has(id)).sort();
const implementedNotPlanned = [...implementedIds].filter((id) => !plannedIds.has(id)).sort();
const plannedNotImplemented = [...plannedIds].filter((id) => !implementedIds.has(id)).sort();

// A case id used in more than one test file is usually a copy-paste, not a real second case.
const duplicatedInTests = [...implemented.entries()]
  .filter(([, files]) => files.size > 1)
  .map(([id, files]) => ({ id, files: [...files].sort() }));

// An unplanned case id in a test title is a gate that nobody designed. Not fatal,
// but it must be visible, because it inflates an apparent pass count.
if (implementedNotPlanned.length > 0) {
  const byFile = new Map();
  for (const id of implementedNotPlanned) {
    for (const file of implemented.get(id)) {
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push(id);
    }
  }
  for (const [file, ids] of [...byFile].sort()) {
    warn(
      'reconciliation',
      `${file} carries ${ids.length} case id(s) that are not in the ledger (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''})`,
    );
  }
}
for (const { id, files } of duplicatedInTests) {
  warn('reconciliation', `${id} appears in ${files.length} test files (${files.join(', ')}) — one case must have one test`);
}

// A case claiming a status beyond `planned` must actually exist in the test tree.
for (const c of cases) {
  if (typeof c.id !== 'string') continue;
  const claimsImplemented = c.status === 'implemented' || c.status === 'passing' || c.status === 'failing';
  if (claimsImplemented && !implementedIds.has(c.id)) {
    fail(c.id, `status is \`${c.status}\` but no test title in tests/ carries this id`);
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const summary = {
  total: cases.length,
  total_minimum: TOTAL_MINIMUM,
  by_category: Object.fromEntries(CATEGORY_ORDER.map((k) => [k, countByCategory.get(k)])),
  by_level: Object.fromEntries([...countByLevel]),
  by_status: Object.fromEntries([...statusCounts].sort()),
  provider_backed: providerBacked,
  test_files_scanned: testFiles.length,
  reconciliation: {
    planned: plannedIds.size,
    implemented: implementedIds.size,
    implemented_and_planned: implementedAndPlanned.length,
    implemented_not_planned: implementedNotPlanned.length,
    planned_not_implemented: plannedNotImplemented.length,
  },
  failures: failures.length,
  reconciliation_defects: defects.length,
  warnings: warnings.length,
  strict: STRICT,
};

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2));
} else if (!QUIET) {
  const pad = (s, n) => String(s).padEnd(n);
  const lpad = (s, n) => String(s).padStart(n);

  console.log('');
  console.log('ITISYOU Verify — release test ledger');
  console.log(`  ledger      docs/test-cases.json (generated ${ledger.generated_at})`);
  console.log(`  test tree   tests/ — ${testFiles.length} test file(s) scanned`);
  console.log('');
  console.log(`  ${pad('category', 30)}${lpad('planned', 9)}${lpad('min', 6)}${lpad('unit', 7)}${lpad('integ', 7)}${lpad('e2e', 6)}  status`);
  console.log(`  ${'-'.repeat(30)}${'-'.repeat(9)}${'-'.repeat(6)}${'-'.repeat(7)}${'-'.repeat(7)}${'-'.repeat(6)}  ------`);
  for (const category of CATEGORY_ORDER) {
    const actual = countByCategory.get(category);
    const minimum = CATEGORY_MINIMUM[category];
    const split = levelByCategory.get(category);
    const state = actual >= minimum ? 'ok' : `SHORT by ${minimum - actual}`;
    console.log(
      `  ${pad(category, 30)}${lpad(actual, 9)}${lpad(minimum, 6)}${lpad(split.unit, 7)}${lpad(split.integration, 7)}${lpad(split.e2e, 6)}  ${state}`,
    );
  }
  console.log(`  ${'-'.repeat(65)}`);
  console.log(
    `  ${pad('TOTAL', 30)}${lpad(cases.length, 9)}${lpad(TOTAL_MINIMUM, 6)}${lpad(countByLevel.get('unit'), 7)}${lpad(countByLevel.get('integration'), 7)}${lpad(countByLevel.get('e2e'), 6)}  ${cases.length >= TOTAL_MINIMUM ? 'ok' : 'SHORT'}`,
  );
  console.log('');
  console.log(`  status      ${[...statusCounts].sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  provider    ${providerBacked} provider-backed case(s), cap ${PROVIDER_BACKED_CAP}`);
  console.log('');
  console.log('  Reconciliation (ledger vs case ids found in test titles)');
  console.log(`    planned                      ${plannedIds.size}`);
  console.log(`    implemented                  ${implementedIds.size}`);
  console.log(`    implemented and planned      ${implementedAndPlanned.length}`);
  console.log(`    implemented but NOT planned  ${implementedNotPlanned.length}`);
  console.log(`    planned but NOT implemented  ${plannedNotImplemented.length}`);
  if (plannedNotImplemented.length > 0) {
    const sample = plannedNotImplemented.slice(0, 12).join(', ');
    const more = plannedNotImplemented.length > 12 ? `, … (+${plannedNotImplemented.length - 12} more)` : '';
    console.log(`      first missing: ${sample}${more}`);
  }
  console.log('');
}

if (defects.length > 0 && !AS_JSON) {
  console.log(`  ${defects.length} reconciliation defect(s) in the test tree${STRICT ? ' (fatal under --strict)' : ' (not fatal without --strict)'}:`);
  for (const d of defects) console.log(`    DEFECT  [${d.where}] ${d.message}`);
  console.log('');
}

if (warnings.length > 0 && !AS_JSON) {
  console.log(`  ${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, WARN_SAMPLE * 4)) console.log(`    WARN  [${w.where}] ${w.message}`);
  if (warnings.length > WARN_SAMPLE * 4) console.log(`    …and ${warnings.length - WARN_SAMPLE * 4} more warning(s); use --json for the counts`);
  console.log('');
}

if (failures.length > 0) {
  console.error(`  ${failures.length} integrity failure(s):`);
  for (const f of failures.slice(0, 60)) console.error(`    FAIL  [${f.where}] ${f.message}`);
  if (failures.length > 60) console.error(`    …and ${failures.length - 60} more failure(s)`);
  console.error('');
  console.error('  The ledger does not satisfy the launch gate. Fix the cases, do not lower the minimums.');
  process.exit(1);
}

if (STRICT && defects.length > 0) {
  console.error(`  --strict: ${defects.length} reconciliation defect(s) block the release gate.`);
  console.error('  Fix the test titles listed above; the ledger is the design of record.');
  process.exit(1);
}

if (!AS_JSON) {
  console.log(`  Ledger integrity: PASS${defects.length > 0 ? `  (with ${defects.length} reconciliation defect(s) outstanding — run --strict at the release gate)` : ''}`);
  console.log('  Note: a passing ledger proves the plan is honest. It does not prove a single test passes.');
  console.log('');
}
process.exit(0);
