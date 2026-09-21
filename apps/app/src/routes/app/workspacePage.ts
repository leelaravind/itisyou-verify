/**
 * The workspace dashboard.
 *
 * The one screen a customer looks at most, so it is the one most at risk of flattering
 * them. Three rules it keeps:
 *   - the verification rate and the activity signal sit side by side, never merged;
 *   - a workflow with no runs shows a headline, not a bar;
 *   - the coverage limitation is on the page, in the flow, at full size.
 *
 * ## Composition
 *
 * Laid out to the approved customer dashboard (desktop and phone references), translated
 * rather than copied: the head beside a mono bar of facts about the workflow; the four run
 * counts as four cards in one row (two abreast on a phone, as the phone reference draws
 * them); the period figures as a bar of metrics; the rate and the activity signal as a
 * pair; the recent runs framed as a results panel with a tally under the table and the
 * table stacking into records on a phone; coverage and connection health side by side; the
 * standing limitations last. Every figure is read from the port. No sentence was taken from
 * the reference, whose copy carries a payment state, a price and a plan that are not ours.
 */
import {
  SETUP_UNAVAILABLE_VIEWER_REASON,
  SETUP_UNAVAILABLE_VIEWER_WHEN,
  UnavailableAction,
  Button,
  ButtonRow,
  Card,
  EmptyState,
  LoadingState,
  CoverageNotice,
  HealthReadout,
  InactivityNotice,
  StandingLimitations,
  StatusBadge,
  Table,
  attrs,
  html,
  percentFloor,
  safeHref,
  type Html,
  type StatusKey,
} from '@verify/ui';
import { describeCoverage, detectInactivity, summariseWorkflowHealth } from '@verify/domain';
import { connectionPresentation, pageHead, runCountCards, runTally, runTotal } from './chrome.js';
import { formatDuration, formatInstant } from '../public/shared.js';
import type { ConnectionView, RunListItem, UsageView, WorkflowDetail } from './port.js';

export interface WorkspacePageOptions {
  readonly workflow: WorkflowDetail | null;
  readonly recentRuns: readonly RunListItem[];
  readonly connections: readonly ConnectionView[];
  readonly usage: UsageView;
  /** Injected so the page is deterministic in tests and never reads a clock itself. */
  readonly now: Date;
  /**
   * Whether this reader may actually start the setup, decided by the same rule the server
   * decides it by: `session.role === 'workspace_admin'`, which is what
   * `customerPort.saveFieldMapping` and `submitConnectionCredentials` already refuse on.
   *
   * It is a required option rather than one with a default. The bug this replaces was a
   * hard-coded `false`, and a default is the same hard-coded answer with a longer fuse:
   * every caller now has to say which reader it is rendering for.
   */
  readonly canStartSetup: boolean;
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
      <!--
        The way back into the product.

        This rendered an inert notice unconditionally until 21 September 2026, which meant
        a paying customer sitting inside their own workspace could not reach step 1 of
        their own setup from the one page that is meant to send them there. The setup
        routes worked the whole time; only the door was missing, and the reason it gave
        ("we are not taking payment or activating new workspaces yet") was about buying the
        product, not about using the one you have already got.

        The condition is now the server's own: a workspace admin gets a real link, a viewer
        gets the sentence the port would have answered them with anyway. Nothing here can
        offer a step the server would then refuse.
      -->
      ${
        options.canStartSetup
          ? ButtonRow([
              Button({
                label: 'Start the setup',
                href: '/app/onboarding/compatibility',
                variant: 'primary',
              }),
            ])
          : UnavailableAction({
              label: 'Start the setup',
              reason: SETUP_UNAVAILABLE_VIEWER_REASON,
              whenBack: SETUP_UNAVAILABLE_VIEWER_WHEN,
            })
      }
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
  // Floored, never rounded: 499 of 500 is 99%, not 100%. This figure and the meter on
  // /app/usage are the same proportion, so they must round the same way or the summary
  // here contradicts the detail there.
  const usedPercent = percentFloor(options.usage.runsUsed, options.usage.runsIncluded);
  const total = runTotal(workflow.counts);

