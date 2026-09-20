/**
 * The narrative half of the visual story: content that is not in the structured record.
 *
 * Every item carries a `source`. The sources are, in order of preference: an event id in
 * `docs/development-story-events.json`; a section of `docs/development-story.md`; a commit
 * message in this repository; a comment in a source file. Nothing here is written from
 * memory. If a sentence cannot be traced to one of those, it is not on the page.
 *
 * Wording stays as close to the source as sentence structure allows. Where the source is
 * quoted, it is quoted; where it is summarised, the summary does not add a claim.
 */
import type { StatusKey } from '@verify/ui';

export interface Sourced {
  readonly source: string;
}

/* ------------------------------------------------------------------ *
 * The problem, the idea, the four statuses
 * ------------------------------------------------------------------ */

export const PROBLEM: Sourced & { readonly paragraphs: readonly string[] } = {
  paragraphs: [
    'An automation platform tells you a run succeeded. That claim comes from the automation itself. If the step that was supposed to create a CRM record silently did nothing, or the acknowledgement email was accepted by the sending service and then bounced, the run still reports success — because from the automation’s point of view, it finished.',
    'The gap is not monitoring. Error alerts fire when something throws. This is about the cases where nothing throws and the outcome still is not there.',
    'The idea: go and look. Read the CRM record back from the CRM. Read the email outcome back from the email provider. Check both against rules the customer set. Report what the evidence supports — and report honestly when the evidence is missing rather than guessing.',
  ],
  source: 'docs/development-story.md § The problem, § The idea',
};

export interface StatusMeaning extends Sourced {
  readonly status: StatusKey;
  readonly meaning: string;
}

export const FOUR_STATUSES: readonly StatusMeaning[] = [
  {
    status: 'VERIFIED',
    meaning: 'Every mandatory check has supporting evidence.',
    source: 'docs/development-story.md § The four statuses',
  },
  {
    status: 'FAILED',
    meaning:
      'Evidence contradicts a rule, or the deadline passed while evidence access was working.',
    source: 'docs/development-story.md § The four statuses',
  },
  {
    status: 'UNVERIFIED',
    meaning: 'Access, correlation or evidence is missing or ambiguous. Not a pass. Not a failure.',
    source: 'docs/development-story.md § The four statuses',
  },
  {
    status: 'PENDING',
    meaning: 'Still inside the agreed completion window.',
    source: 'docs/development-story.md § The four statuses',
  },
];

/* ------------------------------------------------------------------ *
 * The customer journey
 * ------------------------------------------------------------------ */

export interface JourneyStep extends Sourced {
  readonly title: string;
  readonly body: string;
  /** Machine vocabulary shown in mono beside the step, where the record has one. */
  readonly vocabulary?: string;
}

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  {
    title: 'An enquiry arrives',
    body: 'Version one checks exactly one workflow shape: an enquiry should create the correct CRM record and trigger an acknowledgement email, using HubSpot and Resend.',
    source: 'docs/development-story.md § Why only one workflow shape',
  },
  {
    title: 'The customer’s automation runs, and tells us it succeeded',
    body: 'That claim comes from the automation itself. Evidence carries an origin, and the customer’s own system telling us something can never support a mandatory check. It is a trigger, not proof.',
    vocabulary: 'customer_claim',
    source:
      'docs/development-story.md § The problem, § Why your own automation’s word is not evidence',
  },
  {
    title: 'We read the CRM record back, and the email outcome back',
    body: 'We ask HubSpot ourselves for the record, and Resend for what happened to the message — or Resend calls us and we verify its signature. Both are independent of the automation that claimed success.',
    vocabulary: 'provider_readback · provider_webhook',
    source:
      'docs/development-story.md § The idea; packages/contracts/src/evidence.ts (EvidenceOrigin)',
  },
  {
    title: 'The customer’s rules are evaluated',
    body: 'A closed set of typed operators — exists, equals, normalised_email_equals, occurred_within, provider_status_in, one_of — over an allowlisted set of fields. A general expression language was rejected because it would make the difference between "failed" and "could not be checked" impossible to prove. Two checks bind to the run’s own signed event — the enquiry reference and the expected recipient — as a closed reference, not an expression; that is what lets "the acknowledgement went to the address this enquiry named" be checked per run.',
    vocabulary:
      'exists · equals · normalised_email_equals · occurred_within · provider_status_in · one_of',
    source: 'docs/development-story.md § Why the rule language is deliberately small; EVT-0002',
  },
  {
    title: 'One of four verdicts, with the evidence attached',
    body: 'Verified, Failed, Unverified or Pending. Unverified exists because the honest answer is often "we do not know", and collapsing that into either of the other two would be a lie in one direction or the other.',
    source: 'docs/development-story.md § The four statuses',
  },
];

