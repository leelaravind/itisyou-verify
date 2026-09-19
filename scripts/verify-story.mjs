#!/usr/bin/env node
/**
 * Validates docs/development-story-events.json.
 *
 * The point is not schema tidiness. It is that the two development stories cannot
 * drift apart, and that a proposed decision cannot quietly appear as deployed.
 *
 *   node scripts/verify-story.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const PATH = 'docs/development-story-events.json';
const STATUSES = [
  'planned',
  'attempted',
  'implemented',
  'tested',
  'deployed',
  'externally_confirmed',
];
const REQUIRED = [
  'event_id',
  'timestamp',
  'milestone_id',
  'task_id',
  'agent_role',
  'model_id',
  'status',
  'goal',
  'changed_artifacts',
  'decision_summary',
  'decision_reason',
  'test_evidence_refs',
  'limitations',
  'next_step',
];

/** Values that must never appear in a public record. */
const FORBIDDEN = [
  {
    id: 'token-shaped',
    re: /\b(?:sk|rk|pat|whsec|re|xox[abprs]|ghp|gho|github_pat)[_-][A-Za-z0-9_-]{12,}/,
  },
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
  { id: 'email-address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
];

const problems = [];
const warnings = [];

if (!existsSync(PATH)) {
  console.error(`verify-story — ${PATH} does not exist.`);
  process.exit(1);
}

let doc;
try {
  doc = JSON.parse(readFileSync(PATH, 'utf8'));
} catch (err) {
  console.error(`verify-story — ${PATH} is not valid JSON: ${err.message}`);
  process.exit(1);
}

if (doc.schema_version !== 1)
  problems.push(`schema_version must be 1, found ${doc.schema_version}`);
if (!Array.isArray(doc.events) || doc.events.length === 0) {
  console.error('verify-story — events must be a non-empty array.');
  process.exit(1);
}

const seenIds = new Set();
const raw = readFileSync(PATH, 'utf8');

for (const rule of FORBIDDEN) {
  const m = rule.re.exec(raw);
  if (m)
    problems.push(`forbidden content [${rule.id}] in the public record: ${m[0].slice(0, 12)}…`);
}

for (const [i, e] of doc.events.entries()) {
  const at = `events[${i}] (${e.event_id ?? 'no id'})`;

  for (const field of REQUIRED) {
    if (!(field in e)) problems.push(`${at}: missing required field "${field}"`);
  }

  if (e.event_id) {
    if (seenIds.has(e.event_id)) problems.push(`${at}: duplicate event_id`);
    seenIds.add(e.event_id);
    if (!/^EVT-\d{4}$/.test(e.event_id)) problems.push(`${at}: event_id must look like EVT-0001`);
  }

  if (e.timestamp && Number.isNaN(Date.parse(e.timestamp))) {
    problems.push(`${at}: timestamp is not parseable`);
  }
  if (e.timestamp && !/Z$/.test(e.timestamp)) {
    problems.push(`${at}: timestamp must be UTC and end in Z`);
  }

  if (e.status && !STATUSES.includes(e.status)) {
    problems.push(`${at}: status "${e.status}" is not one of ${STATUSES.join(', ')}`);
  }

  // The rule that matters most: you cannot claim a thing shipped without evidence.
  if (['tested', 'deployed', 'externally_confirmed'].includes(e.status)) {
    if (!Array.isArray(e.test_evidence_refs) || e.test_evidence_refs.length === 0) {
      problems.push(`${at}: status "${e.status}" requires at least one test_evidence_ref`);
    }
  }
  if (['deployed', 'externally_confirmed'].includes(e.status) && !e.commit_sha) {
    warnings.push(`${at}: status "${e.status}" without a commit_sha — is this really shipped?`);
  }

  // Unknown must stay null, never a guess.
  if (e.model_id === 'unknown' || e.model_id === '') {
    problems.push(`${at}: model_id must be null when unknown, not a placeholder string`);
  }

  for (const field of ['goal', 'decision_summary', 'decision_reason', 'limitations', 'next_step']) {
    if (typeof e[field] === 'string' && e[field].trim() === '') {
      problems.push(
        `${at}: "${field}" is present but empty — say "none" rather than leaving it blank`,
      );
    }
  }
}

console.log(`verify-story — ${doc.events.length} event(s) in ${PATH}`);
const byStatus = {};
for (const e of doc.events) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
for (const [s, n] of Object.entries(byStatus)) console.log(`  ${s.padEnd(22)} ${n}`);

for (const w of warnings) console.log(`  WARN  ${w}`);

if (problems.length > 0) {
  console.error(`\nverify-story — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log('\nverify-story — record is well-formed and contains no forbidden content.');
console.log('Note: this proves the record is honest in shape. It does not prove its claims.');
process.exit(0);
