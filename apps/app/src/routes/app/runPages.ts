/**
 * The run list and the run detail.
 *
 * Run detail is the page the whole product exists to produce, so it shows everything that
 * decided the verdict and hides none of it: expected against observed with addresses
 * masked, the provider event's own timestamp, where the evidence came from, which rule
 * version judged it, the coverage limitation, and every reason code translated into a
 * sentence a person can act on.
 */
import {
  Callout,
  AssertionBadge,
  AssertionRow,
  Button,
  ButtonRow,
  Breadcrumb,
  Card,
  ClaimRule,
  Comparator,
  CoverageNotice,
  EmptyState,
  KeyValues,
  Pagination,
  RunVerdict,
  StandingLimitations,
  StatusBadge,
  Table,
  attrs,
  gapsFrom,
  html,
  safeHref,
  type AssertionKey,
  type ComparatorRow,
  type Html,
  type StatusKey,
} from '@verify/ui';
import {
  describeCoverage,
  explainAssertion,
  explainRunStatus,
  type AssertionResult,
} from '@verify/domain';
import { maskEmail } from '@verify/security';
import { pageHead } from './chrome.js';
import { formatInstant } from '../public/shared.js';
import type { RunDetailView, RunPage } from './port.js';

/**
 * Mask every address-shaped token in a value before it reaches the page.
 *
 * Applied to the *observed* and *expected* displays as well as the summary, because an
 * expected value is customer data too — a rule that expects `finance@theirclient.com` is
 * just as much a disclosure as a record that contains it.
 */
export function maskValues(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/[^\s,;<>"'()]+@[^\s,;<>"'()]+\.[^\s,;<>"'()]+/g, (address) =>
    maskEmail(address),
  );
}

export interface RunListPageOptions {
  readonly page: RunPage;
  readonly workflowName: string;
  readonly basePath: string;
  /** Which runs this listing is showing. `all` is the default and shows both. */
  readonly source?: 'all' | 'real' | 'test';
}

/**
 * The filter strip, and the sentence that says what is being counted.
 *
 * A test run was labelled on its own page and excluded from the verification rate, but the
 * list showed it with no mark at all, so a customer scanning their runs read their own
 * tests as customer failures. Naming the filter in the page means the count under the table
 * can never be mistaken for the whole workspace.
 */
function sourceFilter(basePath: string, active: 'all' | 'real' | 'test'): Html {
  const link = (value: 'all' | 'real' | 'test', label: string): Html => {
    const href = value === 'all' ? basePath : `${basePath}?show=${value}`;
    return value === active
      ? html`<span ${attrs({ class: 'chip chip--on', 'aria-current': 'true' })}>${label}</span>`
      : html`<a ${attrs({ class: 'chip', href: safeHref(href) })}>${label}</a>`;
  };
  return html`<nav ${attrs({ class: 'cluster', 'aria-label': 'Filter runs by origin' })}>
    <span class="small">Showing</span>
    ${link('all', 'All runs')} ${link('real', 'From your automation')} ${link('test', 'Your tests')}
  </nav>`;
}

