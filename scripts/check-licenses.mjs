#!/usr/bin/env node
/**
 * Dependency licence auditor.
 *
 * This repository is permanently public and the owner has deliberately not granted
 * a reuse licence ("All rights reserved"). That position only holds if no dependency
 * imposes an obligation the owner has not knowingly accepted. A copyleft library
 * bundled into the Worker is a real problem; a copyleft build tool that never ships
 * is a very different, much smaller one. This script tells the two apart.
 *
 *   node scripts/check-licenses.mjs
 *
 * Exit code 1 means: a strong-copyleft or unknown licence is in the PRODUCTION
 * dependency set (reachable from a workspace package's `dependencies`). Do not
 * release until a human has looked at it. Development-only findings are printed
 * as warnings and do not fail the run.
 *
 * The full result is written to reports/licenses.json.
 *
 * Uses only Node built-ins. Do not add a dependency to the tool that audits
 * dependencies.
 */
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const ROOT = resolve(process.cwd());
const STORE = join(ROOT, 'node_modules', '.pnpm');
const REPORT_DIR = join(ROOT, 'reports');
const REPORT = join(REPORT_DIR, 'licenses.json');

/**
 * SPDX identifiers grouped by what they oblige us to do. Anything not listed here
 * is `unknown`, on purpose: an unrecognised string means a human has not looked
 * at it yet, and the tool must not pretend otherwise.
 */
const PERMISSIVE = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Python-2.0',
  // Uncontroversial additions that appear in real trees and impose nothing beyond attribution.
  'MIT-0',
  'Zlib',
  'WTFPL',
  'CC-BY-4.0',
  'CC-BY-3.0',
]);
const WEAK_COPYLEFT_PREFIXES = ['MPL-', 'LGPL-', 'EPL-', 'CDDL-'];
const STRONG_COPYLEFT_PREFIXES = ['GPL-', 'AGPL-'];
const CUSTOM = new Set(['UNLICENSED']);

/** Legacy spellings that predate SPDX but whose meaning is not in doubt. */
const ALIASES = {
  'Apache 2.0': 'Apache-2.0',
  'Apache-2': 'Apache-2.0',
  'Apache License 2.0': 'Apache-2.0',
  'Apache License, Version 2.0': 'Apache-2.0',
  'BSD-3': 'BSD-3-Clause',
  'BSD-2': 'BSD-2-Clause',
  'MIT/X11': 'MIT',
  'GPL-2.0+': 'GPL-2.0-or-later',
  'GPL-3.0+': 'GPL-3.0-or-later',
  'LGPL-2.1+': 'LGPL-2.1-or-later',
  'LGPL-3.0+': 'LGPL-3.0-or-later',
  CC0: 'CC0-1.0',
  'Public Domain': 'Unlicense',
};

/** Lower is better. Used to pick the friendliest side of an OR and the strictest side of an AND. */
const SEVERITY = {
  permissive: 0,
  weak_copyleft: 1,
  custom: 2,
  strong_copyleft: 3,
  unknown: 4,
};
const CLASSES = Object.keys(SEVERITY);

const LICENCE_FILE_RE = /^(LICEN[CS]E|COPYING)(\..*)?$/i;

// ---------------------------------------------------------------------------
// Licence classification
// ---------------------------------------------------------------------------

function classifyId(rawId) {
  let id = rawId.trim();
  id = ALIASES[id] ?? id;
  // "GPL-2.0 WITH Classpath-exception-2.0": the exception softens terms but does
  // not change the family. Classify the base identifier.
  const withIdx = id.search(/\s+WITH\s+/i);
  if (withIdx !== -1) id = id.slice(0, withIdx).trim();
  if (id.endsWith('+')) id = id.slice(0, -1);

  if (PERMISSIVE.has(id)) return 'permissive';
  if (CUSTOM.has(id) || /^SEE LICEN[CS]E IN\b/i.test(id)) return 'custom';
  const upper = id.toUpperCase();
  if (STRONG_COPYLEFT_PREFIXES.some((p) => upper.startsWith(p))) return 'strong_copyleft';
  if (WEAK_COPYLEFT_PREFIXES.some((p) => upper.startsWith(p))) return 'weak_copyleft';
  return 'unknown';
}

/**
 * Classifies an SPDX expression such as "(MIT OR Apache-2.0)" or "MIT AND LGPL-2.1-only".
 * A tiny recursive-descent walk: OR lets us choose, so it takes the best branch;
 * AND binds us to both, so it takes the worst.
 */
