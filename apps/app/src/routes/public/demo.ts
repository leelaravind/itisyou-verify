/**
 * The demo page — the product demonstration.
 *
 * One labelled synthetic workspace, four real runs. The verdicts, the assertion results and
 * every sentence of explanation are produced by A03's real `evaluate`, `decide` and
 * `explain` modules over the shared synthetic fixtures. Nothing on this page is written to
 * look like a result; it *is* a result, of a run against invented evidence.
 *
 * Three hard rules this page keeps:
 *   - It is unmistakably marked synthetic, in the header, in a stripe above the content,
 *     and beside every run.
 *   - It touches no database and reads no session.
 *   - It accepts no input. There is no form, no query parameter and no state; the only
 *     interactive elements are in-page anchors and links to other pages.
 */
import {
  AssertionRow,
  Callout,
  Card,
  ClaimRule,
  Comparator,
  CoverageNotice,
  ProviderProofNotice,
  HealthReadout,
  KeyValues,
  RunVerdict,
  StandingLimitations,
  StatusBadge,
  Table,
  attrs,
  gapsFrom,
  html,
  safeHref,
  type ComparatorRow,
  type Html,
  type StatusKey,
} from '@verify/ui';
import { maskEmail } from '@verify/security';
import { DEMO_COVERAGE, DEMO_HEALTH, DEMO_RULES, DEMO_RUNS, type DemoRun } from './demoData.js';
import { formatDuration, formatInstant } from './shared.js';

/**
 * Mask anything address-shaped before it reaches the page.
 *
 * The demo's addresses are synthetic, so masking them protects nobody — it is here because
 * this is the same rendering path the real run detail uses, and a demo that shows raw
 * addresses would teach the wrong expectation about what the real product displays.
 */
export function maskDisplayValue(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/[^\s,;<>"']+@[^\s,;<>"']+\.[^\s,;<>"']+/g, (address) => maskEmail(address));
}

/** The stripe that sits between the header and the content on every synthetic page. */
export function syntheticStripe(): Html {
  return html`<p class="synthetic__stripe" role="note">
    Synthetic data — nothing on this page is a real customer, record or message
  </p>`;
}

function runAnchor(run: DemoRun): string {
  return `#${run.id}`;
}

/** The run list, exactly as the real workspace renders it. */
function runList(): Html {
  return Table({
    caption: 'The four runs in this synthetic workspace',
    columns: [
      {
        key: 'status',
        header: 'Result',
        cell: (run: DemoRun) => StatusBadge({ status: run.status as StatusKey }),
      },
      {
        key: 'run',
        header: 'Run',
        rowHeader: true,
        cell: (run: DemoRun) =>
          html`<a ${attrs({ class: 'mono', href: safeHref(runAnchor(run)) })}>${run.id}</a>`,
      },
      {
        key: 'enquiry',
        header: 'Enquiry',
        cell: (run: DemoRun) => html`<span class="mono">${maskDisplayValue(run.summary)}</span>`,
      },
      {
        key: 'occurred',
        header: 'Enquiry received',
        numeric: true,
        cell: (run: DemoRun) => formatInstant(run.occurredAt),
      },
      {
        key: 'checks',
        header: 'Required checks',
        numeric: true,
        cell: (run: DemoRun) => `${run.mandatory.supported}/${run.mandatory.total} confirmed`,
      },
    ],
    rows: DEMO_RUNS,
  });
}

/** The plain sentence A03's `explainRun()` produced for one of this run's checks. */
function sentenceFor(run: DemoRun, ruleId: string): string {
  return run.assertionExplanations.find((e) => e.rule_id === ruleId)?.sentence ?? '';
}

/**
 * One run, in full: the comparator, the verdict, every check, and the evidence metadata.
 *
 * The comparator is the same component the real run detail renders, fed by the same
 * `AssertionResult` shape, so the demo cannot show a comparison the product would not.
 */
