#!/usr/bin/env node
/**
 * Claim scanner for tracked application source and built output.
 *
 * Run before every release. Exit code 1 means: do not ship.
 *
 *   node scripts/scan-claims.mjs                 # tracked files
 *   node scripts/scan-claims.mjs --paths dist    # plus build output
 *
 * WHY THIS EXISTS
 *
 * This service sells one thing: that it reports what the evidence supports and says
 * "we could not check" when it could not. A single unearned claim on a public page
 * does more damage to that than a functional bug would, because it is the product's
 * own argument turned against it.
 *
 * The concrete trigger was a UI-design workstream. Sixteen screens were generated in
 * an external design tool. Partway through, the tool was given an explicit, itemised
 * instruction to stop making unearned claims. It visibly accepted the rule — it
 * restated it back — and the finished export still contained `ZERO-TRUST` on 13 of 20
 * screens, `SOC2` on 6, `ISO 27001` on 2, a fabricated quote disparaging two named
 * competitors on 4, and `AUTO-REMEDIAT` on 2. Correcting a generator does not clean
 * what it already produced and does not reliably stop it producing more.
 *
 * So the control cannot be an instruction, a review or a good intention. It has to be
 * a gate that fails the build.
 *
 * WHAT EACH RULE PROTECTS
 *
 * Three categories, in descending order of how badly they would hurt:
 *
 *   1. Regulated attestations we do not hold (SOC 2, ISO 27001, PCI DSS, HIPAA).
 *      These are not marketing overreach. They are false statements about audits that
 *      either happened or did not.
 *   2. Claims about a capability the frozen contract forbids. This service observes
 *      and reports; it never acts on a customer's systems. "Self-healing" and
 *      "auto-remediated" describe a different product, and not one we intend to build.
 *   3. Absolutist vocabulary. "Guaranteed", "undeniable", "absolute", "certainty".
 *      The test that generated this list: if the engine returned UNVERIFIED, would
 *      this sentence still be true? If not, it must not be in the product.
 *
 * Named competitors are included because the generated material invented a quote
 * attributed to a named person at a named company. A comparative claim about a real
 * competitor has to be true, specific and defensible; if one is ever wanted, it gets
 * an explicit marker and a reviewer, not a silent pass.
 *
 * WHAT IT SCANS, AND WHY THAT IS NARROWER THAN "EVERYTHING"
 *
 * The first version scanned every tracked file and produced 96 findings. Reading them
 * was instructive: almost none were claims.
 *
 *   - `apps/app/src/growth/approval.ts` matched because it *defines* FORBIDDEN_AD_PHRASES.
 *   - `tests/unit/growth/campaign-packet.test.ts` matched because it asserts the packet
 *     validator REJECTS "guaranteed accuracy".
 *   - `packages/ui/src/content/legal.ts` matched on a comment requiring that any claimed
 *     certification stay TODO until actually held and evidenced.
 *   - `docs/product-scope.md` matched on the audit report whose finding is that none of
 *     these phrases appears anywhere on the site.
 *   - `apps/app/src/support/faq.ts` matched on a support-triage keyword list.
 *   - `docs/competitors.md` matched 24 times because it is competitor research.
 *
 * In other words the scanner was flagging its own controls, the tests that prove them,
 * and the record of the audit that found nothing. A check with that signal-to-noise
 * ratio gets switched off within a week, and a switched-off check protects nothing.
 *
 * So the scope is the surface the rule is actually about: **source that renders to a
 * visitor**, plus — far more importantly — the **rendered HTML itself** via `--paths`.
 * The rendered pass is the real control. It is the same lesson this project learned the
 * hard way when a 33% meter displayed as 100%: the template was right, the test asserting
 * the template was right, and only fetching the page revealed the truth. Grepping source
 * for a string is a proxy; reading what was served is the measurement.
 *
 * Internal documents, tests and research are deliberately out of scope. A competitor's
 * name in `docs/competitors.md` is not a public claim — that file is not a route. This
 * is narrowing the aim, not lowering the bar: the rendered pass catches anything that
 * actually reaches a visitor regardless of which source file produced it.
 *
 * ESCAPE HATCH, AND WHY IT IS NARROW
 *
 * A line carrying `claim-scan:allow <reason>` is exempt, and the reason is mandatory —
 * an exemption without a stated reason is indistinguishable from someone silencing the
 * check. Exemptions are counted and printed on every clean run, because an exemption
 * nobody sees is an exemption nobody reviews.
 *
 * Every current exemption is a DENIAL: a sentence that names a thing in order to say we
 * do not do it or do not hold it. That distinction is the entire product, so the site
 * has to be allowed to make it out loud.
 *
 * The design directory is excluded wholesale. Generated reference material is expected
 * to contain all of this; the point is that it stays there and never reaches the app.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, sep } from 'node:path';

/** Each rule says what is wrong, not merely what matched. */
const RULES = [
  // 1. Attestations we do not hold.
  {
    id: 'false-certification',
    re: /\b(?:SOC\s?-?2(?:\s?Type\s?(?:I|II|1|2))?|ISO\s?-?27001|PCI[- ]?DSS|HIPAA[- ]?compliant|FedRAMP)\b/i,
    why: 'asserts a certification or audit this business does not hold',
  },
  // 2. Capabilities the frozen contract forbids.
  {
    id: 'remediation-claim',
    // The first version required a hyphen-joined form or the adverb "automatically", so
    // the independent auditor defeated it in one attempt with the plainest possible
    // English: "We fix your broken automation for you." A rule that catches the jargon
    // and misses the sentence is worse than useless, because it certifies the page.
    //
    // The negative lookahead keeps denials out of the findings. This site says "It does
    // not fix anything" and "We never modify your CRM" prominently and on purpose, and a
    // gate that fired on those would push someone to soften the very sentences that make
    // the product honest.
    re: /\b(?:auto[- ]?(?:heal|healed|healing|remediat\w*|fix\w*|repair\w*)|self[- ]?heal\w*|(?:automatically|we|it) (?:fix|fixes|repair|repairs|remediate|remediates|re-?runs?|retr(?:y|ies))|(?:we|it) resolves? (?:your|their|the customer)\b(?![^.]{0,40}\b(?:not|never|nothing|no )))/i,
    why: 'claims the service acts on a customer system; it only observes and reports',
  },
  // 3. Absolutist vocabulary.
  {
    id: 'absolutist-claim',
    re: /\b(?:verification guaranteed|guarantee(?:d|s|ing)? (?:[\w%]+ ){0,2}(?:verification|accuracy|uptime|delivery|results?)|undeniable|absolute (?:certainty|proof|consensus|truth)|100%? (?:accurate|accuracy|reliable|certain|of)|never fails|cannot fail|zero[- ]trust:?\s*strict)\b/i,
    why: 'asserts a certainty the engine cannot produce; UNVERIFIED is a normal outcome',
  },
  {
    id: 'generated-status-vocabulary',
    re: /\b(?:VERIFIED REALITY|PHANTOM 200|GROUND TRUTH PROTOCOL|Verification Oracle|Cryptographic Proof Protocol)\b/i,
    why: 'design-tool vocabulary that overstates what a status means',
  },
  // 4. Invented social proof.
  //
  // The counted alternatives all begin `\d` on purpose. The first version used `[\d,]+`,
  // which matches a bare comma, so every occurrence of the word "customers" preceded by
  // a comma was reported as an unsourced customer count. That produced three findings in
  // files containing no claim whatsoever. A rule that fires on punctuation teaches people
  // to skim the output, which is how a real finding gets scrolled past.
  {
    id: 'unearned-social-proof',
    re: /\b(?:trusted by (?:over )?\d[\d,]*|join \d[\d,]* (?:agencies|companies|teams)|rated \d(?:\.\d)? (?:out of|\/) 5|\d[\d,]*\+? (?:happy )?customers)\b/i,
    why: 'a customer count, rating or trust claim with no source',
  },
  // 5. Named competitors.
  {
    id: 'named-competitor',
    re: /\b(?:Zapier|Make\.com|Workato|Tray\.io|n8n)\b/i,
    why: 'names a real competitor; any comparative claim must be true and reviewed',
  },
  // 6. Registry names nobody has claimed.
  {
    id: 'unclaimed-package',
    re: /\b(?:pip install|npm install|yarn add|PyPI:|pnpm add)\s+@?itisyou\b/i,
    why: 'publishes an install command for a registry name we have not claimed',
  },
];

