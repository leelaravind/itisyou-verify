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
  AssertionRow,
  Button,
  ButtonRow,
  Breadcrumb,
  Card,
  ClaimRule,
  CoverageNotice,
  EmptyState,
  KeyValues,
  Pagination,
  RunVerdict,
  StandingLimitations,
  StatusBadge,
  Table,
  html,
  type Html,
  type StatusKey,
} from '@verify/ui';
import { describeCoverage, explainAssertion, explainRunStatus } from '@verify/domain';
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
  return value.replace(/[^\s,;<>"'()]+@[^\s,;<>"'()]+\.[^\s,;<>"'()]+/g, (address) => maskEmail(address));
}

export interface RunListPageOptions {
  readonly page: RunPage;
  readonly workflowName: string;
  readonly basePath: string;
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

    ${items.length === 0
      ? EmptyState({
          title: 'No runs received yet',
          body:
            'Nothing has reached us for this workflow. That is not a pass — if you expected enquiries by now, your automation may not be sending us events.',
          actions: [Button({ label: 'Check your setup', href: '/app/onboarding/activation' })],
        })
      : html`<div class="stack">
          ${Table({
            caption: `Runs for ${options.workflowName}`,
            captionHidden: true,
            columns: [
              { key: 'status', header: 'Result', cell: (run) => StatusBadge({ status: run.status as StatusKey }) },
              {
                key: 'id',
                header: 'Run',
                rowHeader: true,
                cell: (run) => html`<a class="mono" href="/app/runs/${run.id}">${run.id}</a>`,
              },
              { key: 'summary', header: 'Enquiry', cell: (run) => html`<span class="mono">${maskValues(run.summary)}</span>` },
              { key: 'ref', header: 'Reference', cell: (run) => html`<span class="mono">${run.correlationId}</span>` },
              { key: 'occurred', header: 'Received', numeric: true, cell: (run) => formatInstant(run.occurredAt) },
              {
                key: 'decided',
                header: 'Decided',
                numeric: true,
                cell: (run) => (run.decidedAt === null ? 'still checking' : formatInstant(run.decidedAt)),
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
            newerHref: options.page.prevCursor === null ? null : `${options.basePath}?cursor=${options.page.prevCursor}`,
            olderHref: options.page.nextCursor === null ? null : `${options.basePath}?cursor=${options.page.nextCursor}`,
            shown: items.length,
            noun: 'runs',
            label: 'Run list pages',
          })}
        </div>`}

    ${StandingLimitations()}
  </div>`;
}

export interface RunDetailPageOptions {
  readonly run: RunDetailView;
}

export function RunDetailPage(options: RunDetailPageOptions): Html {
  const run = options.run;
  const explanation = explainRunStatus(run.status);
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

  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([
      { label: 'Workspace', href: '/app' },
      { label: 'Runs', href: '/app/runs' },
      { label: run.id },
    ])}

    <div class="row-between">
      ${pageHead({ eyebrow: `Run ${run.id}`, title: maskValues(run.workflowName) ?? run.workflowName })}
      ${StatusBadge({ status: run.status as StatusKey, large: true })}
    </div>

    ${decisive === null
      ? null
      : ClaimRule({
          status: run.status as StatusKey,
          caption: decisive.label,
          claimLabel: 'Your rule expected',
          claim: maskValues(decisive.expected_display) ?? '',
          observedLabel: 'We retrieved',
          observed: maskValues(decisive.observed_display),
        })}

    ${Card({
      title: 'The verdict',
      headingLevel: 2,
      body: html`<div class="stack">
        ${RunVerdict({ status: run.status as StatusKey, explanation })}
        <p class="small mono">${run.statusReason}</p>
        ${run.lateCompletion
          ? html`<p class="small">
              The evidence arrived after the deadline had passed. The run is recorded as a late completion,
              which is a different thing from being on time.
            </p>`
          : null}
      </div>`,
    })}

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

    ${Card({ title: 'Coverage', headingLevel: 2, body: CoverageNotice(coverage) })}

    ${Card({
      title: 'Where this result came from',
      headingLevel: 2,
      body: KeyValues([
        ['Run id', html`<span>${run.id}</span>`],
        ['Revision', html`<span>${String(run.revision)}</span>`],
        ['Enquiry reference', html`<span>${run.correlationId}</span>`],
        ['Recipient', html`<span>${maskEmail(run.recipient)}</span>`],
        ['Source type', html`<span>${run.sourceType}</span>`],
        ['Rule version', html`<span>${run.rulesRef} · schema v${String(run.rulesSchemaVersion)}</span>`],
        ['Enquiry received', html`<span>${formatInstant(run.occurredAt)}</span>`],
        ['Deadline', html`<span>${formatInstant(run.deadlineAt)}</span>`],
        ['Last observed', html`<span>${formatInstant(run.observedAt)}</span>`],
        ['Decided at', html`<span>${run.decidedAt === null ? 'not decided yet' : formatInstant(run.decidedAt)}</span>`],
      ]),
    })}

    ${StandingLimitations()}

    ${ButtonRow([
      Button({ label: 'Back to all runs', href: '/app/runs', variant: 'quiet' }),
      Button({ label: 'Ask us about this run', href: `/app/support?run=${run.id}`, variant: 'quiet' }),
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
