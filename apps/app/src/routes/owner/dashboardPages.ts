/**
 * Overview, customers, verification and connections.
 *
 * Three rules are enforced by the rendering here rather than by the data behind it:
 *
 *  1. A figure that is `null` renders as **unknown**, in a muted style, with a
 *     `data-unknown` attribute a test can assert on. Nothing on these pages can print `0`
 *     for a number nobody measured.
 *  2. Money is labelled for what it is. "Cash received" is not revenue-as-profit, and the
 *     net line carries `NET_RECEIPTS_CAVEAT` from `owner/finance.ts` every time it appears.
 *  3. A verification failure is explained through `@verify/domain`'s `explain.ts`. There is
 *     no path in this file that prints a raw reason code — the view model carries sentences,
 *     not codes, and the port is what calls `explainAssertion`.
 */
import { Button, Callout, Card, KeyValues, StatusBadge, Table, html, type Html } from '@verify/ui';
import { summariseFinance, freshness, NET_RECEIPTS_CAVEAT } from '../../owner/finance.js';
import { ActionForm, Instant, PageHead, UnknownAware } from './chrome.js';
import type {
  CustomerRow,
  LaunchMetric,
  ExceptionRow,
  OverviewView,
  OwnerConnectionView,
  OwnerRunView,
  ServiceHealthView,
} from '../../owner/port.js';

function healthRow(item: ServiceHealthView): Html {
  const tone =
    item.state === 'ok' ? 'note' : item.state === 'unknown' ? 'limit' : item.state === 'degraded' ? 'warn' : 'warn';
  return Callout({
    tone,
    title: `${item.component}: ${item.state === 'unknown' ? 'not known' : item.state}`,
    body: html`<p>${item.detail}</p>
      <p class="micro">Observed ${Instant(item.observedAt)}</p>`,
  });
}

/**
 * One launch figure. Never renders a zero for something unmeasured: a `null` value shows
 * `unknown`, in the muted style, with `data-unknown` for a test to assert on.
 */
function LaunchStat(options: {
  readonly label: string;
  readonly metric: LaunchMetric;
  readonly note: string;
  readonly now: Date;
}): Html {
  const observed = freshness(options.metric.observedAt, options.now);
  return html`<div class="stack-sm" data-launch-metric="${options.label}">
    <p class="eyebrow">${options.label}</p>
    <p class="score ${options.metric.value === null ? 'score--none' : ''}">
      ${options.metric.value === null
        ? html`<span data-unknown="true">unknown</span>`
        : String(options.metric.value)}
    </p>
    <p class="micro muted">${observed.label}</p>
    <p class="small">${options.note}</p>
  </div>`;
}