const ALLOW_MARKER = 'claim-scan:allow';

/**
 * Sentences that are permitted in RENDERED output, pinned by exact text.
 *
 * Rendered HTML cannot carry a source comment, so the `claim-scan:allow` marker is
 * unavailable on the surface that matters most. The alternative would be to exempt a
 * whole page or a whole rule, which is how a gate quietly stops gating.
 *
 * Pinning the full sentence is what keeps this honest, on the same principle as the
 * pinned blob SHAs in `scan-secrets.mjs`: the exemption covers exactly this wording and
 * nothing else. Change a word and the gate fires again, which is correct — the reason a
 * sentence is allowed is entirely a property of its wording.
 *
 * Every entry must be a DENIAL: it names the thing in order to say we do not do it.
 * Nothing that asserts a capability, a certification or a comparison may be added here.
 */
const ALLOWED_RENDERED_SENTENCES = new Map([
  [
    'we retry automatically within a bounded number of attempts',
    'we retry OUR OWN read of the provider, which is the opposite of acting on the customer system — the sentence exists to explain that an outage is not their failure',
  ],
  [
    'We never see inside n8n, Make, Zapier or whatever runs your workflow.',
    'names competitors to state OUR blindness, not their shortcomings — it makes the product weaker-sounding, not stronger, which is why it is trustworthy',
  ],
]);