export function RunListPage(options: RunListPageOptions): Html {
  const items = options.page.items;
  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Runs' }])}
    ${pageHead({
      eyebrow: 'Runs',
      title: options.workflowName,
      lede: 'Newest first. A run is one enquiry your automation told us about, checked against the evidence we read back.',
    })}
    ${sourceFilter(options.basePath, options.source ?? 'all')}

    ${
      items.length === 0
        ? EmptyState({
            title: 'No runs received yet',
            body: 'Nothing has reached us for this workflow. That is not a pass: if you expected enquiries by now, your automation may not be sending us events.',
            actions: [Button({ label: 'Check your setup', href: '/app/onboarding/activation' })],
          })
        : html`<div class="stack">
          ${Table({
            caption: `Runs for ${options.workflowName}`,
            captionHidden: true,
            columns: [
              {
                key: 'status',
                header: 'Result',
                cell: (run) => StatusBadge({ status: run.status as StatusKey }),
              },
              {
                key: 'id',
                header: 'Run',
                rowHeader: true,
                cell: (run) =>
                  html`<a ${attrs({ class: 'mono', href: safeHref(`/app/runs/${encodeURIComponent(run.id)}`) })}
                    >${run.id}</a
                  >${
                    run.isTest
                      ? html` <span ${attrs({ class: 'chip chip--test', title: 'You started this one from your workspace. It cost a run and is left out of your verification rate.' })}>TEST</span>`
                      : null
                  }`,
              },
              // The column headed "Enquiry" carried the run's VERDICT sentence, not its
              // enquiry -- redundant beside the Result badge in the same row, and, once
              // the absence verdict gained its longer wording, tall enough to push a row
              // to ten lines. The sentence lives on the run's own page, one click away.
              {
                key: 'ref',
                header: 'Enquiry reference',
                cell: (run) => html`<span class="mono">${run.correlationId}</span>`,
              },
              {
                key: 'occurred',
                header: 'Received',
                numeric: true,
                cell: (run) => formatInstant(run.occurredAt),
              },
              {
                key: 'decided',
                header: 'Decided',
                numeric: true,
                cell: (run) =>
                  run.decidedAt === null ? 'still checking' : formatInstant(run.decidedAt),
              },
              {
                key: 'checks',
                header: 'Required checks',
                numeric: true,
                cell: (run) => `${run.mandatorySupported}/${run.mandatoryTotal}`,
              },
            ],
            rows: items,
          })}
          ${Pagination({
            newerHref:
              options.page.prevCursor === null
                ? null
                : `${options.basePath}?cursor=${options.page.prevCursor}`,
            olderHref:
              options.page.nextCursor === null
                ? null
                : `${options.basePath}?cursor=${options.page.nextCursor}`,
            shown: items.length,
            noun: 'runs',
            label: 'Run list pages',
          })}
        </div>`
    }

    ${StandingLimitations()}
  </div>`;
}

export interface RunDetailPageOptions {
  readonly run: RunDetailView;
}

/** The four check outcomes in the domain's order. */
const CHECK_ORDER: readonly AssertionKey[] = ['SUPPORTED', 'CONTRADICTED', 'UNKNOWN', 'PENDING'];

/**
 * How many checks reached each outcome, beside the verdict — the approved run-detail
 * screen's head strip.
 *
 * Only outcomes that occurred are listed. This is deliberately not "all four, always": an
 * entry reading "Not as expected 0" would put the red mark on the page of a run in which
 * nothing was contradicted, and an UNVERIFIED run must never be dressed as a failure
 * (CUST-063). Each count is the number of results wearing that status, nothing derived.
 */
function checkTally(results: readonly AssertionResult[]): Html {
  const present = CHECK_ORDER.filter((status) => results.some((result) => result.status === status));
  return html`<ul class="tally" aria-label="Checks by result">
    ${present.map(
      (status) => html`<li data-check-tally="${status}">
        <span class="tally__count">${String(results.filter((result) => result.status === status).length)}</span>
        ${AssertionBadge({ status })}
      </li>`,
    )}
  </ul>`;
}

/**
 * Composition follows the approved run-detail screen, translated: the head beside a mono
 * bar of the run's own instants; a verdict band ruled in the verdict's colour, carrying the
 * verdict on the left and the check tally on the right, with the run's identifiers as a bar
 * of metrics under it; the comparator; then the checks in the wider column and the
 * provenance and coverage in the narrower one; the standing limitations last. The reference
 * names providers, endpoints, hashes and a guarantee that are not ours; none of its words
 * are here.
 */
export function RunDetailPage(options: RunDetailPageOptions): Html {
  const run = options.run;
  const explanation = explainRunStatus(run.status, run.results);
  const coverage = describeCoverage({ coverage_mode: run.coverageMode });

  /**
   * The claim rule summarises the check that actually decided the run — the first required
   * check that is not confirmed, or, when everything passed, the last one. Showing the first
   * check in the list instead would put "a CRM record was created: crm-rec-1" at the top of a
   * failed run, which reads as reassurance on a page that is reporting a problem.
   */
  const decisive =
    run.results.find((result) => result.mandatory && result.status !== 'SUPPORTED') ??
    run.results[run.results.length - 1] ??
    null;

  /**
   * The comparator: every check, what the workflow reported beside what we retrieved, with
   * a verdict per row and the run's verdict — the domain's decision, not a re-derivation —
   * under it. With a single check the simpler claim rule says the same thing in less room.
   * Addresses are masked on both sides: an expected value is customer data too.
   */
  const comparatorRows: readonly ComparatorRow[] = run.results.map((result) => ({
    field: result.label,
    status: result.status,
    reported: maskValues(result.expected_display) ?? '',
    retrieved: maskValues(result.observed_display),
    reason:
      result.status === 'UNKNOWN' || result.status === 'PENDING'
        ? explainAssertion(result).sentence
        : null,
  }));

  const statusKey = run.status.toLowerCase();

  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([
      { label: 'Workspace', href: '/app' },
      { label: 'Runs', href: '/app/runs' },
      { label: run.id },
    ])}

    <div class="section-head">
      ${pageHead({ eyebrow: `Run ${run.id}`, title: maskValues(run.workflowName) ?? run.workflowName })}
      <ul class="meta-bar" aria-label="About this run">
        <li>Enquiry received <b>${formatInstant(run.occurredAt)}</b></li>
        <li>Deadline <b>${formatInstant(run.deadlineAt)}</b></li>
        <li>Last observed <b>${formatInstant(run.observedAt)}</b></li>
      </ul>
    </div>

    <!-- A test run said so only in "Source type: owner_test", four cards down. An independent
         verifier read this page and could not tell it from customer traffic, which is the
         confusion this product exists to refuse: a figure you cannot place is worse than no
         figure. It is named here, in words, above the verdict. -->
    ${
      run.sourceType !== 'owner_test'
        ? null
        : Callout({
            tone: 'note',
            title: 'You started this one',
            body: html`<p data-test-run-notice>
              This is a test verification you ran from your workspace, not an enquiry your automation
              reported. It cost one run from your allowance and is left out of your verification rate, so
              it cannot make your figures look better or worse than they are.
            </p>`,
          })
    }

    <!-- The verdict band. The shared status card as a section: the rule along its top is the
         verdict's colour (dashed for UNVERIFIED, like its badge), and the badge inside
         RunVerdict is the signal that survives greyscale. Nothing in the band is derived
         from the results here; the verdict is the domain's decision, passed through. -->
    <section class="status-card status-card--${statusKey}" data-run-band="${run.status}">
      <div class="section-head">
        <div class="section-head__text">
          ${RunVerdict({
            status: run.status as StatusKey,
            explanation,
            // The follow-up line an UNVERIFIED verdict must carry: which check could not be
            // completed, and the plain sentence for why. Ignored for the other three.
            gaps: gapsFrom(run.results, (result) => explainAssertion(result).sentence),
          })}
          <p class="small mono">${run.statusReason}</p>
          ${
            run.lateCompletion
              ? html`<p class="small">
                The evidence arrived after the deadline had passed. The run is recorded as a late completion,
                which is a different thing from being on time.
              </p>`
              : null
          }
        </div>
        ${checkTally(run.results)}
      </div>
      <dl class="metrics" aria-label="This run">
        <div>
          <dt>Run id</dt>
          <dd class="mono">${run.id}</dd>
        </div>
        <div>
          <dt>Revision</dt>
          <dd class="mono">${String(run.revision)}</dd>
        </div>
        <div>
          <dt>Enquiry reference</dt>
          <dd class="mono">${run.correlationId}</dd>
        </div>
        <div>
          <dt>Recipient</dt>
          <dd class="mono">${maskEmail(run.recipient)}</dd>
        </div>
      </dl>
    </section>

    ${
      run.results.length > 1
        ? Comparator({
            caption: `Enquiry ${run.correlationId} · ${maskValues(run.workflowName) ?? run.workflowName}`,
            detail: `Last observed ${formatInstant(run.observedAt)} · window closed ${formatInstant(run.deadlineAt)}`,
            rows: comparatorRows,
            verdict: run.status as StatusKey,
          })
        : decisive === null
          ? null
          : ClaimRule({
              status: run.status as StatusKey,
              caption: decisive.label,
              claimLabel: 'Your rule expected',
              claim: maskValues(decisive.expected_display) ?? '',
              observedLabel: 'We retrieved',
              observed: maskValues(decisive.observed_display),
            })
    }

    <div class="grid grid-7-5">
      <div class="stack">
        ${Card({
          title: 'Expected against observed',
          headingLevel: 2,
          body: html`<div>
            ${run.results.map((result) => {
              const assertion = explainAssertion(result);
              return AssertionRow({
                status: result.status,
                explanation: {
                  rule_id: assertion.rule_id,
                  headline: assertion.headline,
                  sentence: assertion.sentence,
                  next_step: assertion.next_step,
                  detail: maskValues(assertion.detail),
                },
                origin: result.evidence_ref === null ? 'no evidence' : 'provider readback',
                mandatory: result.mandatory,
                observedAt: result.observed_at === null ? null : formatInstant(result.observed_at),
                reasonCode: result.reason_code,
              });
            })}
          </div>`,
        })}
      </div>
      <div class="stack">
        ${Card({
          title: 'Where this result came from',
          headingLevel: 2,
          body: KeyValues([
            ['Source type', html`<span>${run.sourceType}</span>`],
            [
              'Rule version',
              html`<span>${run.rulesRef} · schema v${String(run.rulesSchemaVersion)}</span>`,
            ],
            [
              'Decided at',
              html`<span>${run.decidedAt === null ? 'not decided yet' : formatInstant(run.decidedAt)}</span>`,
            ],
          ]),
        })}
        ${Card({ title: 'Coverage', headingLevel: 2, body: CoverageNotice(coverage) })}
      </div>
    </div>

    ${StandingLimitations()}

    ${ButtonRow([
      Button({ label: 'Back to all runs', href: '/app/runs', variant: 'quiet' }),
      Button({
        label: 'Ask us about this run',
        href: `/app/support?run=${encodeURIComponent(run.id)}`,
        variant: 'quiet',
      }),
    ])}
  </div>`;
}

/** A run that does not exist, or is not this workspace's. The page never says which. */
export function RunNotFoundPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Runs', href: '/app/runs' }, { label: 'Not found' }])}
    ${EmptyState({
      title: 'No run with that reference',
      body: 'There is no run with that reference in this workspace. Check the link, or open the run from your run list.',
      actions: [Button({ label: 'Back to all runs', href: '/app/runs', variant: 'primary' })],
    })}
  </div>`;
}