/** The rules that decide what absence means. The product's whole argument, in five lines. */
export const ABSENCE_RULES: Sourced & { readonly rules: readonly string[] } = {
  rules: [
    'The provider answered, and the value is wrong → contradicted.',
    'The provider answered, and the field was not in the answer → unknown. We cannot call a value wrong when we do not have it.',
    'The provider answered and the field is genuinely empty → contradicted. That is an authoritative empty.',
    'We could not reach the provider → unknown, always. Our outage is not the customer’s failure.',
    'Only two situations can turn a missing outcome into a failure at the deadline: the CRM authoritatively reporting that no such record exists (RECORD_NOT_FOUND), and the email provider authoritatively reporting that no such event occurred (EVENT_NOT_OBSERVED). A timeout never qualifies.',
  ],
  source:
    'docs/development-story.md § The line between "wrong" and "unknown"; packages/domain (AUTHORITATIVE_ABSENCE_REASONS)',
};

/* ------------------------------------------------------------------ *
 * The twelve roles and the system pieces
 * ------------------------------------------------------------------ */

export interface Role extends Sourced {
  readonly id: string;
  readonly name: string;
  readonly owns: string;
  /** The model recorded against this role number, or `null` when no record names one. */
  readonly model: string | null;
  readonly modelSource: string | null;
}

/**
 * Ownership comes from the brief's repository table. A model is listed only where a record
 * ties it to this role *number*: the structured record's `model_id`, or the routing document's
 * explicit "A0x returned real work" line. `docs/model-routing.md` also attributes commerce,
 * customer experience, support and growth to Opus by function without a role number; that
 * mapping is not inferred here.
 */
export const ROLES: readonly Role[] = [
  {
    id: 'A01',
    name: 'Product and market',
    owns: 'docs/product-scope.md, docs/competitors.md, packages/ui/src/content/',
    model: 'claude-sonnet-5',
    modelSource: 'EVT-0005',
    source: 'docs/agent-brief.md § Repository layout; EVT-0005',
  },
  {
    id: 'A02',
    name: 'Architecture and data',
    owns: 'packages/security/, apps/app/src/db/, apps/app/src/lib/, the JSON API with each owning agent',
    model: 'claude-opus-5',
    modelSource: 'EVT-0007',
    source: 'docs/agent-brief.md § Repository layout; EVT-0007',
  },
  {
    id: 'A03',
    name: 'Verification engine',
    owns: 'packages/domain/, apps/app/src/scheduler/',
    model: 'claude-opus-5',
    modelSource: 'EVT-0006',
    source: 'docs/agent-brief.md § Repository layout; EVT-0006',
  },
  {
    id: 'A04',
    name: 'Connectors',
    owns: 'packages/connectors/ (HubSpot, Resend, Stripe adapters); signed provider callbacks with A06',
    model: 'Opus (subagent)',
    modelSource: 'docs/model-routing.md § Catalogue',
    source: 'docs/agent-brief.md § Repository layout; docs/model-routing.md',
  },
  {
    id: 'A05',
    name: 'Design system and customer experience',
    owns: 'packages/ui/, apps/app/src/routes/public/, apps/app/src/routes/app/',
    model: 'Opus (subagent)',
    modelSource: 'docs/model-routing.md § Catalogue',
    source: 'docs/agent-brief.md § Repository layout; docs/model-routing.md',
  },
  {
    id: 'A06',
    name: 'Commerce and billing',
    owns: 'apps/app/src/routes/webhooks/ with A04; the payment-failure window the notifications read',
    model: null,
    modelSource: null,
    source: 'docs/agent-brief.md § Repository layout; commit 3673ea8',
  },
  {
    id: 'A07',
    name: 'Owner dashboard',
    owns: 'apps/app/src/routes/owner/',
    model: null,
    modelSource: null,
    source: 'docs/agent-brief.md § Repository layout; commit d0e9453',
  },
  {
    id: 'A08',
    name: 'Optional assistant and maintenance runner',
    owns: 'apps/app/src/assistant/',
    model: null,
    modelSource: null,
    source: 'docs/agent-brief.md § Repository layout; commit d0e9453',
  },
  {
    id: 'A09',
    name: 'Support, notifications, export and deletion',
    owns: 'apps/app/src/support/',
    model: null,
    modelSource: null,
    source: 'docs/agent-brief.md § Repository layout; commit 3673ea8',
  },
  {
    id: 'A10',
    name: 'Security reviewer',
    owns: 'tests/security/, docs/threat-model.md, docs/security-acceptance.md, .github/workflows/ci.yml',
    model: 'claude-opus-5',
    modelSource: 'EVT-0008',
    source: 'docs/agent-brief.md § Tests; EVT-0008',
  },
  {
    id: 'A11',
    name: 'QA and release',
    owns: 'docs/test-plan.md, docs/test-cases.json, scripts/verify-test-cases.mjs',
    model: 'claude-opus-5',
    modelSource: 'EVT-0009',
    source: 'docs/agent-brief.md § Tests; EVT-0009',
  },
  {
    id: 'A12',
    name: 'Growth',
    owns: 'apps/app/src/growth/ (campaign packets, ad adapter, visit analytics)',
    model: null,
    modelSource: null,
    source: 'docs/agent-brief.md § Repository layout',
  },
];

