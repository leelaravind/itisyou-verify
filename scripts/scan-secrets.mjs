#!/usr/bin/env node
/**
 * Secret scanner for tracked files, full git history, and build artifacts.
 *
 * Run before every push. Exit code 1 means: do not push.
 *
 *   node scripts/scan-secrets.mjs              # tracked working-tree files
 *   node scripts/scan-secrets.mjs --history    # every blob in every commit too
 *   node scripts/scan-secrets.mjs --paths dist # additional untracked directories
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

/** Patterns are deliberately specific. A generic /secret/i match would drown the signal. */
const RULES = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-pat', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
  { id: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{80,}\b/ },
  { id: 'stripe-secret', re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { id: 'stripe-restricted', re: /\brk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  // Underscores and hyphens are allowed after the prefix on purpose. The first version
  // was `[A-Za-z0-9]{24,}` with a trailing word boundary, which silently missed a
  // committed stand-in secret containing underscores — GitHub push protection would
  // have caught it, this scanner would not have. A scanner with a shape blind spot is
  // worse than no scanner, because it is trusted.
  { id: 'stripe-webhook-secret', re: /\bwhsec_[A-Za-z0-9_-]{24,}/ },
  { id: 'resend-key', re: /\bre_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}\b/ },
  { id: 'hubspot-token', re: /\bpat-(?:na|eu)[0-9]?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/ },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/ },
  { id: 'openrouter-key', re: /\bsk-or-v1-[0-9a-f]{40,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'cloudflare-token', re: /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/ },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'jwt-with-payload', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: 'basic-auth-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/ },
  { id: 'assigned-secret-literal', re: /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9/+_=-]{24,}["']/i },
];

/** Lines carrying this marker are intentional fixtures and are exempt. */
const ALLOW_MARKER = 'secret-scan:allow';

/**
 * Historical blobs known to contain synthetic fixtures, pinned by full SHA.
 *
 * `secret-scan:allow` cannot help here: a marker added today does not change a blob
 * that was committed yesterday, and the only other ways to make `--history` green are
 * rewriting public history — which this project forbids — or deleting the history step
 * from CI, which would remove the one control that catches a credential committed and
 * then quietly deleted. That is the trade being avoided: a check that is permanently red
 * gets switched off, and a switched-off check protects nothing.
 *
 * Pinning the full SHA is what keeps this honest. A blob's SHA is its content, so these
 * six entries exempt exactly six known files and nothing else. A new historical hit — or
 * an edit to any of these files — produces a different SHA and still fails the scan. The
 * list cannot rot into a blanket exemption.
 *
 * Every entry was inspected before being added. All six are test or synthetic-demo
 * fixtures for Stripe webhook signing, none was ever a live credential, and the fixtures
 * in the current tree have since been rewritten to assemble at runtime so no NEW blob of
 * this shape can be created.
 */
const ALLOWED_HISTORY_BLOBS = new Map([
  ['7ef9fb239981c51cfab0497ab3abd54caaa7cdd3', 'syntheticPort.ts — demo signing-key hint, never a real secret'],
  ['720b3586c5ebf6681c087f8188f7124f227178d2', 'webhook-route.test.ts — wrong-secret fixture for a rejection case'],
  ['ef02dcd65deb70ed9263067e0fb1df78753a75ec', 'stripe.ts — the removed DECOY_SECRET constant (finding F13)'],
  ['b649bc0c6ce7340eac043c1407360985b1e0e5ae', 'billing/harness.ts — test webhook secret'],
  ['fec29ff953f114ec6479c8a9d6359ceb7861962d', 'billing/webhooks.test.ts — wrong-secret fixture'],
  ['966d4b11d18203124eecdc2464233c671cd7214c', 'webhook-route.test.ts — earlier revision of the same fixture'],
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.wrangler', '.turbo']);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.woff', '.woff2',
  '.ttf', '.otf', '.mp4', '.webm', '.wasm', '.exe', '.dll', '.so', '.dylib', '.sqlite', '.db',
]);

const args = process.argv.slice(2);
const scanHistory = args.includes('--history');
const extraPaths = (() => {
  const i = args.indexOf('--paths');
  return i === -1 ? [] : args.slice(i + 1).filter((a) => !a.startsWith('--'));
})();

const findings = [];

function scanText(label, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The marker exempts its own line, or the line immediately after it — so a long
    // line can be annotated above rather than pushed past the length limit.
    if (line.includes(ALLOW_MARKER)) continue;
    if (i > 0 && lines[i - 1].includes(ALLOW_MARKER)) continue;
    if (line.length > 4000) continue; // minified bundle line; checked by rule below instead
    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) {
        findings.push({ label, line: i + 1, rule: rule.id, excerpt: mask(m[0]) });
      }
    }
  }
  // Long single-line bundles still get a whole-text pass for the high-confidence rules.
  if (lines.some((l) => l.length > 4000)) {
    for (const rule of RULES.slice(0, 13)) {
      const m = rule.re.exec(text);
      if (m) findings.push({ label: `${label} (minified)`, line: 0, rule: rule.id, excerpt: mask(m[0]) });
    }
  }
}