function classifyExpression(rawExpr) {
  // Multi-word legacy spellings ("Apache 2.0") must be normalised before tokenising.
  const expr = ALIASES[rawExpr.trim()] ?? rawExpr;
  const tokens = expr.match(/\(|\)|\bOR\b|\bAND\b|[^\s()]+(?:\s+WITH\s+[^\s()]+)?/gi) ?? [];
  let pos = 0;
  let malformed = false;

  function parseOr() {
    let cls = parseAnd();
    while (pos < tokens.length && tokens[pos].toUpperCase() === 'OR') {
      pos++;
      const rhs = parseAnd();
      cls = SEVERITY[rhs] < SEVERITY[cls] ? rhs : cls;
    }
    return cls;
  }
  function parseAnd() {
    let cls = parseAtom();
    while (pos < tokens.length && tokens[pos].toUpperCase() === 'AND') {
      pos++;
      const rhs = parseAtom();
      cls = SEVERITY[rhs] > SEVERITY[cls] ? rhs : cls;
    }
    return cls;
  }
  function parseAtom() {
    const t = tokens[pos++];
    if (t === undefined) return 'unknown';
    if (t === '(') {
      const inner = parseOr();
      if (tokens[pos] === ')') pos++;
      else malformed = true;
      return inner;
    }
    if (t === ')') {
      malformed = true;
      return 'unknown';
    }
    return classifyId(t);
  }

  const cls = parseOr();
  // Anything we could not parse to the end is not something we understood.
  return pos === tokens.length && !malformed ? cls : 'unknown';
}

/**
 * Turns the assorted shapes a package.json can carry into one declared string
 * plus a classification. Returns { declared, classification, note }.
 */
