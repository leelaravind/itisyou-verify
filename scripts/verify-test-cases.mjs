#!/usr/bin/env node
/**
 * verify-test-cases.mjs — integrity checker for the release test ledger.
 *
 * `docs/test-cases.json` describes the suite that actually exists. This script proves the
 * description is honest, and reconciles it against the test tree and the recorded run.
 *
 * Two independent questions, deliberately kept apart:
 *   1. Is the ledger internally sound?      -> always fatal when broken
 *   2. Does it agree with the test tree?    -> reported always, fatal under --strict
 *
 * Node built-ins only; no dependencies.
 *
 * Usage:
 *   node scripts/verify-test-cases.mjs            # check and reconcile
 *   node scripts/verify-test-cases.mjs --strict   # release gate: test-tree defects also fail
 *   node scripts/verify-test-cases.mjs --gate     # release gate: also require every floor met
 *   node scripts/verify-test-cases.mjs --json     # machine-readable summary
 *   node scripts/verify-test-cases.mjs --quiet    # failures only
 *
 * Exit codes: 0 sound, 1 broken.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const LEDGER_PATH = join(ROOT, 'docs', 'test-cases.json');
const TESTS_DIR = join(ROOT, 'tests');
const SCANNER_PATH = join(ROOT, 'scripts', 'scan-secrets.mjs');

// ---------------------------------------------------------------------------
// Secret shapes. There is exactly one list of these in the repository — the
// scanner's — and it is read from there rather than copied. Two lists of secret
// shapes drift, and the one that drifts is always the one nobody is watching.
//
// The ledger quotes test source verbatim, and some fixtures are credential-shaped
// on purpose. Their `secret-scan:allow` marker does not survive harvesting, so a
// naive ledger trips the scanner and GitHub push protection. The generator redacts
// on the way in; this checker refuses a ledger where that did not happen.
// ---------------------------------------------------------------------------

/**
 * Parse the scanner's RULES array out of its source. Returns [{id, re}].
 * Throws rather than returning an empty list: a redaction pass that silently
 * matches nothing is worse than no redaction, because it is trusted.
 */
