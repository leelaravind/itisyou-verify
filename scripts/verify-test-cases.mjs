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

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What this run is a reading OF.
 *
 * Everything this script prints describes the working tree as it exists right now, at
 * whatever commit HEAD happens to be, with whatever is uncommitted. That is not a
 * property of a commit and must never be quoted as a gate result — on this repository
 * the suite moved by four hundred cases in twenty minutes while it was being measured.
 * The gate number comes from scripts/build-gate-artefact.mjs run by CI on a clean
 * checkout. Saying so on every local run is cheaper than correcting the misquote later.
 */
function treeLabel() {
  const git = (a) => {
    try {
      // stderr is discarded: outside a repository git is loud, and "no git here" is a
      // fact this function reports, not an error the caller needs shouted at them.
      return execFileSync('git', a, {
        encoding: 'utf8',
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  };
  const sha = git(['rev-parse', 'HEAD']);
  if (sha === null) return 'a working tree with no reachable git metadata';
  const dirty = git(['status', '--porcelain']);
  const changed = dirty === null ? null : dirty.split('\n').filter((l) => l.trim() !== '').length;
  const state =
    changed === null
      ? 'unknown cleanliness'
      : changed === 0
        ? 'clean'
        : `${changed} uncommitted change(s)`;
  return `a working tree at ${sha.slice(0, 12)}, ${state}`;
}

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
    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inStr) {
      if (ch === inStr && !escaped) inStr = null;
      continue;
    }
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
    if (ch === '/' && src[i + 1] === '/') {
      inLine = true;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch;
      continue;
    }
    // a regex literal always follows `re:` here, which is enough to disambiguate
    if (ch === '/' && /re\s*:\s*$/.test(src.slice(Math.max(0, i - 8), i))) {
      inRe = true;
      inClass = false;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error(`the RULES block in ${scannerPath} is not terminated`);

  const block = src.slice(open, end + 1);
  const declared = (block.match(/\{\s*id:\s*'/g) ?? []).length;
  const entry =
    /\{\s*id:\s*'([^']+)'\s*,\s*re:\s*\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\])+)\/([gimsuy]*)\s*,?\s*\}/g;
  const rules = [];
  let m;
  while ((m = entry.exec(block)) !== null) {
    const flags = m[3].includes('g') ? m[3] : `${m[3]}g`;
    rules.push({ id: m[1], re: new RegExp(m[2], flags) });
  }
  if (rules.length === 0)
    throw new Error(`parsed zero rules from ${scannerPath}; the rule shape must have changed`);
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
/*
 * `redactSecrets` used to live here and has been removed rather than wired up.
 *
 * This script only ever READS the ledger, so a redaction helper inside it could not have
 * redacted anything that mattered — the file would already have been written. And the
 * validator already does the better thing at the point of detection: it refuses, naming
 * the field and the secret shape, and tells the author to regenerate rather than hand-edit.
 *
 * A validator that silently rewrites what it is checking hides the mistake from the person
 * who made it and leaves the source that produced it unchanged. Refusing is louder, and the
 * loudness is the feature.
 */

const ARGS = new Set(process.argv.slice(2));
const QUIET = ARGS.has('--quiet');
const AS_JSON = ARGS.has('--json');
const STRICT = ARGS.has('--strict');
const GATE = ARGS.has('--gate');

// ---------------------------------------------------------------------------
// The launch gate. Changing a minimum here changes the gate, not a detail.
// ---------------------------------------------------------------------------

const TOTAL_MINIMUM = 500;

/**
 * id prefix -> default category. The allowlist is the one in docs/agent-brief.md.
 *
 * A value of `null` means the prefix is on the allowlist but carries no category of its
 * own: its cases span several categories, so each one must declare `category` explicitly.
 *
 * `SEC` is the only such prefix today. A blanket `SEC -> api_security_privacy` mapping
 * would have been one line, and wrong for about a third of its 156 cases — credential
 * AAD and tenant predicate are `auth_tenancy`, approval hashing is `owner_panel`, the
 * assistant boundary is `budgets_models_maintenance`. A number that is wrong for a third
 * of its inputs is a false number with a footnote, and footnotes get dropped when a total
 * is quoted. Renaming 156 ids to encode the category was the other option and is worse:
 * an id is identity, not metadata. So the category is carried per case instead.
 */
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
  SEC: null,
};

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

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
const STATUSES = new Set([
  'planned',
  'implemented',
  'passing',
  'failing',
  'skipped',
  'quarantined',
  'retired',
]);
const COUNTS_TOWARDS_GATE = new Set(['passing']);

const REQUIRED_FIELDS = [
  'id',
  'level',
  'requirement',
  'risk',
  'risk_source',
  'setup',
  'expected',
  'owner_agent',
  'implementation_ref',
  'provider_backed',
  'status',
  'countable',
];
/**
 * Optional fields.
 *   category        — when present it wins; when absent the prefix default applies.
 *                     Mandatory for a prefix whose default is `null` (see PREFIX_CATEGORY).
 *   title_generated — marks a case whose test title is built at runtime.
 */
const TEXT_FIELDS = [
  'requirement',
  'risk',
  'setup',
  'expected',
  'owner_agent',
  'implementation_ref',
];
const RISK_SOURCES = new Set(['case', 'area']);

/** Real-provider cases cost money and need authorisation. Keep the number tiny. */
const PROVIDER_BACKED_CAP = 6;

const ID_PATTERN = /^([A-Z]+)-(\d{3})$/;
/** Loose form, so a badly-numbered id is diagnosed rather than silently ignored. */
const ID_LOOSE = /^([A-Z]+)-(\d{1,6})$/;
const ID_IN_TITLE = /\b([A-Z]+)-(\d{1,6})\b/g;

/** Tokens shaped like an id that are not one. */
const NOT_A_CASE_PREFIX = new Set([
  'SHA',
  'AES',
  'RSA',
  'HMAC',
  'UTF',
  'ISO',
  'RFC',
  'WCAG',
  'HTTP',
  'TLS',
  'CVE',
  'ECDSA',
  'PBKDF',
  'GBP',
  'USD',
  'EUR',
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
if (ledger.schema_version !== 1)
  fail('ledger', `schema_version must be 1, found ${JSON.stringify(ledger.schema_version)}`);
if (typeof ledger.generated_at !== 'string' || Number.isNaN(Date.parse(ledger.generated_at))) {
  fail(
    'ledger',
    `generated_at must be an ISO-8601 timestamp, found ${JSON.stringify(ledger.generated_at)}`,
  );
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
  console.error(
    '       The ledger cannot be checked for credential-shaped text, so it is not safe to pass.',
  );
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

/**
 * The category actually in force for each case: an explicit `category` wins, otherwise
 * the prefix default. Keyed by the case object so the counting pass below cannot drift
 * from the validation pass above.
 */
const resolvedCategory = new Map();
/** Cases whose explicit category differs from their prefix default. Reported, not fatal. */
const categoryOverrides = [];

for (let index = 0; index < cases.length; index += 1) {
  const c = cases[index];
  const at = `cases[${index}]`;
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    fail(at, 'case is not an object');
    continue;
  }
  const label = typeof c.id === 'string' && c.id !== '' ? c.id : at;

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(c, field))
      fail(label, `missing required field \`${field}\``);
  }
  for (const field of TEXT_FIELDS) {
    const v = c[field];
    if (v !== undefined && (typeof v !== 'string' || v.trim() === ''))
      fail(label, `\`${field}\` must be a non-empty string`);
  }
  if (typeof c.provider_backed !== 'boolean') fail(label, '`provider_backed` must be a boolean');
  if (typeof c.countable !== 'boolean') fail(label, '`countable` must be a boolean');
  if (c.risk_source !== undefined && !RISK_SOURCES.has(c.risk_source)) {
    fail(label, `risk_source \`${c.risk_source}\` is outside {${[...RISK_SOURCES].join(', ')}}`);
  }

  // -------------------------------------------------------------------------
  // Category. Resolved from the prefix unless the case names one itself.
  //
  // This runs off the LOOSE id form on purpose: a case with a badly-numbered id is
  // still a case, still belongs to a category, and must still be counted in the
  // right column of the table even while its id is a tree defect.
  // -------------------------------------------------------------------------
  const looseId = typeof c.id === 'string' ? ID_LOOSE.exec(c.id) : null;
  const prefix = looseId === null ? null : looseId[1];
  const onAllowlist = prefix !== null && hasOwn(PREFIX_CATEGORY, prefix);
  const prefixDefault = onAllowlist ? PREFIX_CATEGORY[prefix] : null;
  const declaredCategory =
    typeof c.category === 'string' && c.category.trim() !== '' ? c.category : null;

  if (hasOwn(c, 'category') && declaredCategory === null) {
    fail(label, '`category`, when present, must be a non-empty string');
  }
  if (
    declaredCategory !== null &&
    declaredCategory !== UNASSIGNED &&
    !hasOwn(CATEGORY_MINIMUM, declaredCategory)
  ) {
    fail(
      label,
      `category \`${declaredCategory}\` is outside the twelve-category allowlist {${CATEGORY_ORDER.join(', ')}}`,
    );
  }
  if (prefix !== null) {
    if (!onAllowlist) {
      if (declaredCategory !== UNASSIGNED) {
        fail(
          label,
          `prefix \`${prefix}\` is outside the allowlist, so category must be \`${UNASSIGNED}\`, found \`${declaredCategory ?? '(absent)'}\``,
        );
      }
      if (c.countable === true)
        fail(
          label,
          `prefix \`${prefix}\` is outside the allowlist, so this case cannot be countable`,
        );
    } else if (declaredCategory === null) {
      if (prefixDefault === null) {
        fail(
          label,
          `prefix \`${prefix}\` spans several categories and has no default, so this case must declare \`category\` explicitly — one of {${CATEGORY_ORDER.join(', ')}}`,
        );
      }
    } else if (declaredCategory === UNASSIGNED) {
      fail(
        label,
        `prefix \`${prefix}\` is on the allowlist, so \`${UNASSIGNED}\` is not a category it may claim`,
      );
    } else if (prefixDefault !== null && declaredCategory !== prefixDefault) {
      categoryOverrides.push({ id: label, from: prefixDefault, to: declaredCategory });
    }
  }
  resolvedCategory.set(c, declaredCategory ?? prefixDefault ?? UNASSIGNED);

  if (typeof c.id !== 'string') {
    fail(at, '`id` must be a string');
  } else {
    const match = ID_PATTERN.exec(c.id);
    if (match === null) {
      // A badly-numbered id in the ledger may be a faithful record of a badly-numbered
      // test title. Which it is depends on the tree, so the verdict is deferred.
      if (looseId === null)
        fail(c.id, 'malformed id: expected PREFIX-NNN with a three-digit zero-padded number');
      else malformedLedgerIds.push({ id: c.id, countable: c.countable === true });
    } else {
      const digits = match[2];
      if (digits === '000') fail(c.id, 'case numbering starts at 001');
      if (onAllowlist) {
        if (!numbersByPrefix.has(prefix)) numbersByPrefix.set(prefix, new Set());
        numbersByPrefix.get(prefix).add(Number(digits));
      }
    }
    if (seenIds.has(c.id)) fail(c.id, `duplicate id, first seen at cases[${seenIds.get(c.id)}]`);
    else seenIds.set(c.id, index);
  }
  if (c.level !== undefined && !LEVELS.has(c.level))
    fail(label, `level \`${c.level}\` is outside {${[...LEVELS].join(', ')}}`);
  if (c.status !== undefined && !STATUSES.has(c.status))
    fail(label, `status \`${c.status}\` is outside {${[...STATUSES].join(', ')}}`);

  // The padding detector. Two cases differing only cosmetically are one case.
  if (typeof c.requirement === 'string' && typeof c.setup === 'string') {
    const fp = `${norm(c.requirement)} ||| ${norm(c.setup)}`;
    if (seenPairs.has(fp))
      fail(
        label,
        `identical requirement + setup as ${seenPairs.get(fp)} — these are one case, not two`,
      );
    else seenPairs.set(fp, label);
  }
}

// ---------------------------------------------------------------------------
// Counts. Only `passing` counts towards the gate.
// ---------------------------------------------------------------------------

const zero = () => ({
  total: 0,
  passing: 0,
  failing: 0,
  planned: 0,
  implemented: 0,
  other: 0,
  counted: 0,
});
const byCategory = new Map(CATEGORY_ORDER.map((k) => [k, zero()]));
byCategory.set(UNASSIGNED, zero());
const byLevel = new Map([...LEVELS].map((k) => [k, 0]));
const levelByCategory = new Map(
  [...CATEGORY_ORDER, UNASSIGNED].map((k) => [k, { unit: 0, integration: 0, e2e: 0 }]),
);
const statusCounts = new Map();
let providerBacked = 0;
let countedTotal = 0;

/** The category in force. Explicit wins; otherwise the prefix default; otherwise unassigned. */
const categoryOf = (c) => resolvedCategory.get(c) ?? UNASSIGNED;

for (const c of cases) {
  const category = categoryOf(c);
  const bucket = byCategory.get(category) ?? byCategory.get(UNASSIGNED);
  bucket.total += 1;
  if (c.status === 'passing') bucket.passing += 1;
  else if (c.status === 'failing') bucket.failing += 1;
  else if (c.status === 'planned') bucket.planned += 1;
  else if (c.status === 'implemented') bucket.implemented += 1;
  else bucket.other += 1;
  if (c.countable === true && COUNTS_TOWARDS_GATE.has(c.status)) {
    bucket.counted += 1;
    countedTotal += 1;
  }
  if (byLevel.has(c.level)) byLevel.set(c.level, byLevel.get(c.level) + 1);
  if (levelByCategory.has(category) && LEVELS.has(c.level))
    levelByCategory.get(category)[c.level] += 1;
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
  fail(
    'gate',
    `${countedTotal} passing countable cases, below the launch minimum of ${TOTAL_MINIMUM} (short by ${TOTAL_MINIMUM - countedTotal})`,
  );
}
if (providerBacked > PROVIDER_BACKED_CAP) {
  fail(
    'gate',
    `${providerBacked} cases are provider_backed, above the cap of ${PROVIDER_BACKED_CAP}`,
  );
}
// A provider-backed case may never claim to be passing evidence unless it really ran.
for (const c of cases) {
  if (c.provider_backed === true && c.status === 'passing' && !ARGS.has('--provider-run')) {
    warn(
      'gate',
      `${c.id} is provider_backed and marked passing; confirm it ran against a live account, not a mock`,
    );
  }
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

const TITLE_CALL = /\b(?:it|test|describe)(?:\.\w+)*\s*\(\s*(['"`])([\s\S]*?)\1/g;
const testFiles = walk(TESTS_DIR);
const implemented = new Map();
const foreignPrefixes = new Map();
const malformedInTests = new Map();
/** Every id a test title DECLARES (as opposed to merely mentions). */
const presentInTree = new Set();
/**
 * A title declares exactly one case id, and it is the leading token — the convention in
 * docs/agent-brief.md: `it('VERIFY-012 returns FAILED when …')`. An id appearing later in
 * a title is a CROSS-REFERENCE to another agent's case, e.g.
 *
 *     it('API-016 refuses to open without an expected AAD (A10 AUTH-114)')
 *
 * Counting that as an implementation of AUTH-114 invented four duplicate-id defects out
 * of nothing — AUTH-114, AUTH-115, AUTH-137 and SEC-431 — and would have had three agents
 * renaming ids to resolve collisions that do not exist. Measured across the whole tree at
 * this commit: 2,311 ids lead a title and 2,311 ids appear in one, so no real case is lost
 * by reading only the leading token.
 */
const LEADING_ID = /^\s*([A-Z]+)-(\d{1,6})\b/;
const crossReferences = [];

for (const file of testFiles) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const rel = relative(ROOT, file).split(sep).join('/');
  let tm;
  TITLE_CALL.lastIndex = 0;
  while ((tm = TITLE_CALL.exec(source)) !== null) {
    const title = tm[2];
    const lead = LEADING_ID.exec(title);
    const declaredId =
      lead !== null && !NOT_A_CASE_PREFIX.has(lead[1]) ? `${lead[1]}-${lead[2]}` : null;

    // Everything after the leading token is a reference, recorded so the distinction is
    // visible rather than silent.
    let im;
    ID_IN_TITLE.lastIndex = 0;
    while ((im = ID_IN_TITLE.exec(title)) !== null) {
      if (NOT_A_CASE_PREFIX.has(im[1])) continue;
      const seen = `${im[1]}-${im[2]}`;
      if (seen !== declaredId) crossReferences.push({ id: seen, in: declaredId, file: rel });
    }

    if (declaredId === null) continue;
    const prefix = lead[1];
    const digits = lead[2];
    presentInTree.add(declaredId);
    if (!hasOwn(PREFIX_CATEGORY, prefix)) {
      if (!foreignPrefixes.has(prefix))
        foreignPrefixes.set(prefix, { ids: new Set(), files: new Set() });
      foreignPrefixes.get(prefix).ids.add(declaredId);
      foreignPrefixes.get(prefix).files.add(rel);
      continue;
    }
    if (digits.length !== 3 || digits === '000') {
      if (!malformedInTests.has(declaredId)) malformedInTests.set(declaredId, new Set());
      malformedInTests.get(declaredId).add(rel);
      continue;
    }
    if (!implemented.has(declaredId)) implemented.set(declaredId, new Set());
    implemented.get(declaredId).add(rel);
  }
}

for (const [prefix, entry] of [...foreignPrefixes].sort()) {
  defect(
    'test-tree',
    `case-id prefix \`${prefix}\` is outside the allowlist: ${entry.ids.size} distinct id(s) across ${entry.files.size} file(s). These cases cannot be counted towards any category until they are renamed. Files: ${[...entry.files].sort().join(', ')}`,
  );
}
for (const [id, files] of [...malformedInTests].sort()) {
  defect(
    'test-tree',
    `\`${id}\` is not a well-formed case id (ids are zero-padded to three digits, from 001): ${[...files].sort().join(', ')}`,
  );
}

// One case id must mean one case. The same id in two files is two cases wearing one name.
const duplicatedInTests = [...implemented.entries()]
  .filter(([, files]) => files.size > 1)
  .map(([id, files]) => ({ id, files: [...files].sort() }));
for (const { id, files } of duplicatedInTests) {
  defect(
    'test-tree',
    `\`${id}\` is used by ${files.length} different test files (${files.join(', ')}) — one id, two cases; only one of them can be counted`,
  );
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
    defect(
      'test-tree',
      `${f} carries ${ids.length} case id(s) absent from the ledger (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''}) — the ledger must describe the suite that exists`,
    );
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
    warn(
      'reconciliation',
      `${c.id} has a runtime-generated title, so its only evidence is the recorded run (${c.implementation_ref})`,
    );
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
    fail(
      m.id,
      'malformed id and no test title carries it: expected PREFIX-NNN, zero-padded to three digits',
    );
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Case accounting. Seven named buckets, every case in exactly one terminal
// bucket, and every step between adjacent buckets itemised.
//
// The point is that "passing" and "countable" are different things, and so are
// "discovered" and "executed". A reader must be able to get from any one of them
// to the next without doing arithmetic of their own.
// ---------------------------------------------------------------------------

const EXECUTED_STATUSES = new Set(['passing', 'failing', 'skipped', 'quarantined']);

const accounting = {
  ledger_entries: cases.length,
  discovered: 0, // a test carrying this id exists in the tree
  planned: 0, // designed, no test written
  executed: 0, // ran in the recorded run
  not_executed: 0, // test exists, absent from the recorded run
  passing: 0,
  failing: 0,
  skipped: 0,
  quarantined: 0,
  countable: 0,
  passing_not_countable: 0,
  by_runner: { vitest: 0, playwright: 0, none: 0 },
  passing_by_runner: { vitest: 0, playwright: 0 },
};

/** Why a passing case does not count, grouped, with the ids that prove it. */
const exclusionReasons = new Map();
const noteExclusion = (reason, id) => {
  if (!exclusionReasons.has(reason)) exclusionReasons.set(reason, []);
  exclusionReasons.get(reason).push(id);
};

for (const c of cases) {
  if (c.status === 'planned') accounting.planned += 1;
  else accounting.discovered += 1;

  if (EXECUTED_STATUSES.has(c.status)) accounting.executed += 1;
  else if (c.status !== 'planned') accounting.not_executed += 1;

  if (c.status === 'passing') accounting.passing += 1;
  else if (c.status === 'failing') accounting.failing += 1;
  else if (c.status === 'skipped') accounting.skipped += 1;
  else if (c.status === 'quarantined') accounting.quarantined += 1;

  const r = c.runner === 'vitest' || c.runner === 'playwright' ? c.runner : 'none';
  accounting.by_runner[r] += 1;
  if (c.status === 'passing' && r !== 'none') accounting.passing_by_runner[r] += 1;

  if (c.status === 'passing') {
    if (c.countable === true) {
      accounting.countable += 1;
    } else {
      accounting.passing_not_countable += 1;
      const m = typeof c.id === 'string' ? /^([A-Z]+)-(\d+)$/.exec(c.id) : null;
      const prefix = m ? m[1] : '(unparseable id)';
      const digits = m ? m[2] : '';
      let reason;
      if (!Object.prototype.hasOwnProperty.call(PREFIX_CATEGORY, prefix)) {
        reason = `prefix \`${prefix}\` is outside the allowlist, so it maps to no category and no floor`;
      } else if (digits.length !== 3) {
        reason = `id number is ${digits.length} digit(s); ids are zero-padded to three`;
      } else if (digits === '000') {
        reason = 'numbering starts at 001';
      } else {
        reason = 'UNEXPLAINED — this is a bug in the ledger or in this checker';
      }
      noteExclusion(reason, c.id);
    }
  }
}

// Internal consistency. If these ever disagree the whole report is worthless.
if (accounting.discovered + accounting.planned !== cases.length) {
  fail(
    'accounting',
    `discovered (${accounting.discovered}) + planned (${accounting.planned}) != ledger entries (${cases.length})`,
  );
}
if (accounting.executed + accounting.not_executed + accounting.planned !== cases.length) {
  fail(
    'accounting',
    `executed (${accounting.executed}) + not executed (${accounting.not_executed}) + planned (${accounting.planned}) != ledger entries (${cases.length})`,
  );
}
if (
  accounting.passing + accounting.failing + accounting.skipped + accounting.quarantined !==
  accounting.executed
) {
  fail('accounting', 'passing + failing + skipped + quarantined != executed');
}
if (accounting.countable + accounting.passing_not_countable !== accounting.passing) {
  fail('accounting', 'countable + passing-not-countable != passing');
}
if (accounting.countable !== countedTotal) {
  fail(
    'accounting',
    `countable (${accounting.countable}) disagrees with the category roll-up (${countedTotal})`,
  );
}
for (const [reason, ids] of exclusionReasons) {
  if (reason.startsWith('UNEXPLAINED')) {
    fail(
      'accounting',
      `${ids.length} passing case(s) are not countable for no identifiable reason: ${ids.slice(0, 10).join(', ')}`,
    );
  }
}

const summary = {
  snapshot_commit: ledger.snapshot_commit ?? null,
  accounting,
  exclusions: Object.fromEntries(
    [...exclusionReasons].map(([reason, ids]) => [reason, { count: ids.length, ids }]),
  ),
  ledger_entries: cases.length,
  counted_passing: countedTotal,
  total_minimum: TOTAL_MINIMUM,
  floor_met_overall: countedTotal >= TOTAL_MINIMUM,
  /** The twelve floors, exported so a consumer never has to restate them. */
  category_minimums: CATEGORY_MINIMUM,
  prefix_categories: PREFIX_CATEGORY,
  categories_below_floor: shortfalls,
  by_category: Object.fromEntries(
    [...CATEGORY_ORDER, UNASSIGNED].map((k) => [k, byCategory.get(k)]),
  ),
  by_level: Object.fromEntries([...byLevel]),
  by_status: Object.fromEntries([...statusCounts].sort()),
  provider_backed: providerBacked,
  category_overrides: categoryOverrides,
  cross_references_in_titles: crossReferences.length,
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
  console.log(
    `  ledger      docs/test-cases.json (generated ${ledger.generated_at}${ledger.snapshot_commit ? `, snapshot ${ledger.snapshot_commit}` : ''})`,
  );
  console.log(`  test tree   tests/ — ${testFiles.length} file(s) scanned`);
  console.log(`  reading of  ${treeLabel()}`);
  console.log('  NOT a gate result. The gate number is produced by CI on a clean checkout and');
  console.log('  lives in the release-gate-<sha> artefact; scripts/release.mjs enforces that.');
  console.log('');
  console.log(
    `  ${pad('category', 30)}${lp('total', 7)}${lp('pass', 7)}${lp('fail', 6)}${lp('plan', 6)}${lp('unmeas', 8)}${lp('min', 6)}${lp('COUNTED', 9)}  verdict`,
  );
  console.log(`  ${'-'.repeat(30)}${'-'.repeat(49)}  -------`);
  for (const category of CATEGORY_ORDER) {
    const b = byCategory.get(category);
    const min = CATEGORY_MINIMUM[category];
    const v = b.counted >= min ? 'ok' : `SHORT by ${min - b.counted}`;
    console.log(
      `  ${pad(category, 30)}${lp(b.total, 7)}${lp(b.passing, 7)}${lp(b.failing, 6)}${lp(b.planned, 6)}${lp(b.implemented, 8)}${lp(min, 6)}${lp(b.counted, 9)}  ${v}`,
    );
  }
  const u = byCategory.get(UNASSIGNED);
  if (u.total > 0) {
    console.log(
      `  ${pad(UNASSIGNED + ' (off-allowlist)', 30)}${lp(u.total, 7)}${lp(u.passing, 7)}${lp(u.failing, 6)}${lp(u.planned, 6)}${lp(u.implemented, 8)}${lp('-', 6)}${lp(0, 9)}  NOT COUNTABLE`,
    );
  }
  console.log(`  ${'-'.repeat(88)}`);
  console.log(
    `  ${pad('TOTAL', 30)}${lp(cases.length, 7)}${lp(statusCounts.get('passing') ?? 0, 7)}${lp(statusCounts.get('failing') ?? 0, 6)}${lp(statusCounts.get('planned') ?? 0, 6)}${lp(statusCounts.get('implemented') ?? 0, 8)}${lp(TOTAL_MINIMUM, 6)}${lp(countedTotal, 9)}  ${countedTotal >= TOTAL_MINIMUM ? 'floor met' : 'FLOOR NOT MET'}`,
  );
  console.log('');
  console.log(
    `  levels      ${[...byLevel]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')}`,
  );
  console.log(
    `  provider    ${providerBacked} provider-backed case(s), cap ${PROVIDER_BACKED_CAP}`,
  );
  const explicit = cases.filter(
    (c) => typeof c?.category === 'string' && c.category.trim() !== '',
  ).length;
  const noDefault = Object.entries(PREFIX_CATEGORY)
    .filter(([, v]) => v === null)
    .map(([k]) => k);
  console.log(
    `  category    ${explicit} case(s) declare a category explicitly; the rest take their prefix default`,
  );
  if (noDefault.length > 0) {
    console.log(
      `              prefix ${noDefault.map((p) => `\`${p}\``).join(', ')} has no default — every such case must declare one`,
    );
  }
  if (categoryOverrides.length > 0) {
    console.log(
      `              ${categoryOverrides.length} case(s) override a prefix default: ${categoryOverrides
        .slice(0, 6)
        .map((o) => `${o.id} ${o.from}→${o.to}`)
        .join(', ')}${categoryOverrides.length > 6 ? ', …' : ''}`,
    );
  }
  if (crossReferences.length > 0) {
    console.log(
      `  references  ${crossReferences.length} title(s) mention another case id after their own; a mention is not an implementation`,
    );
    for (const r of crossReferences.slice(0, 6))
      console.log(`              ${r.id} referenced by ${r.in ?? '(untitled)'} in ${r.file}`);
  }
  console.log('');
  console.log('  Counted = countable AND status passing. A skip, a quarantine, an unmeasured');
  console.log('  case and an off-allowlist prefix are all worth zero.');
  console.log('');
  if (shortfalls.length > 0) {
    console.log(`  ${shortfalls.length} category/categories below floor:`);
    for (const s of shortfalls)
      console.log(
        `    ${s.category}: ${s.counted} counted against a floor of ${s.minimum} (short by ${s.short})`,
      );
    console.log('');
  }
  const n = (v) => String(v).padStart(6);
  console.log('  Case accounting — one release commit, one terminal bucket per case');
  console.log('');
  console.log(
    `    discovered   (a test carrying the id exists)        ${n(accounting.discovered)}`,
  );
  console.log(`  + planned      (designed, no test written yet)        ${n(accounting.planned)}`);
  console.log(`  = ledger entries                                      ${n(cases.length)}`);
  console.log('');
  console.log(
    `    discovered                                          ${n(accounting.discovered)}`,
  );
  console.log(`      executed     (ran in the recorded run)            ${n(accounting.executed)}`);
  console.log(
    `      not executed (exists, absent from that run)       ${n(accounting.not_executed)}`,
  );
  console.log('');
  console.log(`    executed                                            ${n(accounting.executed)}`);
  console.log(`      passing                                           ${n(accounting.passing)}`);
  console.log(`      failing                                           ${n(accounting.failing)}`);
  console.log(`      skipped      (declared skip)                      ${n(accounting.skipped)}`);
  console.log(
    `      quarantined  (known flaky, excluded)              ${n(accounting.quarantined)}`,
  );
  console.log('');
  console.log(`    passing                                             ${n(accounting.passing)}`);
  console.log(`      countable    (counts toward the 500 floor)        ${n(accounting.countable)}`);
  console.log(
    `      excluded                                          ${n(accounting.passing_not_countable)}`,
  );
  if (exclusionReasons.size === 0) {
    console.log('        (none — every passing case counts)');
  } else {
    for (const [reason, ids] of [...exclusionReasons].sort((a, b) => b[1].length - a[1].length)) {
      const byPrefix = new Map();
      for (const id of ids) {
        const p = String(id).split('-')[0];
        byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
      }
      console.log(`        ${String(ids.length).padStart(4)}  ${reason}`);
      console.log(
        `              ${[...byPrefix]
          .sort()
          .map(([p, c]) => `${p}=${c}`)
          .join(', ')}  e.g. ${ids.slice(0, 4).join(', ')}`,
      );
    }
  }
  console.log('');
  console.log(
    `    by runner    vitest=${accounting.by_runner.vitest}  playwright=${accounting.by_runner.playwright}  not-run=${accounting.by_runner.none}`,
  );
  console.log(
    `    passing      vitest=${accounting.passing_by_runner.vitest}  playwright=${accounting.passing_by_runner.playwright}`,
  );
  console.log(
    `    The vitest-only passing figure (${accounting.passing_by_runner.vitest}) is what`,
  );
  console.log('    scripts/build-test-report.mjs reports: it does not read the Playwright run.');
  console.log('');
  console.log('  Reconciliation (ledger vs case ids in test titles)');
  console.log(`    in the ledger                ${plannedIds.size}`);
  console.log(`    in the test tree             ${implementedIds.size}`);
  console.log(`    in both                      ${both.length}`);
  console.log(`    in the tree, not the ledger  ${implementedNotPlanned.length}`);
  console.log(`    in the ledger, not the tree  ${plannedNotImplemented.length}`);
  console.log('');
}

if (defects.length > 0 && !AS_JSON) {
  console.log(
    `  ${defects.length} reconciliation defect(s)${STRICT ? ' (fatal under --strict)' : ' (not fatal without --strict)'}:`,
  );
  for (const d of defects.slice(0, WARN_SAMPLE))
    console.log(`    DEFECT  [${d.where}] ${d.message}`);
  if (defects.length > WARN_SAMPLE) console.log(`    …and ${defects.length - WARN_SAMPLE} more`);
  console.log('');
}
if (warnings.length > 0 && !AS_JSON && !QUIET) {
  console.log(`  ${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, WARN_SAMPLE))
    console.log(`    WARN  [${w.where}] ${w.message}`);
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
  console.error(
    `  --gate: ${shortfalls.length} category/categories are below their floor on cases that actually passed.`,
  );
  process.exit(1);
}

if (!AS_JSON) {
  const caveats = [];
  if (defects.length > 0) caveats.push(`${defects.length} reconciliation defect(s)`);
  if (shortfalls.length > 0) caveats.push(`${shortfalls.length} category/categories below floor`);
  console.log(
    `  Ledger integrity: PASS${caveats.length > 0 ? `  (outstanding: ${caveats.join('; ')} — run --strict --gate at the release gate)` : ''}`,
  );
  console.log(
    '  A sound ledger proves the count is honest. It does not make a failing suite green.',
  );
  console.log(`  These totals are a reading of ${treeLabel()} — not a gate result.`);
  console.log('');
}
process.exit(0);