function readLicence(pkg, pkgDir) {
  const field = pkg.license ?? pkg.licence;
  let declared = null;
  let note = null;

  if (typeof field === 'string' && field.trim() !== '') {
    declared = field.trim();
  } else if (field && typeof field === 'object' && typeof field.type === 'string') {
    declared = field.type.trim();
    note = 'deprecated object form of "license"';
  } else if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    const types = pkg.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (types.length > 0) {
      // The old array form meant "any of these".
      declared = types.length === 1 ? types[0] : `(${types.join(' OR ')})`;
      note = 'deprecated "licenses" array';
    }
  }

  if (declared === null) {
    const files = safeReaddir(pkgDir).filter((f) => LICENCE_FILE_RE.test(f));
    if (files.length > 0) {
      return {
        declared: null,
        classification: 'unknown',
        note: `no "license" field; ${files.join(', ')} exists in the package but the declaration is missing — read it yourself, this tool does not guess from prose`,
      };
    }
    return {
      declared: null,
      classification: 'unknown',
      note: 'no "license" field and no licence file',
    };
  }

  if (/^SEE LICEN[CS]E IN\b/i.test(declared)) {
    return {
      declared,
      classification: 'custom',
      note: 'bespoke terms; read the referenced file',
    };
  }
  return { declared, classification: classifyExpression(declared), note };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isRealDir(p) {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/** Path key for comparisons: resolved, and case-folded on Windows where the filesystem is. */
function pathKey(p) {
  const r = resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

function tryRealpath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Enumerate every installed package from the pnpm virtual store.
// ---------------------------------------------------------------------------

if (!existsSync(STORE)) {
  console.error(`check:licenses — ${STORE} does not exist. Run "pnpm install" first.`);
  process.exit(1);
}

/**
 * Store directories are named "<name>@<version>" with "/" in scoped names replaced
 * by "+", and long names truncated to a hash ("@cloudflare+unenv-preset@2._<hash>").
 * The name in the directory is therefore not trustworthy; the package.json is. Each
 * store entry holds exactly one real directory under node_modules/ — the package —
 * and symlinks to its dependencies alongside it.
 */
function findOwnPackageDirs(storeEntryNodeModules) {
  const found = [];
  for (const entry of safeReaddir(storeEntryNodeModules)) {
    const p = join(storeEntryNodeModules, entry);
    if (!isRealDir(p)) continue;
    if (entry.startsWith('@')) {
      for (const inner of safeReaddir(p)) {
        const q = join(p, inner);
        if (isRealDir(q) && existsSync(join(q, 'package.json'))) found.push(q);
      }
    } else if (existsSync(join(p, 'package.json'))) {
      found.push(p);
    }
  }
  return found;
}

/** @type {Map<string, object>} keyed by pathKey(pkgDir) */
const packages = new Map();
const enumerationProblems = [];

for (const storeEntry of safeReaddir(STORE)) {
  if (storeEntry === 'node_modules' || storeEntry === 'lock.yaml') continue;
  const nm = join(STORE, storeEntry, 'node_modules');
  if (!isRealDir(nm)) continue;
  const dirs = findOwnPackageDirs(nm);
  if (dirs.length === 0) {
    enumerationProblems.push(`${storeEntry}: no package directory found under node_modules/`);
    continue;
  }
  for (const dir of dirs) {
    let pkg;
    try {
      pkg = readJson(join(dir, 'package.json'));
    } catch (err) {
      enumerationProblems.push(`${storeEntry}: package.json unreadable (${err.message})`);
      continue;
    }
    const lic = readLicence(pkg, dir);
    packages.set(pathKey(dir), {
      name: pkg.name ?? storeEntry,
      version: pkg.version ?? 'unknown',
      store_entry: storeEntry,
      dir,
      declared: lic.declared,
      classification: lic.classification,
      note: lic.note,
      scope: 'dev', // promoted to "production" by the graph walk below
      dependencies: {
        ...(pkg.dependencies ?? {}),
        ...(pkg.optionalDependencies ?? {}),
      },
      optional: new Set(Object.keys(pkg.optionalDependencies ?? {})),
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Walk the production graph from each workspace package's `dependencies`.
// ---------------------------------------------------------------------------

function workspacePackageDirs() {
  const dirs = [ROOT];
  let globs = ['apps/*', 'packages/*'];
  const wsFile = join(ROOT, 'pnpm-workspace.yaml');
  if (existsSync(wsFile)) {
    // Minimal YAML: we only need the "packages:" list of "dir/*" globs.
    const lines = readFileSync(wsFile, 'utf8').split('\n');
    const start = lines.findIndex((l) => /^packages:\s*$/.test(l));
    if (start !== -1) {
      const parsed = [];
      for (const l of lines.slice(start + 1)) {
        const m = /^\s+-\s+['"]?([^'"#]+?)['"]?\s*$/.exec(l);
        if (!m) break;
        parsed.push(m[1]);
      }
      if (parsed.length > 0) globs = parsed;
    }
  }
  for (const g of globs) {
    if (g.startsWith('!')) continue;
    if (g.endsWith('/*')) {
      const parent = join(ROOT, g.slice(0, -2));
      for (const e of safeReaddir(parent)) {
        const d = join(parent, e);
        if (isRealDir(d) && existsSync(join(d, 'package.json'))) dirs.push(d);
      }
    } else if (existsSync(join(ROOT, g, 'package.json'))) {
      dirs.push(join(ROOT, g));
    }
  }
  return dirs;
}

const workspaceDirs = workspacePackageDirs();
const workspaceKeys = new Set(workspaceDirs.map(pathKey));
const unresolved = []; // { from, dep, reason }
const visited = new Set();

/**
 * Where Node would look for `depName` when required from `fromDir`. pnpm puts a
 * package's dependencies as symlinks next to it in the store, so the sibling
 * node_modules/ is the primary location; the store-level and root node_modules/
 * are where pnpm hoists unmet peers.
 */
function candidatePaths(fromDir, depName) {
  const fromIsWorkspace = workspaceKeys.has(pathKey(fromDir));
  const out = [join(fromDir, 'node_modules', depName)];
  if (!fromIsWorkspace) {
    // fromDir is .../node_modules/<name> or .../node_modules/@scope/<name>
    const nm = fromDir.split(sep).includes('node_modules')
      ? fromDir.slice(0, fromDir.lastIndexOf(`${sep}node_modules${sep}`) + `${sep}node_modules`.length)
      : null;
    if (nm) out.push(join(nm, depName));
  }
  out.push(join(STORE, 'node_modules', depName));
  out.push(join(ROOT, 'node_modules', depName));
  return out;
}

function walkProduction(fromDir, deps, optionalNames, label) {
  for (const depName of Object.keys(deps)) {
    if (deps[depName]?.startsWith?.('workspace:') && !existsSync(join(fromDir, 'node_modules', depName))) {
      // Workspace link not installed; resolve by name among workspace dirs.
      const target = workspaceDirs.find((d) => {
        try {
          return readJson(join(d, 'package.json')).name === depName;
        } catch {
          return false;
        }
      });
      if (target) {
        visitWorkspace(target);
        continue;
      }
    }
    let real = null;
    for (const c of candidatePaths(fromDir, depName)) {
      real = tryRealpath(c);
      if (real) break;
    }
    if (!real) {
      if (optionalNames.has(depName)) continue; // optional and absent: platform binary for another OS, typically
      unresolved.push({
        from: label,
        dep: depName,
        reason: 'not found on disk',
      });
      continue;
    }
    const key = pathKey(real);
    if (workspaceKeys.has(key)) {
      visitWorkspace(real);
      continue;
    }
    const entry = packages.get(key);
    if (!entry) {
      unresolved.push({
        from: label,
        dep: depName,
        reason: `resolved to ${real}, which is not in the pnpm store`,
      });
      continue;
    }
    entry.scope = 'production';
    if (visited.has(key)) continue;
    visited.add(key);
    walkProduction(entry.dir, entry.dependencies, entry.optional, `${entry.name}@${entry.version}`);
  }
}

function visitWorkspace(dir) {
  const key = pathKey(dir);
  if (visited.has(key)) return;
  visited.add(key);
  let pkg;
  try {
    pkg = readJson(join(dir, 'package.json'));
  } catch {
    return;
  }
  // Only `dependencies` ship. devDependencies are tooling and stay dev-only.
  const deps = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
  };
  walkProduction(dir, deps, new Set(Object.keys(pkg.optionalDependencies ?? {})), pkg.name ?? dir);
}

for (const d of workspaceDirs) visitWorkspace(d);

const productionDetermination = unresolved.length === 0 ? 'complete' : 'incomplete';

// ---------------------------------------------------------------------------
// 3. Summarise, write the report, decide the exit code.
// ---------------------------------------------------------------------------

const all = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
for (const p of all) counts[p.classification]++;

const nonPermissive = all.filter((p) => p.classification !== 'permissive');
const blocking = nonPermissive.filter(
  (p) => p.scope === 'production' && (p.classification === 'strong_copyleft' || p.classification === 'unknown'),
);
const productionWeak = nonPermissive.filter((p) => p.scope === 'production' && p.classification === 'weak_copyleft');
const productionCustom = nonPermissive.filter((p) => p.scope === 'production' && p.classification === 'custom');

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(
  REPORT,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      root: ROOT,
      package_count: all.length,
      counts,
      production_count: all.filter((p) => p.scope === 'production').length,
      production_determination: productionDetermination,
      unresolved_production_edges: unresolved,
      enumeration_problems: enumerationProblems,
      blocking: blocking.map((p) => `${p.name}@${p.version}`),
      packages: all.map((p) => ({
        name: p.name,
        version: p.version,
        declared_licence: p.declared,
        classification: p.classification,
        scope: p.scope,
        note: p.note,
        path: p.dir,
      })),
    },
    null,
    2,
  ) + '\n',
);

console.log(`check:licenses — ${all.length} installed package(s) in ${STORE}`);
for (const c of CLASSES) console.log(`  ${c.padEnd(18)} ${counts[c]}`);
console.log(
  `  production set: ${all.filter((p) => p.scope === 'production').length} package(s), determination ${productionDetermination}`,
);

if (enumerationProblems.length > 0) {
  console.log(`\n  WARN  ${enumerationProblems.length} store entr(ies) could not be read:`);
  for (const e of enumerationProblems) console.log(`        ${e}`);
}

if (unresolved.length > 0) {
  console.log(
    `\n  WARN  production/dev split is INCOMPLETE. ${unresolved.length} dependency edge(s) could not be resolved, so some packages marked "dev" may in fact ship:`,
  );
  for (const u of unresolved) console.log(`        ${u.from} -> ${u.dep}: ${u.reason}`);
}

if (nonPermissive.length > 0) {
  console.log('\nEverything that is not permissive:\n');
  const rows = nonPermissive.map((p) => [
    p.name,
    p.version,
    p.declared ?? '(none declared)',
    p.classification,
    p.scope === 'production' ? 'PRODUCTION' : 'dev-only',
  ]);
  const head = ['package', 'version', 'licence', 'class', 'scope'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const fmt = (r) => '  ' + r.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(fmt(head));
  console.log(fmt(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(fmt(r));
  for (const p of nonPermissive) if (p.note) console.log(`\n  note  ${p.name}@${p.version}: ${p.note}`);
} else {
  console.log('\nEvery installed package declares a permissive licence.');
}

console.log(`\nFull result written to ${REPORT}`);

if (blocking.length > 0) {
  console.error(
    `\ncheck:licenses — ${blocking.length} PRODUCTION package(s) carry a strong-copyleft or unknown licence. DO NOT RELEASE until a human has read the terms:`,
  );
  for (const p of blocking)
    console.error(`  ${p.name}@${p.version}  ${p.declared ?? '(none declared)'}  [${p.classification}]`);
  console.error(
    "\nEither replace the package, or record the owner's explicit acceptance of the obligation in docs/ and add the SPDX identifier to the classification table in this script.",
  );
  process.exit(1);
}

if (productionWeak.length > 0 || productionCustom.length > 0) {
  console.log(
    '\nNo blocking finding, but the production set contains weak-copyleft or bespoke terms. Confirm the owner has accepted them.',
  );
}
if (productionDetermination === 'incomplete') {
  console.log(
    '\ncheck:licenses — passed with caveats. The production set could not be fully determined; see the warning above.',
  );
} else {
  console.log('\ncheck:licenses — no strong-copyleft or unknown licence in the production set.');
}
process.exit(0);