function runDetail(run: DemoRun): Html {
  const rows: readonly ComparatorRow[] = run.results.map((result) => ({
    field: result.label,
    status: result.status,
    reported: maskDisplayValue(result.expected_display) ?? '',
    retrieved: maskDisplayValue(result.observed_display),
    reason:
      result.status === 'UNKNOWN' || result.status === 'PENDING'
        ? sentenceFor(run, result.rule_id)
        : null,
  }));

  // One framed panel per run, as the reference frames each inspection record. The verdict
  // badge sits opposite the heading, at the large size, and is the only coloured thing in
  // the head: an UNVERIFIED run gets the same frame and the same weight as a VERIFIED one.
  return html`<section class="panel" id="${run.id}" data-demo-run="${run.status}">
    <div class="section-head">
      <div class="section-head__text">
        <p class="eyebrow">Run ${run.id}</p>
        <h2>${maskDisplayValue(run.summary)}</h2>
      </div>
      ${StatusBadge({ status: run.status as StatusKey, large: true })}
    </div>

    ${
      run.results.length > 1
        ? Comparator({
            caption: `Enquiry ${run.correlationId} — ${maskDisplayValue(run.summary) ?? ''}`,
            detail: `Checked ${formatInstant(run.decidedAt)} · window closed ${formatInstant(run.deadlineAt)}`,
            rows,
            verdict: run.status as StatusKey,
          })
        : ClaimRule({
            status: run.status as StatusKey,
            claim: maskDisplayValue(run.claim) ?? '',
            observed: maskDisplayValue(run.observed),
          })
    }

    ${Card({
      title: 'The verdict',
      headingLevel: 3,
      body: html`<div class="stack">
        ${RunVerdict({
          status: run.status as StatusKey,
          explanation: run.explanation,
          gaps: gapsFrom(run.results, (result) => sentenceFor(run, result.rule_id)),
        })}
        <p class="small mono">${run.decisionReason}</p>
      </div>`,
    })}

    ${Card({
      title: `Every check we made (${run.mandatory.total} required, ${run.mandatory.optional_total} optional)`,
      headingLevel: 3,
      body: html`<div>
        ${run.results.map((result, index) => {
          const explanation = run.assertionExplanations[index];
          if (explanation === undefined) return null;
          return AssertionRow({
            status: result.status,
            explanation: {
              rule_id: explanation.rule_id,
              headline: explanation.headline,
              sentence: explanation.sentence,
              next_step: explanation.next_step,
              detail: maskDisplayValue(explanation.detail),
            },
            origin: 'provider readback',
            mandatory: result.mandatory,
            observedAt: result.observed_at === null ? null : formatInstant(result.observed_at),
            reasonCode: result.reason_code,
          });
        })}
      </div>`,
    })}

    ${Card({
      title: 'Where this result came from',
      headingLevel: 3,
      body: KeyValues([
        ['Run id', html`<span>${run.id}</span>`],
        ['Enquiry reference', html`<span>${run.correlationId}</span>`],
        ['Source type', html`<span>${run.sourceType}</span>`],
        [
          'Rule version',
          html`<span>${run.rulesRef} · schema v${String(DEMO_RULES.schema_version)}</span>`,
        ],
        ['Enquiry received', html`<span>${formatInstant(run.occurredAt)}</span>`],
        ['Completion window', html`<span>${formatDuration(DEMO_RULES.deadline_seconds)}</span>`],
        ['Deadline', html`<span>${formatInstant(run.deadlineAt)}</span>`],
        ['Decided at', html`<span>${formatInstant(run.decidedAt)}</span>`],
        ['Coverage mode', html`<span>${DEMO_RULES.coverage_mode}</span>`],
      ]),
    })}

    <p class="micro">
      <a href="#demo-runs">Back to the run list</a>
    </p>
  </section>`;
}

/** The rules this synthetic workflow is checking, so nothing about the verdict is hidden. */
function ruleTable(): Html {
  return Table({
    caption: 'The checks this workflow is configured to make',
    columns: [
      { key: 'label', header: 'Check', rowHeader: true, cell: (rule) => rule.label },
      { key: 'source', header: 'Evidence source', cell: (rule) => rule.source },
      {
        key: 'field',
        header: 'Field',
        cell: (rule) => html`<span class="mono">${rule.field}</span>`,
      },
      {
        key: 'operator',
        header: 'Operator',
        cell: (rule) => html`<span class="mono">${rule.operator}</span>`,
      },
      { key: 'required', header: 'Required', cell: (rule) => (rule.mandatory ? 'yes' : 'no') },
    ],
    rows: DEMO_RULES.assertions,
  });
}

/** The four statuses, in the contract's order, so the tally always has four entries. */
const TALLY_ORDER: readonly StatusKey[] = ['VERIFIED', 'FAILED', 'UNVERIFIED', 'PENDING'];