export function OverviewPage(options: { readonly view: OverviewView; readonly now: Date }): Html {
  const finance = summariseFinance(options.view.finance);
  const refreshed = freshness(options.view.finance.lastRefreshAt, options.now);
  const launch = options.view.launch;

  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Overview',
      title: 'How the business is doing',
      lede:
        'Everything on this page is either measured or marked unknown. Where it is an estimate, it says so beside the figure.',
    })}

    ${Callout({
      tone: finance.anyUnknown ? 'warn' : 'note',
      title: finance.anyUnknown ? 'Some figures are not known yet' : 'Figures as at the last refresh',
      body: html`<p>
          ${refreshed.label}. Anything showing <span class="mono">unknown</span> has not been measured on this
          deployment — it is not zero, and you should not read it as zero.
        </p>
        <p class="small">${NET_RECEIPTS_CAVEAT}</p>`,
    })}

    ${Card({
      title: 'Money',
      headingLevel: 2,
      aside: html`<span class="micro muted">${refreshed.label}</span>`,
      body: Table({
        caption: 'Money received, refunded, spent and committed',
        columns: [
          { key: 'label', header: 'Figure', rowHeader: true, cell: (line) => line.label },
          {
            key: 'value',
            header: 'Amount',
            numeric: true,
            cell: (line) =>
              line.minor === null
                ? html`<span class="muted" data-unknown="true">unknown</span>`
                : html`<span class="mono">${line.display}</span>`,
          },
          {
            key: 'basis',
            header: 'Basis',
            cell: (line) =>
              html`${line.estimated
                ? html`<span class="badge badge--unverified" data-estimate="true">estimate</span> `
                : html`<span class="micro">measured</span> `}${line.caveat === null
                ? null
                : html`<span class="micro muted">${line.caveat}</span>`}`,
          },
        ],
        rows: finance.lines,
      }),
    })}

    <div class="grid grid-2">
      ${Card({
        title: 'Customers',
        headingLevel: 2,
        body: KeyValues([
          ['Active', UnknownAware(options.view.customersActive)],
          ['Total ever', UnknownAware(options.view.customersTotal)],
          ['Runs in the last 24 hours', UnknownAware(options.view.runsLast24h)],
          ['Open support cases', UnknownAware(options.view.openSupportCases)],
        ]),
      })}
    </div>

    ${Card({
      title: 'Since launch',
      headingLevel: 2,
      body: html`<div class="stack">
        <p class="measure small">
          Four numbers, kept apart on purpose. <strong>A visit is not interest, and interest is not a
          customer.</strong> Adding them together, or quoting the largest of them on its own, would tell you
          the business is doing better than it is.
        </p>
        <div class="grid grid-2">
          ${LaunchStat({
            label: 'People who visited',
            metric: launch.totalVisits,
            note: 'Our own traffic and suspected bots are excluded, so this is smaller than a raw hit count and is the one worth looking at.',
            now: options.now,
          })}
          ${LaunchStat({
            label: 'Of those, arrived from an advert',
            metric: launch.adAttributedVisits,
            note: 'A subset of the figure above, not a separate total. It is what the advertising actually bought.',
            now: options.now,
          })}
          ${LaunchStat({
            label: 'Created a workspace and connected something',
            metric: launch.qualifiedSignups,
            note: 'Interest, not revenue. Somebody got far enough to try it.',
            now: options.now,
          })}
          ${LaunchStat({
            label: 'Paying customers',
            metric: launch.payingCustomers,
            note: 'The only one of the four that is income.',
            now: options.now,
          })}
        </div>
      </div>`,
    })}

    ${Card({
      title: 'Waiting for you',
      headingLevel: 2,
      body: html`<p class="score ${options.view.pendingApprovals === 0 ? 'score--none' : ''}">
          ${options.view.pendingApprovals === 0 ? 'Nothing' : String(options.view.pendingApprovals)}
        </p>
        <p class="small">
          Approvals that are still standing and could be used.
          <a href="/owner/approvals">Open approvals</a>.
        </p>`,
    })}

    ${Card({
      title: 'Service health',
      headingLevel: 2,
      body: html`<div class="stack-sm">${options.view.health.map(healthRow)}</div>`,
    })}

    <p class="micro muted">Page assembled ${Instant(options.view.assembledAt)}.</p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export function CustomersPage(options: {
  readonly customers: readonly CustomerRow[];
  readonly exceptions: readonly ExceptionRow[];
  readonly csrfToken: string | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Customers',
      title: 'Customers and orders',
      lede: 'Who is signed up, whether they can actually use the product, and what needs a decision.',
    })}

    ${Card({
      title: 'Exception queue',
      headingLevel: 2,
      body:
        options.exceptions.length === 0
          ? html`<p class="muted">Nothing is waiting. That is a real state, not an empty page.</p>`
          : Table({
              caption: 'Things that need a decision',
              columns: [
                { key: 'kind', header: 'Kind', rowHeader: true, cell: (row) => row.kind.replace(/_/g, ' ') },
                { key: 'summary', header: 'What happened', cell: (row) => row.summary },
                { key: 'raised', header: 'Raised', cell: (row) => Instant(row.raisedAt) },
                {
                  key: 'action',
                  header: 'Suggested',
                  cell: (row) =>
                    row.suggestedAction === null
                      ? html`<span class="muted">nothing useful to suggest</span>`
                      : html`${row.suggestedAction}`,
                },
              ],
              rows: options.exceptions,
            }),
    })}

    ${Card({
      title: 'Customers',
      headingLevel: 2,
      body: Table({
        caption: 'Every workspace, its eligibility and its subscription state',
        columns: [
          {
            key: 'name',
            header: 'Workspace',
            rowHeader: true,
            cell: (row) =>
              html`${row.name}${row.isSynthetic
                ? html` <span class="badge badge--unverified">synthetic</span>`
                : null}<br /><span class="micro mono">${row.contactMask}</span>`,
          },
          {
            key: 'eligible',
            header: 'Eligible',
            cell: (row) =>
              row.eligible
                ? html`<span class="micro">yes</span>`
                : html`<span class="micro">no — ${row.ineligibleReason ?? 'reason not recorded'}</span>`,
          },
          {
            key: 'subscription',
            header: 'Subscription',
            cell: (row) => UnknownAware(row.subscriptionStatus),
          },
          {
            key: 'connections',
            header: 'Connections',
            numeric: true,
            cell: (row) => html`<span class="mono">${row.connectionsReady}/${row.connectionsTotal}</span>`,
          },
          { key: 'runs', header: 'Runs', numeric: true, cell: (row) => UnknownAware(row.runsThisPeriod) },
          {
            key: 'actions',
            header: 'Actions',
            cell: (row) =>
              ActionForm({
                action: `/owner/customers/${encodeURIComponent(row.workspaceId)}/cancel`,
                csrfToken: options.csrfToken,
                body: Button({ label: 'Cancel subscription', variant: 'quiet', type: 'submit' }),
              }),
          },
        ],
        rows: options.customers,
        empty: html`<p class="muted">No workspaces yet.</p>`,
      }),
    })}

    ${Callout({
      tone: 'note',
      title: 'Refunds',
      body: html`<p>
        A refund needs an approval bound to the exact amount and reason first. Grant one on the
        <a href="/owner/approvals">approvals page</a>, then come back — an approval for £12.00 will not
        authorise £12.01.
      </p>`,
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export function VerificationListPage(options: { readonly runs: readonly OwnerRunView[] }): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Verification',
      title: 'Recent runs',
      lede: 'What the engine decided, what evidence it had, and which rules decided it.',
    })}
    ${Table({
      caption: 'Recent verification runs across every workspace',
      columns: [
        {
          key: 'run',
          header: 'Run',
          rowHeader: true,
          cell: (run) =>
            html`<a href="/owner/verification/${encodeURIComponent(run.runId)}" class="mono">${run.runId}</a>`,
        },
        { key: 'status', header: 'Result', cell: (run) => StatusBadge({ status: run.status }) },
        { key: 'workflow', header: 'Workflow', cell: (run) => run.workflowName },
        { key: 'rules', header: 'Rules', cell: (run) => html`<span class="mono micro">${run.rulesRef}</span>` },
        { key: 'decided', header: 'Decided', cell: (run) => Instant(run.decidedAt) },
      ],
      rows: options.runs,
      empty: html`<p class="muted">No runs yet.</p>`,
    })}
  </div>`;
}

export function VerificationDetailPage(options: {
  readonly run: OwnerRunView;
  readonly csrfToken: string | null;
}): Html {
  const run = options.run;
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Verification',
      title: run.workflowName,
      aside: StatusBadge({ status: run.status, large: true }),
    })}

    <p class="lede measure">${run.statusSentence}</p>

    ${Card({
      title: 'What decided this',
      headingLevel: 2,
      body: KeyValues([
        ['Run', html`<span class="mono">${run.runId}</span>`],
        ['Workspace', html`<span class="mono">${run.workspaceId}</span>`],
        ['Rule version', html`<span class="mono">${run.rulesRef}</span>`],
        ['Rules schema', html`<span class="mono">v${run.rulesSchemaVersion}</span>`],
        ['Event occurred', Instant(run.occurredAt)],
        ['Deadline', Instant(run.deadlineAt)],
        ['Decided', Instant(run.decidedAt)],
      ]),
    })}

    ${Card({
      title: 'Checks',
      headingLevel: 2,
      body: html`<div class="stack">
        ${run.assertions.map(
          (assertion) => html`<div class="stack-sm">
            <p><strong>${assertion.headline}</strong></p>
            <p class="measure">${assertion.sentence}</p>
            ${assertion.detail === null ? null : html`<p class="small mono">${assertion.detail}</p>`}
            ${assertion.nextStep === null
              ? null
              : html`<p class="small">What to do: ${assertion.nextStep}</p>`}
          </div>`,
        )}
      </div>`,
    })}

    ${Card({
      title: 'Evidence',
      headingLevel: 2,
      body: Table({
        caption: 'Every piece of evidence retrieved for this run',
        columns: [
          { key: 'component', header: 'Component', rowHeader: true, cell: (e) => e.component },
          { key: 'provider', header: 'Provider', cell: (e) => e.provider },
          { key: 'origin', header: 'How we got it', cell: (e) => e.origin.replace(/_/g, ' ') },
          { key: 'observed', header: 'Observed', cell: (e) => Instant(e.observedAt) },
          {
            key: 'digest',
            header: 'Digest',
            cell: (e) => html`<span class="mono micro">${e.contentDigest.slice(0, 23)}…</span>`,
          },
          { key: 'summary', header: 'Summary', cell: (e) => e.redactedSummary },
        ],
        rows: run.evidence,
        empty: html`<p class="muted">No evidence was retrieved for this run.</p>`,
      }),
    })}

    ${run.outages.length === 0
      ? null
      : Callout({
          tone: 'warn',
          title: 'Provider problems overlapping this run',
          body: html`<ul class="stack-sm">
            ${run.outages.map(
              (outage) =>
                html`<li>
                  <strong>${outage.provider}</strong> from ${Instant(outage.from)} to
                  ${outage.to === null ? html`<span class="muted">still going</span>` : Instant(outage.to)} —
                  ${outage.detail}
                </li>`,
            )}
          </ul>`,
        })}

    ${Card({
      title: 'Look again',
      headingLevel: 2,
      body: run.retryAvailable
        ? ActionForm({
            action: `/owner/verification/${encodeURIComponent(run.runId)}/retry`,
            csrfToken: options.csrfToken,
            body: html`<p class="small">
                Queues another observation. It costs a provider call, and it cannot turn an unverified run into
                a verified one unless the evidence is genuinely there.
              </p>
              ${Button({ label: 'Check this run again', type: 'submit' })}`,
          })
        : Callout({
            tone: 'limit',
            title: 'Cannot retry',
            body: html`<p>${run.retryBlockedReason ?? 'This run cannot be retried.'}</p>`,
          }),
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export function ConnectionsPage(options: {
  readonly connections: readonly OwnerConnectionView[];
  readonly csrfToken: string | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Connections',
      title: 'Provider connections',
      lede: 'Setup, health, rotation and revocation, across every workspace.',
    })}

    ${Callout({
      tone: 'note',
      title: 'No stored secret appears on this page',
      body: html`<p>
        The hints below are generated fresh when the page renders, from the account identifier the provider
        returns — not from anything we hold. A stored credential is never read back out, and a mask of stored
        ciphertext would still be a read-back, so we do not do that either.
      </p>`,
    })}

    ${Table({
      caption: 'Every connection, its health and what to do about it',
      columns: [
        {
          key: 'provider',
          header: 'Provider',
          rowHeader: true,
          cell: (conn) =>
            html`${conn.provider}<br /><span class="micro mono">${conn.workspaceId}</span>`,
        },
        { key: 'status', header: 'Status', cell: (conn) => html`<span class="mono">${conn.status}</span>` },
        {
          key: 'account',
          header: 'Account',
          cell: (conn) =>
            conn.maskHint === null
              ? html`<span class="muted">nothing connected</span>`
              : html`<span class="mono micro" data-mask="fresh">${conn.maskHint}</span>`,
        },
        { key: 'checked', header: 'Last checked', cell: (conn) => Instant(conn.lastCheckAt) },
        {
          key: 'error',
          header: 'Last error',
          cell: (conn) =>
            conn.lastErrorCode === null
              ? html`<span class="muted">none</span>`
              : html`<span class="mono micro">${conn.lastErrorCode}</span>`,
        },
        {
          key: 'actions',
          header: 'Actions',
          cell: (conn) => html`<div class="btn-row">
            ${ActionForm({
              action: `/owner/connections/${encodeURIComponent(conn.id)}/rotate`,
              csrfToken: options.csrfToken,
              body: Button({ label: 'Rotate', variant: 'quiet', type: 'submit' }),
            })}
            ${ActionForm({
              action: `/owner/connections/${encodeURIComponent(conn.id)}/revoke`,
              csrfToken: options.csrfToken,
              confirm: 'revoke',
              body: html`<p class="small">
                  Revoking stops us reading this provider. Runs that needed it will report
                  <strong>unverified</strong>, not failed — we will not claim a failure we cannot see.
                </p>
                ${Button({ label: 'Revoke', variant: 'danger', type: 'submit' })}`,
            })}
          </div>`,
        },
      ],
      rows: options.connections,
      empty: html`<p class="muted">Nothing is connected yet.</p>`,
    })}
  </div>`;
}