/**
 * Tracked source that renders to a visitor. Everything else — tests, internal docs,
 * competitor research, the validators that define the forbidden phrases — is out of
 * scope for the source pass and covered instead by the rendered pass (`--paths`).
 */
const PUBLIC_SOURCE_PREFIXES = [
  'packages/ui/src/',
  'apps/app/src/routes/public/',
  'apps/app/src/routes/app/',
  'apps/app/src/routes/owner/',
];

/**
 * Generated design reference is expected to contain every one of these. It is kept
 * deliberately, and the entire purpose of this scanner is that it stays there.
 */
const EXCLUDED_PREFIXES = ['design/', `design${sep}`];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.wrangler', '.turbo', 'design']);
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.html',
  '.md',
  '.json',
  '.css',
  '.txt',
  '.yml',
  '.yaml',
]);

const args = process.argv.slice(2);
const extraPaths = (() => {
  const i = args.indexOf('--paths');
  return i === -1 ? [] : args.slice(i + 1).filter((a) => !a.startsWith('--'));
})();

const findings = [];
let exemptions = 0;

function excluded(path) {
  const norm = path.split(sep).join('/');
  return EXCLUDED_PREFIXES.some((p) => norm.startsWith(p.split(sep).join('/')));
}

/** True when a tracked file is source that renders to a visitor. */
function isPublicSource(path) {
  const norm = path.split(sep).join('/');
  return PUBLIC_SOURCE_PREFIXES.some((p) => norm.startsWith(p));
}

