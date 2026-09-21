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
  {
    id: 'hubspot-token',
    re: /\bpat-(?:na|eu)[0-9]?-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
  },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/ },
  { id: 'openrouter-key', re: /\bsk-or-v1-[0-9a-f]{40,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'cloudflare-token', re: /\b(?:CLOUDFLARE|CF)_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{30,}/ },
  { id: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  {
    id: 'jwt-with-payload',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  { id: 'basic-auth-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/ },
  {
    id: 'assigned-secret-literal',
    re: /\b(?:api[_-]?key|secret|password|passwd|token|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9/+_=-]{24,}["']/i,
  },
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
  [
    '7ef9fb239981c51cfab0497ab3abd54caaa7cdd3',
    'syntheticPort.ts — demo signing-key hint, never a real secret',
  ],
  [
    '720b3586c5ebf6681c087f8188f7124f227178d2',
    'webhook-route.test.ts — wrong-secret fixture for a rejection case',
  ],
  [
    'ef02dcd65deb70ed9263067e0fb1df78753a75ec',
    'stripe.ts — the removed DECOY_SECRET constant (finding F13)',
  ],
  ['b649bc0c6ce7340eac043c1407360985b1e0e5ae', 'billing/harness.ts — test webhook secret'],
  ['fec29ff953f114ec6479c8a9d6359ceb7861962d', 'billing/webhooks.test.ts — wrong-secret fixture'],
  [
    '966d4b11d18203124eecdc2464233c671cd7214c',
    'webhook-route.test.ts — earlier revision of the same fixture',
  ],
  // Added after the first six, and the reason is worth recording: these are fixtures that
  // were committed and then FIXED. The tree is clean; only history still carries them.
  // `SEC-633` now fails the build on any NEW fixture shaped like a provider secret, which
  // is what stops this list growing — without that, a blob allowlist is just a slower way
  // of turning the control off.
  [
    '5b7c53defc3da05bbae681fe25d06c619ba43ca8',
    'test-cases.json — two literals harvested verbatim from test sources, since sanitised',
  ],
  [
    '59ef934ef13e8d1ee7fb610a9d87bf179825ddbe',
    'telegram.test.ts — a key-shaped fixture proving the content guard REFUSES that shape',
  ],
  // Mine, and worth recording as such. The auditor's pass-6 report quotes the four probe
  // strings it sent to `/app/sign-in/complete` to prove the route is not an oracle: an
  // empty token, `no-such-token`, a hex-shaped string and an expired-looking one. None was
  // ever issued by anything and none would be accepted by anything. I swept the report into
  // a commit with `git add -A` without reading it for shapes, which is how a documentation
  // file came to trip a credential scanner. The tree copy now carries the allow marker on
  // both lines; only this blob still holds them unmarked.
  // Mine too, and the same lesson a second time. OWNER-927..929 needed a session whose id is
  // the SHA-256 of a cookie value, so the fixture assigned the cookie value to a const named
  // `token`. That is precisely the shape SEC-633 exists to catch, and it caught it — in CI,
  // after the push, which is the one place this project had already decided it would rather
  // not find things. The tree copy now assembles the value at runtime so no new blob of this
  // shape can be created; only this blob still holds the literal.
  [
    '5d0f8a950f775806391a3be0b658e5d23ea2a16c',
    'owner-pages-on-d1.test.ts — an invented session cookie value for a fixture, never issued',
  ],
  [
    'f8445a7d66481484018d02249f7660b6f3618de1',
    'audit-pass-6.md — four synthetic sign-in probe tokens quoted in an audit transcript',
  ],
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.wrangler',
  '.turbo',
]);
const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.webm',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.sqlite',
  '.db',
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
      if (m)
        findings.push({
          label: `${label} (minified)`,
          line: 0,
          rule: rule.id,
          excerpt: mask(m[0]),
        });
    }
  }
}

function mask(s) {
  if (s.length <= 10) return `${s.slice(0, 2)}***`;
  return `${s.slice(0, 6)}***${s.slice(-2)} (${s.length} chars)`;
}

/**
 * Every child process this script starts is bounded and killed on timeout.
 *
 * `execFileSync`'s `timeout`/`killSignal` pair is the bound: the child is sent `SIGKILL`
 * if it outlives it, and the call throws rather than hanging. Nothing here spawns a
 * process it does not wait for, so there is no orphan on the success path; on the failure
 * path the kill is the cleanup. An unbounded spawn is what produced SEC-632, and an
 * unbounded asynchronous one would only move the failure somewhere harder to see.
 */
const GIT_TIMEOUT_MS = 120_000;

function git(argv, options = {}) {
  return execFileSync('git', argv, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...options,
  });
}

