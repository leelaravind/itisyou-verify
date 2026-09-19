/**
 * The workspace dashboard.
 *
 * The one screen a customer looks at most, so it is the one most at risk of flattering
 * them. Three rules it keeps:
 *   - the verification rate and the activity signal sit side by side, never merged;
 *   - a workflow with no runs shows a headline, not a bar;
 *   - the coverage limitation is on the page, in the flow, at full size.
 */
import {
  Button,
  ButtonRow,
  Card,
  CoverageNotice,
  HealthReadout,
  InactivityNotice,
  StandingLimitations,
  StatusBadge,
  Table,
  attrs,
  html,
  safeHref,
  type Html,
  type StatusKey,
} from '@verify/ui';
import { describeCoverage, detectInactivity, summariseWorkflowHealth } from '@verify/domain';
import { connectionPresentation, pageHead } from './chrome.js';
import { formatDuration, formatInstant } from '../public/shared.js';
import type { ConnectionView, RunListItem, UsageView, WorkflowDetail } from './port.js';

export interface WorkspacePageOptions {
  readonly workflow: WorkflowDetail | null;
  readonly recentRuns: readonly RunListItem[];
  readonly connections: readonly ConnectionView[];
  readonly usage: UsageView;
  /** Injected so the page is deterministic in tests and never reads a clock itself. */
  readonly now: Date;
}

/**
 * How long a quiet stretch may last before it is worth mentioning, derived from the
 * workflow's own completion window: six windows of silence is the point at which "quiet
 * business" and "automation stopped calling us" become worth separating.
 */
function expectedActivity(deadlineSeconds: number): {
  window_seconds: number;
  minimum_events: number;
} {
  return { window_seconds: deadlineSeconds * 6, minimum_events: 1 };
}

function connectionRow(connection: ConnectionView): Html {
  return html`<div class="margin-row">
    <div class="margin-row__gutter">${StatusBadge(connectionPresentation(connection.status))}</div>
    <div class="stack-sm">
      <h3>${connection.displayName}</h3>
      ${
        connection.problem === null
          ? html`<p class="small muted">Last checked ${formatInstant(connection.lastCheckedAt)}.</p>`
          : html`<p class="small">${connection.problem}</p>`
      }
      ${
        connection.nextStep === null
          ? null
          : html`<p class="small"><strong>Next step.</strong> ${connection.nextStep}</p>`
      }
    </div>
  </div>`;
}

export function WorkspacePage(options: WorkspacePageOptions): Html {
  if (options.workflow === null) {
    return html`<div class="wrap section stack-lg">
      ${pageHead({
        eyebrow: 'Workspace',
        title: 'No workflow set up yet',
        lede: 'Nothing is being checked. An empty workspace is not a passing workspace.',
      })}
      ${ButtonRow([
        Button({
          label: 'Start the setup',
          href: '/app/onboarding/compatibility',
          variant: 'primary',
        }),
      ])}
    </div>`;
  }

  const workflow = options.workflow;
  const health = summariseWorkflowHealth(workflow.counts);
  const inactivity = detectInactivity({
    lastEventAt: workflow.lastEventAt === null ? null : new Date(workflow.lastEventAt),
    expectedActivity: expectedActivity(workflow.deadlineSeconds),
    now: options.now,
  });
  const coverage = describeCoverage({ coverage_mode: workflow.coverageMode });
  const usedPercent = Math.round((options.usage.runsUsed / options.usage.runsIncluded) * 100);

  return html`<div class="wrap section stack-lg">
    ${pageHead({ eyebrow: 'Workspace', title: workflow.name })}

    <div class="health">
      ${Card({ title: 'Verification rate', headingLevel: 2, body: HealthReadout(health) })}
      ${Card({ title: 'Are enquiries still arriving?', headingLevel: 2, body: InactivityNotice(inactivity) })}
    </div>

    ${Card({ title: 'Coverage', headingLevel: 2, body: CoverageNotice(coverage) })}

    ${Card({
      title: 'Recent runs',
      headingLevel: 2,
      aside: html`<a href="/app/runs">All runs</a>`,
      body: Table({
        caption: 'The most recent runs in this workspace',
        captionHidden: true,
        columns: [
          {
            key: 'status',
            header: 'Result',
            cell: (run: RunListItem) => StatusBadge({ status: run.status as StatusKey }),
          },
          {
            key: 'id',
            header: 'Run',
            rowHeader: true,
            cell: (run: RunListItem) =>
              html`<a ${attrs({ class: 'mono', href: safeHref(`/app/runs/${encodeURIComponent(run.id)}`) })}
                >${run.id}</a
              >`,
          },
          {
            key: 'occurred',
            header: 'Enquiry received',
            numeric: true,
            cell: (run: RunListItem) => formatInstant(run.occurredAt),
          },
          {
            key: 'checks',
            header: 'Required checks',
            numeric: true,
            cell: (run: RunListItem) => `${run.mandatorySupported}/${run.mandatoryTotal}`,
          },
        ],
        rows: options.recentRuns,
      }),
    })}

    ${Card({
      title: 'Connection health',
      headingLevel: 2,
      aside: html`<a href="/app/connections">Manage connections</a>`,
      body: html`<div>${options.connections.map((connection) => connectionRow(connection))}</div>`,
    })}

    ${Card({
      title: 'This period',
      headingLevel: 2,
      aside: html`<a href="/app/usage">Usage detail</a>`,
      body: html`<dl class="kv">
        <dt>Runs used</dt>
        <dd>${String(options.usage.runsUsed)} of ${String(options.usage.runsIncluded)} (${String(usedPercent)}%)</dd>
        <dt>Period ends</dt>
        <dd>${formatInstant(options.usage.periodEnd)}</dd>
        <dt>Completion window</dt>
        <dd>${formatDuration(workflow.deadlineSeconds)}</dd>
        <dt>Correlation property</dt>
        <dd>${workflow.mapping.correlationProperty}</dd>
      </dl>`,
    })}

    ${StandingLimitations()}
  </div>`;
}