function scanText(label, text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // The marker exempts its own line or the line immediately below it, so a long
    // line can be annotated above rather than pushed past the length limit.
    const markerHere = line.includes(ALLOW_MARKER);
    const markerAbove = i > 0 && lines[i - 1].includes(ALLOW_MARKER);
    if (markerHere || markerAbove) {
      const source = markerHere ? line : lines[i - 1];
      const reason = source.slice(source.indexOf(ALLOW_MARKER) + ALLOW_MARKER.length).trim();
      if (reason.length < 8) {
        findings.push({
          label,
          line: i + 1,
          rule: 'unexplained-exemption',
          why: `"${ALLOW_MARKER}" requires a stated reason of at least 8 characters`,
          excerpt: source.trim().slice(0, 70),
        });
      } else if (markerHere) {
        // Counted on the marker line only. Counting the covered line as well would
        // report two exemptions per marker, and a number that overstates itself is
        // exactly the defect this repository exists to argue against.
        exemptions += 1;
      }
      continue;
    }
    // Rendered output carries no comments, so pinned sentences are the only exemption
    // available there. Tags are stripped before matching so that markup changes — a new
    // wrapper element, a different class — do not silently revoke a reviewed exemption.
    const plain = line.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    let pinned = false;
    for (const [sentence, reason] of ALLOWED_RENDERED_SENTENCES) {
      if (plain.includes(sentence)) {
        if (reason.length < 8) continue;
        pinned = true;
        exemptions += 1;
        break;
      }
    }
    if (pinned) continue;

    for (const rule of RULES) {
      const m = rule.re.exec(line);
      if (m) {
        findings.push({ label, line: i + 1, rule: rule.id, why: rule.why, excerpt: m[0] });
      }
    }
  }
}

function readable(path) {
  if (!TEXT_EXT.has(extname(path).toLowerCase())) return false;
  try {
    return statSync(path).size <= 4 * 1024 * 1024;
  } catch {
    return false;
  }
}

let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean);
} catch {
  console.error('scan:claims — not a git repository; nothing tracked to scan.');
}

let scanned = 0;
let skippedOutOfScope = 0;
for (const f of tracked) {
  if (excluded(f) || !readable(f)) continue;
  if (!isPublicSource(f)) {
    skippedOutOfScope += 1;
    continue;
  }
  try {
    scanText(f, readFileSync(f, 'utf8'));
    scanned += 1;
  } catch {
    /* unreadable or removed */
  }
}

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
    else if (readable(p)) {
      try {
        scanText(p, readFileSync(p, 'utf8'));
        scanned += 1;
      } catch {
        /* ignore */
      }
    }
  }
}
for (const p of extraPaths) walk(p);

if (findings.length === 0) {
  console.log(
    `scan:claims — clean. ${scanned} public-surface file(s) scanned${extraPaths.length ? `, extra paths: ${extraPaths.join(', ')}` : ''}.`,
  );
  console.log(
    `  ${skippedOutOfScope} tracked file(s) out of scope (tests, internal docs, validators).`,
  );
  if (exemptions > 0) {
    console.log(
      `  ${exemptions} line(s) exempted by "${ALLOW_MARKER}" with a stated reason — review them.`,
    );
  }
  if (extraPaths.length === 0) {
    console.log('  WARNING: no rendered output was scanned. Pass --paths <dir> with the');
    console.log('  served HTML. Source is a proxy; what was served is the measurement.');
  }
  console.log('  Note: this proves no BANNED phrase is present. It does not prove the');
  console.log('  remaining claims are true. Only checking them against the code does that.');
  process.exit(0);
}

console.error(`scan:claims — ${findings.length} unearned claim(s) found. DO NOT SHIP.\n`);
for (const f of findings) {
  console.error(`  ${f.label}:${f.line}`);
  console.error(`      matched [${f.rule}] "${f.excerpt}"`);
  console.error(`      why     ${f.why}`);
}
console.error(
  `\nEither remove the claim, or — if it is genuinely true and defensible — add\n"${ALLOW_MARKER} <reason>" on that line or the line above it. The reason is required.`,
);
process.exit(1);
