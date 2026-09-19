/**
 * The test centre and safe cleanup.
 *
 * Both pages share one discipline: **the button says what will actually happen, and the
 * page shows the dependency when nothing will.** A dispatch with no executor renders as
 * "waiting for a runner" with the reason spelled out; a cleanup renders the exact resource
 * ids before anything is removed, and refuses if that list has moved since you read it.
 *
 * Every suite is chosen from a list of radio buttons. There is no text input on this page
 * that reaches the runner — nothing here can carry a path, a command or a repository.
 */
import { Button, Callout, Card, Checkbox, KeyValues, Table, html, type Html } from '@verify/ui';
import {
  JOB_STATE_TEXT,
  QUALITY_ARTIFACTS,
  QUALITY_SUITES,
  stateIsVerdict,
  type QualityRun,
} from '../../owner/quality.js';
import { CLEANUP_CATEGORIES, OUT_OF_SCOPE, type CleanupInventory, type CleanupReport } from '../../owner/cleanup.js';
import { ActionForm, Instant, PageHead, UnknownAware } from './chrome.js';

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export function QualityPage(options: {
  readonly runs: readonly QualityRun[];
  readonly csrfToken: string | null;
  readonly artifactsUnavailableReason: string | null;
  readonly formMessage: string | null;
  readonly formDependency: string | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Tests',
      title: 'Test centre',
      lede: 'Run a suite, see what it proved, and download the evidence. Nothing here reports a result it did not get.',
    })}

    ${options.formDependency === null
      ? null
      : Callout({
          tone: 'warn',
          title: 'Saved, but not run',
          body: html`<p data-dependency="true">${options.formDependency}</p>`,
        })}
    ${options.formMessage === null
      ? null
      : Callout({ tone: 'note', title: 'Done', body: html`<p>${options.formMessage}</p>` })}

    ${Card({
      title: 'Run a suite',
      headingLevel: 2,
      body: ActionForm({
        action: '/owner/quality/run',
        csrfToken: options.csrfToken,
        body: html`<fieldset class="fieldset">
            <legend>Which suite</legend>
            <p class="fieldset__hint">
              These are the only suites that exist. You choose one of them; nothing you type is ever run.
            </p>
            ${QUALITY_SUITES.map(
              (suite) => html`<div class="check">
                <input type="radio" id="suite-${suite.id}" name="suite_id" value="${suite.id}" required />
                <label for="suite-${suite.id}">
                  <strong>${suite.label}</strong>
                  <span class="micro muted"> — about ${suite.typicalMinutes} minutes</span><br />
                  <span class="small">Proves: ${suite.proves}</span><br />
                  <span class="small muted">Does not prove: ${suite.doesNotProve}</span>
                </label>
              </div>`,
            )}
          </fieldset>
          ${Button({ label: 'Run this suite', variant: 'primary', type: 'submit' })}`,
      }),
    })}

    ${Card({
      title: 'Runs',
      headingLevel: 2,
      body: Table({
        caption: 'Test runs, their state and what each one proved',
        columns: [
          {
            key: 'suite',
            header: 'Suite',
            rowHeader: true,
            cell: (run) => html`<span class="mono">${run.suiteId}</span>`,
          },
          {
            key: 'state',
            header: 'State',
            cell: (run) => html`<span
                class="badge ${run.state === 'passed'
                  ? 'badge--verified'
                  : run.state === 'failed'
                    ? 'badge--failed'
                    : 'badge--unverified'}"
                data-job-state="${run.state}"
                >${JOB_STATE_TEXT[run.state].label}</span
              ><br /><span class="micro muted">${JOB_STATE_TEXT[run.state].meaning}</span>`,
          },
          {
            key: 'commit',
            header: 'Commit',
            cell: (run) =>
              run.commitSha === null
                ? html`<span class="muted" data-unknown="true">unknown</span>`
                : html`<span class="mono micro">${run.commitSha.slice(0, 12)}</span>`,
          },
          { key: 'env', header: 'Environment', cell: (run) => html`<span class="mono micro">${run.environment}</span>` },
          { key: 'executor', header: 'Executor', cell: (run) => html`<span class="mono micro">${run.executor}</span>` },
          { key: 'started', header: 'Started', cell: (run) => Instant(run.startedAt) },
          { key: 'ended', header: 'Ended', cell: (run) => Instant(run.endedAt) },
          {
            key: 'counts',
            header: 'Cases',
            numeric: true,
            cell: (run) =>
              stateIsVerdict(run.state)
                ? html`<span class="mono"
                    >${run.passed ?? 0}/${run.totalCases ?? 0} passed, ${run.failed ?? 0} failed</span
                  >`
                : html`<span class="muted" data-unknown="true">no result</span>`,
          },
          {
            key: 'limits',
            header: 'Limitations',
            cell: (run) => html`<span class="small">${run.limitations}</span>`,
          },
          {
            key: 'blocked',
            header: 'Waiting on',
            cell: (run) =>
              run.blockedReason === null
                ? html`<span class="muted">—</span>`
                : html`<span class="small" data-dependency="true">${run.blockedReason}</span>`,
          },
        ],
        rows: options.runs,
        empty: html`<p class="muted">No suite has been run from here yet.</p>`,
      }),
    })}

    ${Card({
      title: 'Evidence pack',
      headingLevel: 2,
      body:
        options.artifactsUnavailableReason === null
          ? html`<div class="stack-sm">
              <p class="small">
                These are the files the report script produces from a real run. They are behind your session —
                nothing here is public.
              </p>
              <ul class="stack-sm">
                ${QUALITY_ARTIFACTS.map(
                  (artifact) => html`<li>
                    <a href="/owner/quality/report/${artifact.id}"><strong>${artifact.label}</strong></a>
                    <span class="mono micro">(${artifact.id})</span><br />
                    <span class="small muted">${artifact.description}</span>
                  </li>`,
                )}
              </ul>
            </div>`
          : Callout({
              tone: 'warn',
              title: 'There is nothing to download',
              body: html`<p data-dependency="true">${options.artifactsUnavailableReason}</p>`,
            }),
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function CleanupPage(options: {
  readonly inventory: CleanupInventory | null;
  readonly lastReport: CleanupReport | null;
  readonly csrfToken: string | null;
  readonly errorMessage: string | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Cleanup',
      title: 'Safe cleanup',
      lede: 'List what would be removed, read it, then remove exactly that. Nothing is deleted that has not been listed first.',
    })}

    ${options.errorMessage === null
      ? null
      : Callout({
          tone: 'warn',
          title: 'Nothing was deleted',
          body: html`<p data-cleanup-error="true">${options.errorMessage}</p>`,
        })}

    ${Callout({
      tone: 'limit',
      title: 'What this will never touch',
      body: html`<ul class="stack-sm">
        ${OUT_OF_SCOPE.map((entry) => html`<li><strong>${entry.what}.</strong> ${entry.instead}</li>`)}
      </ul>`,
    })}

    ${Card({
      title: 'Preview',
      headingLevel: 2,
      body: ActionForm({
        action: '/owner/cleanup/preview',
        csrfToken: options.csrfToken,
        body: html`<fieldset class="fieldset">
            <legend>Categories</legend>
            <p class="fieldset__hint">
              These are the only categories that exist. There is no pattern to type and no wildcard to get
              wrong.
            </p>
            ${CLEANUP_CATEGORIES.map((category) =>
              Checkbox({
                name: 'categories',
                value: category.id,
                label: `${category.label} — ${category.removes} Safe because ${category.safeBecause}`,
              }),
            )}
          </fieldset>
          ${Button({ label: 'Show me what would go', variant: 'primary', type: 'submit' })}`,
      }),
    })}

    ${options.inventory === null ? null : InventoryCard({ inventory: options.inventory, csrfToken: options.csrfToken })}
    ${options.lastReport === null ? null : ReportCard({ report: options.lastReport })}
  </div>`;
}

export function InventoryCard(options: {
  readonly inventory: CleanupInventory;
  readonly csrfToken: string | null;
}): Html {
  const inv = options.inventory;
  return Card({
    title: `Inventory — ${inv.items.length} resource${inv.items.length === 1 ? '' : 's'}`,
    headingLevel: 2,
    aside: html`<span class="mono micro" data-inventory-hash="${inv.hash}">${inv.hash.slice(0, 16)}…</span>`,
    body: html`<div class="stack">
      ${KeyValues([
        ['Taken', Instant(inv.takenAt)],
        ['Environment', html`<span class="mono">${inv.environment}</span>`],
        ['Categories', html`<span class="mono micro">${inv.categories.join(', ')}</span>`],
        [
          'Estimated space reclaimed',
          inv.totalEstimatedBytes === null
            ? html`<span class="muted" data-unknown="true">unknown</span>`
            : html`<span class="mono">${(inv.totalEstimatedBytes / 1024).toFixed(1)} KB</span>`,
        ],
      ])}

      ${Table({
        caption: 'Exactly what would be removed',
        columns: [
          {
            key: 'id',
            header: 'Resource',
            rowHeader: true,
            cell: (item) => html`<span class="mono" data-resource-id="${item.resourceId}">${item.resourceId}</span>`,
          },
          { key: 'kind', header: 'Kind', cell: (item) => item.kind },
          { key: 'category', header: 'Category', cell: (item) => html`<span class="mono micro">${item.category}</span>` },
          { key: 'env', header: 'Environment', cell: (item) => html`<span class="mono micro">${item.environment}</span>` },
          { key: 'owner', header: 'Owned by', cell: (item) => html`<span class="mono micro">${item.ownershipTag}</span>` },
          {
            key: 'size',
            header: 'Size',
            numeric: true,
            cell: (item) => UnknownAware(item.estimatedBytes === null ? null : `${item.estimatedBytes} B`),
          },
          {
            key: 'retention',
            header: 'Retention',
            cell: (item) =>
              item.retentionConstraint === null
                ? html`<span class="muted">none applies</span>`
                : html`<span>${item.retentionConstraint}</span>`,
          },
          {
            key: 'quarantine',
            header: 'Can quarantine',
            cell: (item) => (item.quarantineAvailable ? 'yes' : 'no'),
          },
        ],
        rows: inv.items,
        empty: html`<p class="muted">Nothing in these categories.</p>`,
      })}

      ${inv.excluded.length === 0
        ? null
        : Callout({
            tone: 'note',
            title: `${inv.excluded.length} thing${inv.excluded.length === 1 ? '' : 's'} found and deliberately left out`,
            body: html`<ul class="stack-sm" data-excluded="true">
              ${inv.excluded.map(
                (entry) => html`<li><span class="mono micro">${entry.resourceId}</span> — ${entry.why}</li>`,
              )}
            </ul>`,
          })}

      ${inv.items.length === 0
        ? null
        : ActionForm({
            action: '/owner/cleanup/run',
            csrfToken: options.csrfToken,
            confirm: 'delete',
            body: html`<input type="hidden" name="inventory_hash" value="${inv.hash}" />
              <p class="measure">
                This removes the ${inv.items.length} resource${inv.items.length === 1 ? '' : 's'} listed above
                and nothing else. If anything about that list has changed since it was taken, the run stops
                before deleting anything and asks you to look again.
              </p>
              ${Checkbox({
                name: 'quarantine',
                label: 'Quarantine instead of deleting, where the resource supports it',
                checked: true,
              })}
              ${Button({ label: 'Remove these', variant: 'danger', type: 'submit' })}`,
          })}
    </div>`,
  });
}

export function ReportCard(options: { readonly report: CleanupReport }): Html {
  const report = options.report;
  return Card({
    title: 'Last cleanup',
    headingLevel: 2,
    aside: html`<span
      class="badge ${report.state === 'completed' ? 'badge--verified' : 'badge--unverified'}"
      data-cleanup-state="${report.state}"
      >${report.state}</span
    >`,
    body: html`<div class="stack">
      <p class="measure" data-cleanup-summary="true">${report.summary}</p>
      ${KeyValues([
        ['Run', html`<span class="mono">${report.runId}</span>`],
        ['Started', Instant(report.startedAt)],
        ['Ended', Instant(report.endedAt)],
        ['Removed', html`<span class="mono">${report.deleted}</span>`],
        ['Quarantined', html`<span class="mono">${report.quarantined}</span>`],
        ['Left alone', html`<span class="mono">${report.skipped}</span>`],
        ['Could not remove', html`<span class="mono">${report.failedCount}</span>`],
        [
          'Space reclaimed',
          report.reclaimedBytes === null
            ? html`<span class="muted" data-unknown="true">unknown</span>`
            : html`<span class="mono">${(report.reclaimedBytes / 1024).toFixed(1)} KB</span>`,
        ],
      ])}

      ${report.checkpoint === null
        ? null
        : Callout({
            tone: 'warn',
            title: 'This run did not finish',
            body: html`<p data-checkpoint="true">
                ${report.checkpoint.handled.length} handled, ${report.checkpoint.remaining.length} still to do.
                The run is resumable: nothing already removed will be removed again, and nothing not yet looked
                at has been touched.
              </p>
              <p class="small mono micro">Remaining: ${report.checkpoint.remaining.join(', ')}</p>`,
          })}

      ${Table({
        caption: 'What happened to each resource',
        columns: [
          { key: 'id', header: 'Resource', rowHeader: true, cell: (r) => html`<span class="mono">${r.resourceId}</span>` },
          { key: 'outcome', header: 'Outcome', cell: (r) => r.outcome.replace(/_/g, ' ') },
          {
            key: 'detail',
            header: 'Detail',
            cell: (r) => (r.detail === null ? html`<span class="muted">—</span>` : html`${r.detail}`),
          },
        ],
        rows: report.resources,
        empty: html`<p class="muted">Nothing was touched.</p>`,
      })}
    </div>`,
  });
}