/**
 * One count per status under the run list — all four, always, including any that are zero.
 *
 * The reference closes its results table with a strip of counts. Ours is computed from the
 * runs the engine actually produced, and the colour comes only from the badge component, so
 * an UNVERIFIED count can never be drawn as a pass here any more than in the table above.
 */
function runTally(): Html {
  return html`<ul class="tally" aria-label="Runs by result">
    ${TALLY_ORDER.map(
      (status) => html`<li data-tally="${status}">
        <span class="tally__count">${String(DEMO_RUNS.filter((run) => run.status === status).length)}</span>
        ${StatusBadge({ status })}
      </li>`,
    )}
  </ul>`;
}

/**
 * Composition follows the approved how-it-works / demonstration screen: a framed hero panel
 * whose head sits beside a mono bar of facts about the workflow; the health pair; then the
 * run list framed as a results panel — the amber-results callout above the table, the tally
 * below it; then the rules, one framed panel per run, and the standing limitations. The
 * synthetic banner keeps its place at the very top of the panel, above the heading, because
 * it is the single most important sentence on the page. Every fact in the meta bar is read
 * from the demo's own rules and runs; nothing is typed in.
 */
export function DemoPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${
      // This page omitted it while `/` and `/how-it-works` both carried it, which made the
      // demo the single public page where the provider-proof qualification disappeared --
      // and the one a paid advert would send people to. A disclosure that is absent from
      // the page traffic lands on is not a disclosure.
      ProviderProofNotice()
    }
    <section class="panel panel--hero">
      <div class="synthetic">
        <p class="synthetic__tag">Synthetic workspace</p>
        <p class="small">
          Every record, address, account and message on this page is invented. There is no customer here,
          no database is read, and this page accepts no input. The four results below were produced by
          running the live verification engine against fixed synthetic evidence, so they are real verdicts
          about fake facts.
        </p>
      </div>

      <div class="section-head">
        <div class="section-head__text">
          <p class="eyebrow">Worked example</p>
          <h1>One workflow, four runs, four honest answers</h1>
          <p class="lede">
            This is what the product looks like when it is working. Two of these four runs are not a pass,
            and that is the point: a tool that could only show you green would not be worth connecting.
          </p>
        </div>
        <ul class="meta-bar" aria-label="About this workflow">
          <li>Runs <b>${String(DEMO_RUNS.length)}</b></li>
          <li>Rule version <b>${DEMO_RUNS[0]?.rulesRef ?? ''}</b></li>
          <li>Completion window <b>${formatDuration(DEMO_RULES.deadline_seconds)}</b></li>
          <li>Coverage mode <b>${DEMO_RULES.coverage_mode}</b></li>
        </ul>
      </div>
    </section>

    <div class="health">
      ${Card({ title: 'Verification rate', headingLevel: 2, body: HealthReadout(DEMO_HEALTH) })}
      ${Card({ title: 'Coverage', headingLevel: 2, body: CoverageNotice(DEMO_COVERAGE) })}
    </div>

    <section class="stack" id="demo-runs">
      <h2>Runs</h2>
      <div class="results">
        ${Callout({
          tone: 'limit',
          title: 'Read the two amber results carefully',
          body: html`<p>
              "Unverified" is not a failure. It means we could not retrieve the evidence — in this example the
              HubSpot authorisation had expired — so we are telling you we could not look, rather than guessing.
            </p>
            <p>
              "Pending" means the agreed completion window is still open. Neither of them is a verdict about
              your automation.
            </p>`,
        })}
        ${runList()}
        <div class="results__bar">${runTally()}</div>
      </div>
    </section>

    <section class="stack">
      <h2>What this workflow checks</h2>
      ${ruleTable()}
      ${Callout({
        tone: 'limit',
        title: 'What the last check proves, and how that was proven',
        body: html`<p>
            These are the checks a real workspace gets from its onboarding form, produced by the same
            code. This page performs no check a customer's workflow could not. The last one compares
            the address the acknowledgement actually went to with the address this enquiry named, after
            lowercasing and trimming — and without stripping <span class="mono">+tags</span>, so an
            address the sender controls does not stand in for the enquirer's.
          </p>
          <p>
            That comparison is proven in the test suite against an in-process harness: a run whose
            acknowledgement went to the wrong address comes back failed, not verified. It has not run
            against a live Resend account, because no such credential exists yet.
          </p>`,
      })}
    </section>

    ${DEMO_RUNS.map((run) => runDetail(run))}

    ${StandingLimitations()}
  </div>`;
}