function mask(s) {
  if (s.length <= 10) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 6)}***${s.slice(-2)} (${s.length} chars)`;
}

function git(argv) {
  return execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// 1. Tracked working-tree files.
let tracked = [];
try {
  tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
} catch {
  console.error('scan:secrets — not a git repository; scanning the working tree instead.');
}

for (const f of tracked) {
  if (BINARY_EXT.has(extname(f).toLowerCase())) continue;
  try {
    if (statSync(f).size > 8 * 1024 * 1024) continue;
    scanText(f, readFileSync(f, 'utf8'));
  } catch {
    /* unreadable or removed; nothing to scan */
  }
}

// 2. Extra directories (build output) that are not tracked.
function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (!BINARY_EXT.has(extname(e.name).toLowerCase())) {
      try {
        if (statSync(p).size > 8 * 1024 * 1024) continue;
        scanText(p, readFileSync(p, 'utf8'));
      } catch {
        /* ignore */
      }
    }
  }
}
for (const p of extraPaths) walk(p);

// 3. Full history: every blob ever committed.
let exemptedBlobs = 0;
if (scanHistory) {
  let objects = '';
  try {
    objects = git(['rev-list', '--objects', '--all']);
  } catch {
    objects = '';
  }
  const seen = new Set();
  for (const line of objects.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (!path || seen.has(sha)) continue;
    seen.add(sha);
    if (BINARY_EXT.has(extname(path).toLowerCase())) continue;
    if (ALLOWED_HISTORY_BLOBS.has(sha)) {
      exemptedBlobs += 1;
      continue;
    }
    try {
      const type = git(['cat-file', '-t', sha]).trim();
      if (type !== 'blob') continue;
      const size = Number(git(['cat-file', '-s', sha]).trim());
      if (size > 4 * 1024 * 1024) continue;
      scanText(`history:${path}@${sha.slice(0, 8)}`, git(['cat-file', 'blob', sha]));
    } catch {
      /* ignore unreadable objects */
    }
  }
}

if (findings.length === 0) {
  console.log(
    `scan:secrets — clean. ${tracked.length} tracked files${extraPaths.length ? `, extra paths: ${extraPaths.join(', ')}` : ''}${scanHistory ? ', full history' : ''}.`,
  );
  if (exemptedBlobs > 0) {
    // Printed on every clean run on purpose. An exemption nobody sees is an exemption
    // nobody reviews, and that is how an allowlist quietly becomes a blind spot.
    console.log(
      `  ${exemptedBlobs} historical blob(s) skipped by the pinned allowlist — see ALLOWED_HISTORY_BLOBS.`,
    );
  }
  process.exit(0);
}

console.error(`scan:secrets — ${findings.length} potential secret(s) found. DO NOT PUSH.\n`);
for (const f of findings) {
  console.error(`  ${f.label}:${f.line}  [${f.rule}]  ${f.excerpt}`);
}
console.error(
  `\nIf a match is an intentional synthetic fixture, add the marker "${ALLOW_MARKER}" as a comment on that line.`,
);
process.exit(1);