  return html`<div class="wrap section stack-lg">
    <div class="section-head">
      ${pageHead({ eyebrow: 'Workspace', title: workflow.name })}
      <ul class="meta-bar" aria-label="About this workflow">
        <li>Runs <b>${String(total)}</b></li>
        <li>Completion window <b>${formatDuration(workflow.deadlineSeconds)}</b></li>
        <li>Coverage mode <b>${workflow.coverageMode}</b></li>
      </ul>
    </div>

    ${
      /*
       * The not-yet-settled state, and it is a real page state rather than a spinner.
       *
       * `awaiting_first_result` is A03's own name for "runs have arrived and none has
       * reached a terminal status" — every one is still inside its completion window. Left
       * unsaid, that renders as a table of clock badges and a rate card with no number,
       * which invites a customer to conclude the product is stuck. It is not: this service
       * checks evidence on a schedule, so waiting is the design working.
       *
       * It removes itself the moment anything is decided, because then there is a figure to
       * read and a panel saying "still looking" beside it would say two things at once.
       */
      health.state === 'awaiting_first_result'
        ? LoadingState({
            title: 'Still checking',
            body:
              `${String(health.total_runs)} ${health.total_runs === 1 ? 'run is' : 'runs are'} inside the ` +
              `agreed completion window, so none of them has an answer yet. We check evidence on a schedule ` +
              `rather than instantly, and a result can take up to an hour to settle. Nothing here has failed, ` +
              `and nothing here has passed.`,
          })
        : null
    }

    ${runCountCards(workflow.counts)}

    <section class="stack-sm" aria-labelledby="period-heading">
      <div class="section-head">
        <div class="section-head__text"><h2 id="period-heading">This period</h2></div>
        <a href="/app/usage">Usage detail</a>
      </div>
      <dl class="metrics" aria-label="This period">
        <div>
          <dt>Runs used</dt>
          <dd>${String(options.usage.runsUsed)} of ${String(options.usage.runsIncluded)} (${String(usedPercent)}%)</dd>
        </div>
        <div>
          <dt>Period ends</dt>
          <dd>${formatInstant(options.usage.periodEnd)}</dd>
        </div>
        <div>
          <dt>Correlation property</dt>
          <!-- An empty value is a blank state in miniature: a label with nothing after it reads
               as a figure that failed to load rather than a setting that has not been made.
               The port returns '' when the stored rules carry no correlation property — a
               workflow that has not reached the mapping step, or whose rules would not parse. -->
          <dd>
            ${
              workflow.mapping.correlationProperty === ''
                ? html`<span class="small muted">Not set: nothing can be matched back to an enquiry yet</span>`
                : html`<span class="mono">${workflow.mapping.correlationProperty}</span>`
            }
          </dd>
        </div>
      </dl>
    </section>

    <div class="health">
      ${Card({ title: 'Verification rate', headingLevel: 2, body: HealthReadout(health) })}
      ${Card({ title: 'Are enquiries still arriving?', headingLevel: 2, body: InactivityNotice(inactivity) })}
    </div>

    <section class="stack-sm" aria-labelledby="recent-runs-heading">
      <div class="section-head">
        <div class="section-head__text"><h2 id="recent-runs-heading">Recent runs</h2></div>
        <a href="/app/runs">All runs</a>
      </div>
      <div class="results">
        ${Table({
          caption: 'The most recent runs in this workspace',
          captionHidden: true,
          stack: true,
          /*
           * This is the first thing a new customer sees, and at that moment the list is
           * empty by definition. Without this branch the card drew four column headers over
           * an empty body — a panel that reads like a table which failed to load rather
           * than a workspace that has not started. The wording is deliberately the same
           * argument /app/runs makes: no runs is not a pass.
           */
          empty: EmptyState({
            title: 'No runs received yet',
            body:
              'Nothing has reached us for this workflow. That is not a pass: an empty workspace is not a ' +
              'verified one. If you expected enquiries by now, your automation may not be sending us events.',
            actions: [
              Button({
                label: 'Check your setup',
                href: '/app/onboarding/compatibility',
                variant: 'quiet',
              }),
            ],
          }),
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
        })}
        <div class="results__bar">
          ${runTally(workflow.counts)}
          <p class="micro mono">${String(options.recentRuns.length)} of ${String(total)} runs shown</p>
        </div>
      </div>
    </section>

    <div class="grid grid-2">
      ${Card({ title: 'Coverage', headingLevel: 2, body: CoverageNotice(coverage) })}
      ${Card({
        title: 'Connection health',
        headingLevel: 2,
        aside: html`<a href="/app/connections">Manage connections</a>`,
        body: html`<div>${options.connections.map((connection) => connectionRow(connection))}</div>`,
      })}
    </div>

    ${StandingLimitations()}
  </div>`;
}