export const LEAD: Role = {
  id: 'lead',
  name: 'Lead',
  owns: 'packages/contracts/ (frozen), migrations/, apps/app/src/index.ts, docs/agent-brief.md',
  model: 'claude-opus-5[1m]',
  modelSource: 'EVT-0001',
  source: 'docs/agent-brief.md § Repository layout; EVT-0001',
};

export interface SystemPiece extends Sourced {
  readonly id: string;
  readonly name: string;
  readonly ownedBy: string;
  readonly body: string;
}

export const SYSTEM_PIECES: readonly SystemPiece[] = [
  {
    id: 'worker',
    name: 'One Cloudflare Worker',
    ownedBy: 'lead mounts; A05, A07, A02, A04, A06, A03, A08, A09, A12 own routers',
    body: 'Serves the site, the customer application, the owner dashboard and the API. Hono routing, server-rendered HTML, no client framework.',
    source: 'docs/development-story.md § Architecture; docs/agent-brief.md § Stack decisions',
  },
  {
    id: 'contracts',
    name: 'contracts',
    ownedBy: 'lead',
    body: 'Zod schemas, shared types, status vocabularies, money. Frozen and read-only for agents, so twelve specialists cannot each invent their own vocabulary.',
    source: 'docs/agent-brief.md § Repository layout; EVT-0002',
  },
  {
    id: 'domain',
    name: 'domain',
    ownedBy: 'A03',
    body: 'Pure rule evaluation, decision table, run state machine, retry scheduling. Time-injected; no I/O.',
    source: 'docs/agent-brief.md § Repository layout; EVT-0006',
  },
  {
    id: 'connectors',
    name: 'connectors',
    ownedBy: 'A04',
    body: 'HubSpot, Resend and Stripe adapters behind one interface. Resend has run against a live account and produced evidence on a deployment. HubSpot is connected and has produced none. Stripe has taken one sandbox payment.',
    source: 'docs/agent-brief.md § Repository layout; docs/development-story.md § Where it stands',
  },
  {
    id: 'security',
    name: 'security',
    ownedBy: 'A02',
    body: 'AES-GCM credential envelopes, HMAC signatures, hashing, redaction, CSRF.',
    source: 'docs/agent-brief.md § Repository layout; EVT-0007',
  },
  {
    id: 'ui',
    name: 'ui',
    ownedBy: 'A05',
    body: 'Design tokens, layout, accessible components, shared page chrome. This page is drawn with it.',
    source: 'docs/agent-brief.md § Repository layout',
  },
  {
    id: 'd1',
    name: 'Cloudflare D1',
    ownedBy: 'lead (schema), A02 (access)',
    body: 'Holds the data, in EU-West because the business is in the UK. Two databases: staging and production.',
    source: 'docs/development-story.md § Architecture; EVT-0003',
  },
  {
    id: 'cron',
    name: 'One-minute cron',
    ownedBy: 'A03',
    body: 'Background work runs from a one-minute cron trigger over a single indexed due-job query. Cloudflare Queues were considered and not used. Staging deliberately has no cron.',
    source: 'docs/development-story.md § Architecture; EVT-0003',
  },
];