function loadSecretRules(scannerPath = SCANNER_PATH) {
  let src;
  try {
    src = readFileSync(scannerPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read the secret rules from ${scannerPath}: ${error.message}`);
  }
  const start = src.indexOf('const RULES = [');
  if (start === -1) throw new Error(`no \`const RULES = [\` block found in ${scannerPath}`);
  const open = src.indexOf('[', start);
  let depth = 0;
  let end = -1;
  let inLine = false;
  let inStr = null;
  let inRe = false;
  let inClass = false;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    const escaped = src[i - 1] === '\\' && src[i - 2] !== '\\';
    if (inLine) { if (ch === '\n') inLine = false; continue; }
    if (inStr) { if (ch === inStr && !escaped) inStr = null; continue; }
    if (inRe) {
      // An unescaped `/` inside a character class does NOT end a regex literal. An
      // earlier version missed this and truncated the block mid-rule, recovering 16 of
      // 18 rules — losing exactly the two that matched the fixtures in question.
      if (!escaped) {
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) inRe = false;
      }
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') { inLine = true; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
    // a regex literal always follows `re:` here, which is enough to disambiguate
    if (ch === '/' && /re\s*:\s*$/.test(src.slice(Math.max(0, i - 8), i))) { inRe = true; inClass = false; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error(`the RULES block in ${scannerPath} is not terminated`);

  const block = src.slice(open, end + 1);
  const declared = (block.match(/\{\s*id:\s*'/g) ?? []).length;
  const entry = /\{\s*id:\s*'([^']+)'\s*,\s*re:\s*\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\])+)\/([gimsuy]*)\s*\}/g;
  const rules = [];
  let m;
  while ((m = entry.exec(block)) !== null) {
    const flags = m[3].includes('g') ? m[3] : `${m[3]}g`;
    rules.push({ id: m[1], re: new RegExp(m[2], flags) });
  }
  if (rules.length === 0) throw new Error(`parsed zero rules from ${scannerPath}; the rule shape must have changed`);
  if (rules.length !== declared) {
    throw new Error(
      `parsed ${rules.length} secret rules from ${scannerPath} but it declares ${declared}. ` +
      'Refusing to check the ledger with an incomplete rule list.',
    );
  }
  return rules;
}

/**
 * Replace credential-shaped substrings with a placeholder that names what the fixture is.
 * The ledger's job is to describe the requirement, not to reproduce a fixture byte for byte.
 */
function redactSecrets(text, rules) {
  if (typeof text !== 'string' || text === '') return text;
  let out = text;
  for (const rule of rules) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
    out = out.replace(re, (match) => {
      if (rule.id === 'basic-auth-url') {
        const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(match);
        return `${scheme ? scheme[1] : 'https'}://<credentials-in-url>@`;
      }
      const assigned = /^([A-Za-z_][A-Za-z0-9_-]*)\s*([:=])/.exec(match);
      if (assigned) return `${assigned[1]}${assigned[2]} '<REDACTED-FIXTURE>'`;
      return '<REDACTED-FIXTURE>';
    });
  }
  return out;
}

const ARGS = new Set(process.argv.slice(2));
const QUIET = ARGS.has('--quiet');
const AS_JSON = ARGS.has('--json');
const STRICT = ARGS.has('--strict');
const GATE = ARGS.has('--gate');

// ---------------------------------------------------------------------------
// The launch gate. Changing a minimum here changes the gate, not a detail.
// ---------------------------------------------------------------------------

const TOTAL_MINIMUM = 500;

/** id prefix -> category. The allowlist is the one in docs/agent-brief.md. */
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

/** A case whose prefix is outside the allowlist lands here and can never be counted. */
const UNASSIGNED = 'unassigned';

const LEVELS = new Set(['unit', 'integration', 'e2e']);

/**
 * `passing` is the only status that is release-passing evidence.
 *   implemented — the test exists but was not measured in the recorded snapshot
 *   planned     — designed, not yet written
 *   skipped / quarantined — present but not executed; never counted
 */
const STATUSES = new Set(['planned', 'implemented', 'passing', 'failing', 'skipped', 'quarantined', 'retired']);
const COUNTS_TOWARDS_GATE = new Set(['passing']);

const REQUIRED_FIELDS = [
  'id', 'category', 'level', 'requirement', 'risk', 'risk_source', 'setup', 'expected',
  'owner_agent', 'implementation_ref', 'provider_backed', 'status', 'countable',
];
/** Optional: marks a case whose test title is generated at runtime. */
const OPTIONAL_FIELDS = ['area', 'title_generated'];
const TEXT_FIELDS = ['requirement', 'risk', 'setup', 'expected', 'owner_agent', 'implementation_ref'];
const RISK_SOURCES = new Set(['case', 'area']);

/** Real-provider cases cost money and need authorisation. Keep the number tiny. */
const PROVIDER_BACKED_CAP = 6;

const ID_PATTERN = /^([A-Z]+)-(\d{3})$/;
/** Loose form, so a badly-numbered id is diagnosed rather than silently ignored. */
const ID_LOOSE = /^([A-Z]+)-(\d{1,6})$/;
const ID_IN_TITLE = /\b([A-Z]+)-(\d{1,6})\b/g;

/** Tokens shaped like an id that are not one. */
const NOT_A_CASE_PREFIX = new Set([
  'SHA', 'AES', 'RSA', 'HMAC', 'UTF', 'ISO', 'RFC', 'WCAG', 'HTTP', 'TLS', 'CVE', 'ECDSA',
  'PBKDF', 'GBP', 'USD', 'EUR',
]);

const WARN_SAMPLE = 30;

const failures = [];
const defects = [];
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
if (ledger.schema_version !== 1) fail('ledger', `schema_version must be 1, found ${JSON.stringify(ledger.schema_version)}`);
if (typeof ledger.generated_at !== 'string' || Number.isNaN(Date.parse(ledger.generated_at))) {
  fail('ledger', `generated_at must be an ISO-8601 timestamp, found ${JSON.stringify(ledger.generated_at)}`);
}
if (!Array.isArray(ledger.cases)) {
  console.error('FATAL  docs/test-cases.json has no `cases` array.');
  process.exit(1);
}
const cases = ledger.cases;

// ---------------------------------------------------------------------------
// No credential-shaped literal may survive into the ledger.
//
// The ledger quotes test source, and several fixtures are credential-shaped on
// purpose. In their own files a `secret-scan:allow` marker exempts them; that
// marker does not survive harvesting, so an unsanitised ledger trips the secret
// scanner and GitHub push protection — which has already blocked this repository.
// The generator redacts; this refuses the file if it did not.
// ---------------------------------------------------------------------------
let secretRules;
try {
  secretRules = loadSecretRules();
} catch (error) {
  console.error(`FATAL  ${error.message}`);
  console.error('       The ledger cannot be checked for credential-shaped text, so it is not safe to pass.');
  process.exit(1);
}
for (const c of cases) {
  if (c === null || typeof c !== 'object') continue;
  for (const field of ['requirement', 'risk', 'setup', 'expected', 'implementation_ref']) {
    const value = c[field];
    if (typeof value !== 'string') continue;
    for (const rule of secretRules) {
      const re = new RegExp(rule.re.source, rule.re.flags.replace('g', ''));
      if (re.test(value)) {
        fail(
          typeof c.id === 'string' ? c.id : 'ledger',
          `\`${field}\` contains text matching the \`${rule.id}\` secret shape. Harvested text must be redacted before it reaches the ledger — regenerate with the redaction pass rather than editing this file by hand.`,
        );
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-case structure
// ---------------------------------------------------------------------------

const seenIds = new Map();
const seenPairs = new Map();
const numbersByPrefix = new Map();
const malformedLedgerIds = [];
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

for (let index = 0; index < cases.length; index += 1) {
  const c = cases[index];
  const at = `cases[${index}]`;
  if (c === null || typeof c !== 'object' || Array.isArray(c)) { fail(at, 'case is not an object'); continue; }
  const label = typeof c.id === 'string' && c.id !== '' ? c.id : at;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(c, field)) fail(label, `missing required field \`${field}\``);
  }
  for (const field of TEXT_FIELDS) {
    const v = c[field];
    if (v !== undefined && (typeof v !== 'string' || v.trim() === '')) fail(label, `\`${field}\` must be a non-empty string`);
  }
  if (typeof c.provider_backed !== 'boolean') fail(label, '`provider_backed` must be a boolean');
  if (typeof c.countable !== 'boolean') fail(label, '`countable` must be a boolean');
  if (c.risk_source !== undefined && !RISK_SOURCES.has(c.risk_source)) {
    fail(label, `risk_source \`${c.risk_source}\` is outside {${[...RISK_SOURCES].join(', ')}}`);
  }

  if (typeof c.id !== 'string') {
    fail(at, '`id` must be a string');
  } else {
    const match = ID_PATTERN.exec(c.id);
    if (match === null) {
      // A badly-numbered id in the ledger may be a faithful record of a badly-numbered
      // test title. Which it is depends on the tree, so the verdict is deferred.
      const loose = ID_LOOSE.exec(c.id);
      if (loose === null) fail(c.id, 'malformed id: expected PREFIX-NNN with a three-digit zero-padded number');
      else malformedLedgerIds.push({ id: c.id, countable: c.countable === true });
    } else {
      const [, prefix, digits] = match;
      const allowlisted = Object.prototype.hasOwnProperty.call(PREFIX_CATEGORY, prefix);
      if (!allowlisted) {
        if (c.category !== UNASSIGNED) {
          fail(c.id, `prefix \`${prefix}\` is outside the allowlist, so category must be \`${UNASSIGNED}\`, found \`${c.category}\``);
        }
        if (c.countable === true) fail(c.id, `prefix \`${prefix}\` is outside the allowlist, so this case cannot be countable`);
      } else if (c.category !== PREFIX_CATEGORY[prefix]) {
        fail(c.id, `prefix \`${prefix}\` belongs to \`${PREFIX_CATEGORY[prefix]}\` but the case declares \`${c.category}\``);
      }
      if (digits === '000') fail(c.id, 'case numbering starts at 001');
      if (allowlisted) {
        if (!numbersByPrefix.has(prefix)) numbersByPrefix.set(prefix, new Set());
        numbersByPrefix.get(prefix).add(Number(digits));
      }
    }
    if (seenIds.has(c.id)) fail(c.id, `duplicate id, first seen at cases[${seenIds.get(c.id)}]`);
    else seenIds.set(c.id, index);
  }

  if (c.category !== undefined && c.category !== UNASSIGNED && !Object.prototype.hasOwnProperty.call(CATEGORY_MINIMUM, c.category)) {
    fail(label, `category \`${c.category}\` is outside the allowed set`);
  }
  if (c.level !== undefined && !LEVELS.has(c.level)) fail(label, `level \`${c.level}\` is outside {${[...LEVELS].join(', ')}}`);
  if (c.status !== undefined && !STATUSES.has(c.status)) fail(label, `status \`${c.status}\` is outside {${[...STATUSES].join(', ')}}`);

  // The padding detector. Two cases differing only cosmetically are one case.
  if (typeof c.requirement === 'string' && typeof c.setup === 'string') {
    const fp = `${norm(c.requirement)} ||| ${norm(c.setup)}`;
    if (seenPairs.has(fp)) fail(label, `identical requirement + setup as ${seenPairs.get(fp)} — these are one case, not two`);
    else seenPairs.set(fp, label);
  }
}

// ---------------------------------------------------------------------------
// Counts. Only `passing` counts towards the gate.
// ---------------------------------------------------------------------------

const zero = () => ({ total: 0, passing: 0, failing: 0, planned: 0, implemented: 0, other: 0, counted: 0 });
const byCategory = new Map(CATEGORY_ORDER.map((k) => [k, zero()]));
byCategory.set(UNASSIGNED, zero());
const byLevel = new Map([...LEVELS].map((k) => [k, 0]));
const levelByCategory = new Map([...CATEGORY_ORDER, UNASSIGNED].map((k) => [k, { unit: 0, integration: 0, e2e: 0 }]));
const statusCounts = new Map();
let providerBacked = 0;
let countedTotal = 0;

for (const c of cases) {
  const bucket = byCategory.get(c.category) ?? byCategory.get(UNASSIGNED);
  bucket.total += 1;
  if (c.status === 'passing') bucket.passing += 1;
  else if (c.status === 'failing') bucket.failing += 1;
  else if (c.status === 'planned') bucket.planned += 1;
  else if (c.status === 'implemented') bucket.implemented += 1;
  else bucket.other += 1;
  if (c.countable === true && COUNTS_TOWARDS_GATE.has(c.status)) { bucket.counted += 1; countedTotal += 1; }
  if (byLevel.has(c.level)) byLevel.set(c.level, byLevel.get(c.level) + 1);
  if (levelByCategory.has(c.category) && LEVELS.has(c.level)) levelByCategory.get(c.category)[c.level] += 1;
  statusCounts.set(c.status, (statusCounts.get(c.status) ?? 0) + 1);
  if (c.provider_backed === true) providerBacked += 1;
}

const shortfalls = [];
for (const category of CATEGORY_ORDER) {
  const counted = byCategory.get(category).counted;
  const minimum = CATEGORY_MINIMUM[category];
  if (counted < minimum) shortfalls.push({ category, counted, minimum, short: minimum - counted });
}
if (countedTotal < TOTAL_MINIMUM) {
  fail('gate', `${countedTotal} passing countable cases, below the launch minimum of ${TOTAL_MINIMUM} (short by ${TOTAL_MINIMUM - countedTotal})`);
}
if (providerBacked > PROVIDER_BACKED_CAP) {
  fail('gate', `${providerBacked} cases are provider_backed, above the cap of ${PROVIDER_BACKED_CAP}`);
}
// A provider-backed case may never claim to be passing evidence unless it really ran.
for (const c of cases) {
  if (c.provider_backed === true && c.status === 'passing' && !ARGS.has('--provider-run')) {
    warn('gate', `${c.id} is provider_backed and marked passing; confirm it ran against a live account, not a mock`);
  }
}

// ---------------------------------------------------------------------------
// Reconciliation against the test tree
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(test|spec)\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

const TITLE_CALL = /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
const testFiles = walk(TESTS_DIR);
const implemented = new Map();
const foreignPrefixes = new Map();
const malformedInTests = new Map();
/** Every id-shaped token found anywhere in a test title, however badly formed. */
const presentInTree = new Set();

for (const file of testFiles) {
  let source;
  try { source = readFileSync(file, 'utf8'); } catch { continue; }
  const rel = relative(ROOT, file).split(sep).join('/');
  let tm;
  TITLE_CALL.lastIndex = 0;
  while ((tm = TITLE_CALL.exec(source)) !== null) {
    const title = tm[2];
    let im;
    ID_IN_TITLE.lastIndex = 0;
    while ((im = ID_IN_TITLE.exec(title)) !== null) {
      const prefix = im[1];
      const digits = im[2];
      const id = `${prefix}-${digits}`;
      if (NOT_A_CASE_PREFIX.has(prefix)) continue;
      presentInTree.add(id);
      if (!Object.prototype.hasOwnProperty.call(PREFIX_CATEGORY, prefix)) {
        if (!foreignPrefixes.has(prefix)) foreignPrefixes.set(prefix, { ids: new Set(), files: new Set() });
        foreignPrefixes.get(prefix).ids.add(id);
        foreignPrefixes.get(prefix).files.add(rel);
        continue;
      }
      if (digits.length !== 3 || digits === '000') {
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
  defect('test-tree', `case-id prefix \`${prefix}\` is outside the allowlist: ${entry.ids.size} distinct id(s) across ${entry.files.size} file(s). These cases cannot be counted towards any category until they are renamed. Files: ${[...entry.files].sort().join(', ')}`);
}
for (const [id, files] of [...malformedInTests].sort()) {
  defect('test-tree', `\`${id}\` is not a well-formed case id (ids are zero-padded to three digits, from 001): ${[...files].sort().join(', ')}`);
}

// One case id must mean one case. The same id in two files is two cases wearing one name.
const duplicatedInTests = [...implemented.entries()]
  .filter(([, files]) => files.size > 1)
  .map(([id, files]) => ({ id, files: [...files].sort() }));
for (const { id, files } of duplicatedInTests) {
  defect('test-tree', `\`${id}\` is used by ${files.length} different test files (${files.join(', ')}) — one id, two cases; only one of them can be counted`);
}

const plannedIds = new Set(seenIds.keys());
const implementedIds = new Set(implemented.keys());
const both = [...implementedIds].filter((id) => plannedIds.has(id)).sort();
const implementedNotPlanned = [...implementedIds].filter((id) => !plannedIds.has(id)).sort();
const plannedNotImplemented = [...plannedIds].filter((id) => !implementedIds.has(id)).sort();

if (implementedNotPlanned.length > 0) {
  const byFile = new Map();
  for (const id of implementedNotPlanned) {
    for (const f of implemented.get(id)) {
      if (!byFile.has(f)) byFile.set(f, []);
      byFile.get(f).push(id);
    }
  }
  for (const [f, ids] of [...byFile].sort()) {
    defect('test-tree', `${f} carries ${ids.length} case id(s) absent from the ledger (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''}) — the ledger must describe the suite that exists`);
  }
}

// A ledger case claiming to have run must exist somewhere in the tree — including under
// an off-allowlist prefix or a bad number, which are tree defects, not ledger lies.
for (const c of cases) {
  if (typeof c.id !== 'string') continue;
  const claims = c.status === 'implemented' || c.status === 'passing' || c.status === 'failing';
  if (!claims || presentInTree.has(c.id)) continue;
  if (c.title_generated === true) {
    // The title is built at runtime, so no static scan can find it. The run record is the
    // evidence. Surfaced rather than trusted silently.
    warn('reconciliation', `${c.id} has a runtime-generated title, so its only evidence is the recorded run (${c.implementation_ref})`);
    continue;
  }
  fail(c.id, `status is \`${c.status}\` but no test title in tests/ carries this id`);
}

// Deferred verdict on badly-numbered ledger ids.
for (const m of malformedLedgerIds) {
  if (presentInTree.has(m.id)) {
    if (m.countable) fail(m.id, 'id is not well formed, so this case cannot be marked countable');
    // otherwise already reported once as a test-tree defect by the scan above
  } else {
    fail(m.id, 'malformed id and no test title carries it: expected PREFIX-NNN, zero-padded to three digits');
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const summary = {
  snapshot_commit: ledger.snapshot_commit ?? null,
  ledger_entries: cases.length,
  counted_passing: countedTotal,
  total_minimum: TOTAL_MINIMUM,
  floor_met_overall: countedTotal >= TOTAL_MINIMUM,
  categories_below_floor: shortfalls,
  by_category: Object.fromEntries([...CATEGORY_ORDER, UNASSIGNED].map((k) => [k, byCategory.get(k)])),
  by_level: Object.fromEntries([...byLevel]),
  by_status: Object.fromEntries([...statusCounts].sort()),
  provider_backed: providerBacked,
  test_files_scanned: testFiles.length,
  reconciliation: {
    in_ledger: plannedIds.size,
    in_tree: implementedIds.size,
    in_both: both.length,
    in_tree_not_ledger: implementedNotPlanned.length,
    in_ledger_not_tree: plannedNotImplemented.length,
  },
  failures: failures.length,
  reconciliation_defects: defects.length,
  warnings: warnings.length,
};

if (AS_JSON) {
  console.log(JSON.stringify(summary, null, 2));
} else if (!QUIET) {
  const pad = (s, n) => String(s).padEnd(n);
  const lp = (s, n) => String(s).padStart(n);
  console.log('');
  console.log('ITISYOU Verify — release test ledger');
  console.log(`  ledger      docs/test-cases.json (generated ${ledger.generated_at}${ledger.snapshot_commit ? `, snapshot ${ledger.snapshot_commit}` : ''})`);
  console.log(`  test tree   tests/ — ${testFiles.length} file(s) scanned`);
  console.log('');
  console.log(`  ${pad('category', 30)}${lp('total', 7)}${lp('pass', 7)}${lp('fail', 6)}${lp('plan', 6)}${lp('unmeas', 8)}${lp('min', 6)}${lp('COUNTED', 9)}  verdict`);
  console.log(`  ${'-'.repeat(30)}${'-'.repeat(49)}  -------`);
  for (const category of CATEGORY_ORDER) {
    const b = byCategory.get(category);
    const min = CATEGORY_MINIMUM[category];
    const v = b.counted >= min ? 'ok' : `SHORT by ${min - b.counted}`;
    console.log(`  ${pad(category, 30)}${lp(b.total, 7)}${lp(b.passing, 7)}${lp(b.failing, 6)}${lp(b.planned, 6)}${lp(b.implemented, 8)}${lp(min, 6)}${lp(b.counted, 9)}  ${v}`);
  }
  const u = byCategory.get(UNASSIGNED);
  if (u.total > 0) {
    console.log(`  ${pad(UNASSIGNED + ' (off-allowlist)', 30)}${lp(u.total, 7)}${lp(u.passing, 7)}${lp(u.failing, 6)}${lp(u.planned, 6)}${lp(u.implemented, 8)}${lp('-', 6)}${lp(0, 9)}  NOT COUNTABLE`);
  }
  console.log(`  ${'-'.repeat(88)}`);
  console.log(`  ${pad('TOTAL', 30)}${lp(cases.length, 7)}${lp(statusCounts.get('passing') ?? 0, 7)}${lp(statusCounts.get('failing') ?? 0, 6)}${lp(statusCounts.get('planned') ?? 0, 6)}${lp(statusCounts.get('implemented') ?? 0, 8)}${lp(TOTAL_MINIMUM, 6)}${lp(countedTotal, 9)}  ${countedTotal >= TOTAL_MINIMUM ? 'floor met' : 'FLOOR NOT MET'}`);
  console.log('');
  console.log(`  levels      ${[...byLevel].sort().map(([k, v]) => `${k}=${v}`).join('  ')}`);
  console.log(`  provider    ${providerBacked} provider-backed case(s), cap ${PROVIDER_BACKED_CAP}`);
  console.log('');
  console.log('  Counted = countable AND status passing. A skip, a quarantine, an unmeasured');
  console.log('  case and an off-allowlist prefix are all worth zero.');
  console.log('');
  if (shortfalls.length > 0) {
    console.log(`  ${shortfalls.length} category/categories below floor:`);
    for (const s of shortfalls) console.log(`    ${s.category}: ${s.counted} counted against a floor of ${s.minimum} (short by ${s.short})`);
    console.log('');
  }
  console.log('  Reconciliation (ledger vs case ids in test titles)');
  console.log(`    in the ledger                ${plannedIds.size}`);
  console.log(`    in the test tree             ${implementedIds.size}`);
  console.log(`    in both                      ${both.length}`);
  console.log(`    in the tree, not the ledger  ${implementedNotPlanned.length}`);
  console.log(`    in the ledger, not the tree  ${plannedNotImplemented.length}`);
  console.log('');
}

if (defects.length > 0 && !AS_JSON) {
  console.log(`  ${defects.length} reconciliation defect(s)${STRICT ? ' (fatal under --strict)' : ' (not fatal without --strict)'}:`);
  for (const d of defects.slice(0, WARN_SAMPLE)) console.log(`    DEFECT  [${d.where}] ${d.message}`);
  if (defects.length > WARN_SAMPLE) console.log(`    …and ${defects.length - WARN_SAMPLE} more`);
  console.log('');
}
if (warnings.length > 0 && !AS_JSON && !QUIET) {
  console.log(`  ${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, WARN_SAMPLE)) console.log(`    WARN  [${w.where}] ${w.message}`);
  if (warnings.length > WARN_SAMPLE) console.log(`    …and ${warnings.length - WARN_SAMPLE} more`);
  console.log('');
}

if (failures.length > 0) {
  console.error(`  ${failures.length} ledger integrity failure(s):`);
  for (const f of failures.slice(0, 60)) console.error(`    FAIL  [${f.where}] ${f.message}`);
  if (failures.length > 60) console.error(`    …and ${failures.length - 60} more`);
  console.error('');
  console.error('  Fix the cases, do not lower the minimums.');
  process.exit(1);
}
if (STRICT && defects.length > 0) {
  console.error(`  --strict: ${defects.length} reconciliation defect(s) block the release gate.`);
  process.exit(1);
}
if (GATE && shortfalls.length > 0) {
  console.error(`  --gate: ${shortfalls.length} category/categories are below their floor on cases that actually passed.`);
  process.exit(1);
}

if (!AS_JSON) {
  const caveats = [];
  if (defects.length > 0) caveats.push(`${defects.length} reconciliation defect(s)`);
  if (shortfalls.length > 0) caveats.push(`${shortfalls.length} category/categories below floor`);
  console.log(`  Ledger integrity: PASS${caveats.length > 0 ? `  (outstanding: ${caveats.join('; ')} — run --strict --gate at the release gate)` : ''}`);
  console.log('  A sound ledger proves the count is honest. It does not make a failing suite green.');
  console.log('');
}
process.exit(0);