/**
 * Read many objects through ONE `git cat-file` process instead of one process each.
 *
 * WHY THIS EXISTS — the SEC-632 root cause, measured rather than guessed.
 *
 * The first version of this pass called `git cat-file -t`, then `-s`, then
 * `cat-file blob`, once each, per object named by `rev-list --objects --all`. On this
 * repository that is 1,826 candidate objects and 1,165 readable blobs, so ~4,150 process
 * creations. Process creation on Windows costs roughly 24 ms, which is the entire runtime:
 *
 *     before: `scan-secrets.mjs --history` = 110,957 ms
 *     after : the same scan, same objects  =   1,718 ms      (~65x)
 *
 * That cost then blocked a vitest worker's event loop for minutes, past birpc's hard-coded
 * 60 s RPC timeout, which made the whole suite exit 1 under a green summary. The scanner
 * was the defect; how it was invoked only made the defect visible.
 *
 * `--batch-check` and `--batch` both take object names on stdin and answer for each in
 * turn, so a chunk of 500 objects costs one spawn rather than a thousand. The chunking is
 * the work bound: peak memory is capped by the chunk rather than by the repository, so
 * this stays flat on a history far larger than ours.
 *
 * Equivalence was measured, not assumed: old and new read the same 1,165 blobs, with zero
 * in one and not the other and zero decoded-length mismatches.
 */
const CAT_FILE_CHUNK = 500;

/** `--batch-check`: one header line per object, no contents. Cheap and text-only. */
function batchCheck(shas) {
  const out = new Map();
  for (let i = 0; i < shas.length; i += CAT_FILE_CHUNK) {
    const chunk = shas.slice(i, i + CAT_FILE_CHUNK);
    let text;
    try {
      text = git(['cat-file', '--batch-check'], { input: `${chunk.join('\n')}\n` });
    } catch {
      continue; // an unreadable chunk is skipped, exactly as the per-object version did
    }
    for (const line of text.split('\n')) {
      const parts = line.trim().split(' ');
      // `<sha> missing` for an unknown object; `<sha> <type> <size>` otherwise.
      if (parts.length !== 3) continue;
      out.set(parts[0], { type: parts[1], size: Number(parts[2]) });
    }
  }
  return out;
}

/**
 * `--batch`: the same, with contents. Returns a Map of sha → decoded text.
 *
 * Read as a Buffer and parsed by byte offset, because a blob's contents are arbitrary
 * bytes and a `\n` inside one must not be mistaken for a record separator. The record
 * shape is `<sha> SP <type> SP <size> LF <size bytes> LF`, so every boundary comes from
 * the declared length rather than from scanning for a delimiter.
 */
function batchRead(shas) {
  const out = new Map();
  for (let i = 0; i < shas.length; i += CAT_FILE_CHUNK) {
    const chunk = shas.slice(i, i + CAT_FILE_CHUNK);
    let buffer;
    try {
      buffer = git(['cat-file', '--batch'], { input: `${chunk.join('\n')}\n`, encoding: null });
    } catch {
      continue;
    }
    let offset = 0;
    while (offset < buffer.length) {
      const lineEnd = buffer.indexOf(10, offset);
      if (lineEnd === -1) break;
      const header = buffer.toString('utf8', offset, lineEnd).trim().split(' ');
      offset = lineEnd + 1;
      if (header.length !== 3) break; // `missing`, or a shape we do not understand
      const size = Number(header[2]);
      if (!Number.isFinite(size) || size < 0) break;
      out.set(header[0], buffer.toString('utf8', offset, offset + size));
      offset += size + 1; // the trailing LF git writes after the contents
    }
  }
  return out;
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
  // Candidates first, in one pass over the object list. Exactly the same filtering the
  // per-object version did — path-based binary skip, then the pinned blob allowlist — so
  // what is scanned is unchanged and only the number of processes is different.
  const seen = new Set();
  const candidates = [];
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
    candidates.push({ sha, path });
  }

  // One `--batch-check` pass gives type and size without reading a byte of content, so a
  // tree, a commit or an oversized blob costs nothing to rule out.
  const meta = batchCheck(candidates.map((c) => c.sha));
  const readable = candidates.filter((c) => {
    const m = meta.get(c.sha);
    return m !== undefined && m.type === 'blob' && m.size <= 4 * 1024 * 1024;
  });

  // Then one `--batch` pass for the contents of what survived.
  const contents = batchRead(readable.map((c) => c.sha));
  for (const { sha, path } of readable) {
    const text = contents.get(sha);
    if (text === undefined) continue; // unreadable object; skipped, as before
    scanText(`history:${path}@${sha.slice(0, 8)}`, text);
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