/* ------------------------------------------------------------------ *
 * What broke
 * ------------------------------------------------------------------ */

export interface Failure extends Sourced {
  readonly id: string;
  readonly title: string;
  readonly wentWrong: string;
  readonly whyMissed: string;
  readonly whatChanged: string;
}

export const FAILURES: readonly Failure[] = [
  {
    id: 'allowance',
    title: 'The allowance reservation that silently did nothing',
    wentWrong:
      'Admitting a source event has to record the event, reserve one run from the customer’s allowance and queue the follow-up work, atomically. The obvious implementation guards the reservation with a conditional UPDATE. On D1 a conditional update inside a batch cannot abort the batch: it reports zero rows changed after the inserts have already committed. The event would have been admitted without consuming an allowance.',
    whyMissed:
      'The failure does not announce itself. Zero rows changed is a normal-looking result, and the inserts before it succeed.',
    whatChanged:
      'The reservation is written so that exhausting the allowance violates a NOT NULL constraint, which does roll the whole batch back. It reads oddly, it is correct, and a test fails if anyone "tidies" it.',
    source:
      'docs/development-story.md § The allowance reservation that silently did nothing; EVT-0007',
  },
  {
    id: 'binding',
    title: 'A credential binding that bound nothing',
    wentWrong:
      'Stored provider credentials are encrypted with the workspace, provider and purpose mixed into the authenticated data, so ciphertext moved to another tenant will not decrypt. The function that opens a credential accepted the expected binding as an optional argument. Any helper that looked a credential up by id and forgot to pass it would decrypt any tenant’s row, because the stored binding travels with the row and satisfies the check on its own.',
    whyMissed:
      'The binding was real and the tests that passed it were green. The API made forgetting it easy, and that is the same thing as not having it. It took an independent reviewer told to challenge the implementation, not confirm it.',
    whatChanged:
      'Found by the security review (A10) as its critical finding and routed to A02. Six security tests were committed red, on purpose, and closed one at a time.',
    source: 'docs/development-story.md § A credential binding that bound nothing; EVT-0008',
  },
  {
    id: 'owner',
    title: 'The owner dashboard, readable by anyone',
    wentWrong:
      'The in-memory owner data port defaulted its principal to a fully authenticated platform owner with recent MFA. Mounting the owner routes unconfigured therefore served the entire owner dashboard — overview, customers, approvals, controls, settings — to anonymous visitors on staging.',
    whyMissed:
      'In source it looks correct: the 404-not-403 rule is implemented and its tests pass, because every test constructs an anonymous principal explicitly. The default was what failed, and only a live request showed it. It was found by deploying and fetching /owner, not by reading code.',
    whatChanged:
      'The principal was pinned to anonymous at the composition root until real session and TOTP wiring landed, and the default was sent back to fail closed at source. Verified against the deployed staging origin: the owner routes return 404 to an anonymous request and the body leaks nothing.',
    source: 'commit d0e9453; apps/app/src/index.ts (owner router comment)',
  },
  {
    id: 'meter',
    title: '33% that displayed as 100%',
    wentWrong:
      'The demo page shows a workflow health card: a big "33%" with a progress bar underneath. The bar rendered full width and solid green. The markup was right the whole time — style="width:33%". A strict Content-Security-Policy added an hour earlier blocks inline style attributes, so the fill fell back to its default width, which is all of it.',
    whyMissed:
      'Nothing in code review would have found it. The template was correct, the test asserted the template was correct, and the policy was correct in isolation. It took deploying the page and looking at a screenshot.',
    whatChanged:
      'A first fix permitted inline style attributes as a named exception. That exception is gone: the computed width moved into a small set of predefined CSS classes and the policy went back to refusing inline style attributes entirely. The classes round down — 33% draws as 30, 99% as 95, only a true 100% fills the bar. The deployed header now reads style-src-attr ’none’. The structured record’s EVT-0010 still describes the exception stage and has no later event for its removal.',
    source:
      'docs/development-story.md § 33% that displayed as 100%; EVT-0010; commits ab4b345 and 7a3c0e1',
  },
  {
    id: 'emails',
    title: 'Three customer emails whose claims the code had falsified',
    wentWrong:
      'A09 audited all twelve transactional templates with one lens: was this sentence true when written, and is it still true now? Three were not. payment_problem said "We have not suspended anything yet", which the approved recovery policy had made false — new runs pause from the first failed renewal. cancellation_confirmed promised access until the end of the paid period unconditionally, but a support-led cancellation can take effect immediately. deletion_scheduled promised to remove "your evidence, runs and workflow configuration" while deletion left workflows, connections and memberships in place.',
    whyMissed:
      'Each sentence was true when it was written. The code around it changed and the prose did not; nothing checked a template against the behaviour it described.',
    whatChanged:
      'The payment subject now leads with the consequence; days remaining are a parameter, not a literal. The cancellation email requires an explicit timing with a branch for each. Deletion was fixed by deleting the rows, not by softening the sentence — and the one row deliberately kept (the user, who may belong to another workspace) is now stated to the customer rather than silently done. The remaining nine templates were checked against the code that backs them.',
    source: 'commit 3673ea8',
  },
  {
    id: 'coverage',
    title: 'A coverage mode that promised a capability with no implementation',
    wentWrong:
      'The independently_sourced coverage mode was selectable in onboarding and rendered the headline "We find the enquiries ourselves." Nothing implemented it. HubSpot’s adapter has three read operations, and the closest answers "is this specific record there", never "what exists that nobody mentioned". No scheduler code read coverage_mode at all. A customer who chose it would have been told we detect enquiries their automation never reported. We cannot.',
    whyMissed:
      'The field was stored and it changed the copy, so every layer looked wired. The domain module described the mode as though it worked, and no test bound a selectable coverage mode to a connector operation and a scheduler pass capable of delivering it. It was found by A01’s re-audit of claims against code.',
    whatChanged:
      'The mode was made unavailable rather than reworded: the enum stays because it is a real planned capability, but it is marked unsupported as data the onboarding UI reads. describeCoverage() degrades an unsupported mode to the coverage actually provided and attaches a warning that cannot be rendered away. A test now binds each offerable mode to real connector and scheduler capability.',
    source:
      'commit 3c94f8d; packages/domain/src/coverage.ts (header); docs/product-scope.md § finding 2',
  },
  {
    id: 'push',
    title: 'Push protection caught us',
    wentWrong:
      'GitHub’s push protection blocked a push because test fixtures were shaped like real API keys. They were synthetic — all zeros — but shape is what a scanner sees.',
    whyMissed:
      'It was not missed; the control worked. The risk was in how the team responded to it.',
    whatChanged:
      'The fixtures were rewritten so they are assembled at runtime and no credential-shaped literal is committed. The alternative — clicking "allow this secret" — would have trained us to dismiss the one warning that will one day be real.',
    source: 'docs/development-story.md § Push protection caught us; EVT-0004',
  },
  {
    id: 'sha',
    title: 'A pinned action that did not exist',
    wentWrong:
      'The CI workflow pins every GitHub Action to a full commit SHA, because a tag can be repointed at new code by whoever controls the action. One of the pinned SHAs resolved to no commit at all.',
    whyMissed:
      'Pinning had been treated as done once the SHAs were written down. Pinning without verifying is a ritual, not a control.',
    whatChanged: 'All three SHAs were checked against the GitHub API instead of trusting the list.',
    source: 'docs/development-story.md § A pinned action that did not exist',
  },
  {
    id: 'detector',
    title: 'A security scan that fired on English',
    wentWrong:
      'The tenant-scope source scan reported customer-facing prose as unscoped SQL. The payment-recovery notice says you can update your card and mentions runs and evidence, which a case-insensitive keyword match read as an unscoped query on customer tables.',
    whyMissed:
      'It was a false positive rather than a miss — but a security check that fires on English gets muted, and a muted check protects nothing.',
    whatChanged:
      'The detector now requires a verb and a clause, both uppercase, and a paired check fails the build on any lowercase SQL verb in the data layer. Measured rather than assumed: across 285 string literals the old rule detected 121 statements and the new rule detects exactly the same 121.',
    source: 'EVT-0012',
  },
  {
    id: 'haiku',
    title: 'The cheapest model invented a URL',
    wentWrong:
      'The cheapest tier produced the public-repository contribution docs and issue forms. It worked, and it hallucinated the repository URL in the security contact link — an address that does not exist.',
    whyMissed:
      'The output was confident and plausible, and "validated" was accepted at face value until the link was actually resolved. That is the tier’s real failure mode: right about the shape of a thing, wrong in a detail nobody would notice until it mattered.',
    whatChanged:
      'Anything a cheaper tier emits that names a URL, a version, an endpoint or a price is verified by a deterministic check before it is trusted.',
    source: 'docs/model-routing.md § Observed in practice',
  },
  {
    id: 'drift',
    title: 'The story underselling its own fix',
    wentWrong:
      'The prose story still described the CSP fix as "a narrow exception — inline style attributes are permitted" after the exception had been removed and the width had become a CSS class.',
    whyMissed:
      'The code moved on and the document did not. It was caught during a later audit of the deployed site against the documentation.',
    whatChanged:
      'The paragraph was corrected. Underselling a fix is a smaller sin than the reverse, but it is the same class of drift — which is why this page reads the structured record at build time rather than keeping its own copy.',
    source: 'docs/development-story.md § 33% that displayed as 100% (closing note); commit 7a3c0e1',
  },
  {
    id: 'return',
    title: 'A customer paid, and was returned to a 404',
    wentWrong:
      'The first real payment completed on a deployment — the plan price, a sandbox card, through a checkout button that had not existed that morning. The provider took it and redirected the browser to the return path, which answered 404. The billing configuration had named that path, and a second one for a cancelled checkout, since the day it was written. Neither route existed.',
    whyMissed:
      'Every case drove the checkout request and asserted on the redirect it produced, so the journey ended at the provider’s front door and nothing followed the customer home. Correct code, thoroughly tested, reached by nothing — this codebase’s dominant defect, arriving at the worst moment it had available.',
    whatChanged:
      'The return route exists, and it deliberately does NOT say the subscription is active: it is reached the instant the provider redirects, which can be before any webhook has arrived, and on that day the webhook was being rejected for a signature mismatch. It says the payment was accepted, shows the real subscription state, and explains that a redirect is not evidence that anything was confirmed. The guarding case reads the return paths out of the billing configuration rather than retyping them, so it cannot pass while the configuration points somewhere else.',
    source: 'docs/development-story.md § A customer paid, and was returned to a 404; EVT-0036',
  },
  {
    id: 'counter',
    title: 'The visitor counter that could never have moved off zero',
    wentWrong:
      'The launch objective is ten genuine external visits. After a full day of real requests to production, the visit table held zero rows. The counter, its six-rule contract, the classifier and the middleware on every request were all complete and correct, with nothing between them and the database.',
    whyMissed:
      'The suite ran against a faithful in-memory implementation and passed. The gap was in the mount, above a comment correctly arguing that mounting the in-memory one in production would report plausible numbers that were silently wrong. Both halves of that reasoning were right; nobody wrote the real one. Reading the code could not have found it, because every part of the code was right.',
    whatChanged:
      'A real implementation of the same contract, found by querying the live database rather than by review. The cases that cost something are the ones written: a repeat visit is an update and never a second row; a read that failed returns unknown rather than zero, because zero would turn a broken database into the confident business fact that nobody visited; and automated traffic is never countable as an external visitor, because that would fabricate the exact number the objective asks for.',
    source: 'docs/development-story.md § A visitor counter with nothing behind it; EVT-0040',
  },
  {
    id: 'invisible',
    title: 'Three new scanner rules that matched nothing, invisibly',
    wentWrong:
      'Three rules were added to this repository’s claim scanner to cover business claims the approved designs carry. A mangled escape had left invisible control characters inside all three patterns, so none of them could match anything. The scanner reported a clean sweep over content carrying four prices that are not the plan price.',
    whyMissed:
      'Nothing errored. A scanner that reports no findings looks exactly like a scanner that found nothing, and the control characters are invisible in an editor and in search output alike.',
    whatChanged:
      'Each rule is now read live out of the scanner by a case that asserts it fires on the designs’ own wording, asserts it stays silent on our own true sentences, and asserts the pattern contains no control character. The second half matters as much as the first: the real plan price must still pass, and a sentence denying that a trial exists must stay sayable.',
    source: 'docs/development-story.md § Three new rules that matched nothing, invisibly; EVT-0038',
  },
  {
    id: 'preference',
    title: 'An approved design almost nobody would have seen',
    wentWrong:
      'The owner commissioned a design, approved it, and asked for it. The first implementation made the approved appearance the default and let a light operating-system preference switch away from it. Most machines are set light, so the deployed page was very nearly indistinguishable from the page before the change.',
    whyMissed:
      'Every case passed, because the palette was correct and reachable. Honouring the reader’s preference is the conventional and usually the right choice; what no case asserted was the outcome the change existed to produce.',
    whatChanged:
      'The approved appearance is unconditional. The light palette is not deleted — it stays complete, stays measured by the contrast suite, and stays reachable through the explicit toggle — and the case now asserts the property it was written for, that neither palette may quietly become unreachable, rather than the mechanism it happened to use.',
    source:
      'docs/development-story.md § An approved design almost nobody would have seen; EVT-0037',
  },
];

/* ------------------------------------------------------------------ *
 * Evidence panels
 * ------------------------------------------------------------------ */

export interface Metric {
  readonly label: string;
  /** Text of the recorded figure, or `null` when not recorded anywhere we can cite. */
  readonly value: string | null;
  readonly unit?: string;
  readonly source: string;
  readonly note?: string;
}

export interface MetricGroup {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly metrics: readonly Metric[];
}

export const METRIC_GROUPS: readonly MetricGroup[] = [
  {
    id: 'tests',
    title: 'Test outcomes, as recorded',
    intro:
      'Each figure is what the responsible agent recorded at that event’s timestamp, with the command output it reported. Nothing here is re-counted when this page renders, so the live tree may differ.',
    metrics: [
      {
        label: 'Verification-engine cases, all passing',
        value: '195',
        source: 'EVT-0006 (VERIFY-001..VERIFY-195)',
      },
      {
        label: 'Data and security layer cases, all passing',
        value: '205',
        source: 'EVT-0007 (API-, AUTH- and PERSIST- ranges)',
      },
      {
        label: 'Security review cases',
        value: '156',
        note: '150 passing, 6 failing by design against real findings.',
        source: 'EVT-0008',
      },
      {
        label: 'Designed cases in the release ledger',
        value: '578',
        note: '449 already-implemented ids and 415 designed cases not yet implemented, in separate namespaces until reconciled.',
        source: 'EVT-0009',
      },
      {
        label: 'Threats modelled',
        value: '40+',
        note: '30 blocking acceptance checks and 9 explicitly accepted risks.',
        source: 'EVT-0008',
      },
      {
        label: 'SQL statements detected before and after the detector fix',
        value: '121',
        note: 'Across 285 string literals in the data layer. Zero detection lost. SEC-205 added; 19 cases in that file pass.',
        source: 'EVT-0012',
      },
    ],
  },
  {
    id: 'deploy',
    title: 'Deployment, as recorded',
    intro: 'What the lead recorded after deploying and looking, not after deploying and assuming.',
    metrics: [
      {
        label: 'Schema statements applied to each of two remote databases',
        value: '70',
        source: 'EVT-0003',
      },
      {
        label: 'Public routes returning 200 on staging, policy applied',
        value: '13',
        source: 'EVT-0010',
      },
      {
        label: 'Production routes returning 200, CSP and HSTS present',
        value: '11',
        source: 'EVT-0011',
      },
      {
        // Was "none", with a note calling that a known fact. It stopped being one.
        label: 'Providers run against real accounts',
        value: '2 of 2',
        note: 'Resend on 19 September 2026, HubSpot on 20 September. Both have supported a verified run; one has contradicted a run on a mismatched correlation reference. Against our own accounts and synthetic records.',
        source: 'docs/workflow-evidence.md',
      },
    ],
  },
  {
    id: 'money',
    title: 'Money and models',
    intro: 'Where a figure was not read from a bill or a tool, it is unknown, not zero.',
    metrics: [
      {
        label: 'Spent so far',
        value: '£0.00',
        note: 'Of the £100 budget.',
        source: 'docs/development-story.md § Where it stands',
      },
      {
        label: 'Contingency',
        value: '£30',
        note: 'Untouched.',
        source: 'docs/development-story.md § Where it stands',
      },
      {
        label: 'Model usage cost',
        value: null,
        note: 'The tooling exposes no cost; no billing statement has been read. The independent audit asked for an estimate to sit beside the £0.00.',
        source: 'docs/model-routing.md § Honesty rules; docs/audit-summary.md',
      },
      {
        label: 'Tokens consumed',
        value: null,
        note: 'Not exposed by the tooling; not estimated.',
        source: 'docs/model-routing.md § Honesty rules',
      },
      {
        label: 'Cloudflare plan tier',
        value: null,
        note: 'Inferred from an existing count of 13 D1 databases exceeding the free tier, not read from a billing API.',
        source: 'EVT-0001 (limitations)',
      },
      {
        label: 'Worst-case external calls per workspace per month',
        value: '4,000',
        note: 'An estimate made before the connectors were implemented, recorded as an estimate.',
        source: 'EVT-0005 (limitations)',
      },
    ],
  },
  {
    id: 'audit',
    title: 'Independent audit, public summary',
    intro:
      'A separate agent whose only job is to check whether the others’ claims are true. These are its published figures, relayed here as published; this page has not checked them again.',
    metrics: [
      {
        label: 'Distinct test cases counted from the runner’s own output',
        value: '1,951',
        source: 'docs/audit-summary.md',
      },
      {
        label: 'Cases skipped',
        value: '2',
        note: 'Both deliberately: the only two tests permitted to contact a real provider, which skip because no provider credential exists.',
        source: 'docs/audit-summary.md',
      },
      {
        label: 'Findings raised',
        value: '23',
        note: 'Nothing is closed without the auditor re-running the test independently.',
        source: 'docs/audit-summary.md',
      },
      {
        label: 'Release gate',
        value: 'blocked',
        note: 'The public site was judged live, accurate and safe; taking payment was judged not ready.',
        source: 'docs/audit-summary.md § The verdict',
      },
      {
        label: 'Published uptime figure',
        value: null,
        note: 'None is published, on purpose.',
        source: 'apps/app/src/routes/public/index.ts (/status description)',
      },
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Where it stands
 * ------------------------------------------------------------------ */

export interface StandingItem extends Sourced {
  readonly heading: string;
  readonly body: string;
}

export const STANDING: readonly StandingItem[] = [
  {
    heading: 'Built and tested',
    body: 'The verification engine, the data layer, the security primitives, the connectors, payments, the customer journey, support and privacy handling.',
    source: 'docs/development-story.md § Where it stands',
  },
  {
    heading: 'Live',
    body: 'verify.itisyou.app, serving over TLS, with a health check that actually probes the database instead of returning a hard-coded "ok".',
    source: 'docs/development-story.md § Where it stands; EVT-0003, EVT-0011',
  },
  {
    heading: 'Not yet true',
    body: 'Live customer payments, because that needs the owner’s approval and verified business details; one sandbox payment has completed end to end on a deployment. Ten genuine external visits: the counter now records them and the honest count is still zero. Per-screen layout against every approved design. What is no longer on this list, because it stopped being true on 20 September 2026: provider-backed evidence. Both connectors have now been run against real provider accounts and have supported, contradicted and failed to answer real runs — against our own accounts and our own synthetic records, which proves the providers answer us and not anything about your portal until you connect it. Advertising: a campaign is drafted within an approved budget, has never served an impression, and has spent nothing.',
    source: 'docs/development-story.md § Where it stands; docs/workflow-evidence.md',
  },
  {
    // Heading reworded 2026-09-19. "Independently audited" is the exact phrasing a security
    // attestation uses, and this business holds none — the audit meant here is one specialist
    // agent on this project reviewing another's work against the code. A reader scanning
    // claim-scan:allow names the attestations in order to deny holding them; the denial is the point
    // headings should not be able to take an internal review for SOC 2 or ISO 27001.
    heading: 'Reviewed by a second specialist, in-house',
    body: 'Not a security attestation and not a third-party audit: one agent on this project reviewing another’s work against the code. The public website: live and safe to use, with twelve overstated claims corrected on 19 September. Taking payment: not ready; release is blocked. No review of a moving tree is valid for longer than it takes to run.',
    source: 'docs/audit-summary.md § The verdict; docs/product-scope.md § 11',
  },
];
