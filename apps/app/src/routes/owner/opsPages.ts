/**
 * Operations, controls and settings.
 *
 * The operations screen renders A08's runner status through the port in `owner/runner.ts`.
 * When nothing is paired it says so in words and shows the queue length — it does not draw
 * a green tick over an absent dependency, and there is no code path here that can.
 *
 * The controls screen is the one place in the product where the owner can stop things
 * happening. It states, on the page and next to every switch, what each pause does not
 * stop — and it lists the paths that keep working regardless, because a customer's ability
 * to cancel is not the owner's to switch off.
 */
import { Button, Callout, Card, Checkbox, Field, KeyValues, Table, html, type Html } from '@verify/ui';
import { formatMoney, money } from '@verify/contracts';
import {
  CONTROL_DESCRIPTION,
  CONTROL_KEYS,
  PROTECTED_PATHS,
  type Controls,
} from '../../owner/controls.js';
import { describeAccessMode, AUTOMATION_DENIED, MFA_WINDOW_SECONDS } from '../../owner/access.js';
import {
  pendingBusinessFields,
  RETENTION_BOUNDS,
  TODO_OWNER_INPUT,
  type BudgetLimitSettings,
  type BusinessDetails,
  type NotificationSettings,
  type PricingSettings,
  type RetentionSettings,
} from '../../owner/settings.js';
import { heartbeatIsFresh } from '../../owner/runner.js';
import { NOTIFICATION_STUCK_AFTER_SECONDS, suggestedActionFor } from '../../owner/notifications.js';
import { describeAge } from '../../owner/finance.js';
import { ActionForm, Instant, PageHead, UnknownAware } from './chrome.js';
import type { AccessMode } from '@verify/contracts';
import type { OperationsView } from '../../owner/port.js';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function OperationsPage(options: {
  readonly view: OperationsView;
  readonly csrfToken: string | null;
  readonly now: Date;
}): Html {
  const runner = options.view.runner;
  const fresh = heartbeatIsFresh(runner.lastHeartbeatAt, options.now);

  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Operations',
      title: 'How the service is running',
      lede: 'Health, what was deployed, what is alerting, and whether the maintenance runner is actually there.',
    })}

    ${Card({
      title: 'Maintenance runner',
      headingLevel: 2,
      aside: html`<span
        class="badge ${runner.connected && fresh ? 'badge--verified' : 'badge--unverified'}"
        data-runner-state="${runner.connected && fresh ? 'connected' : 'offline'}"
        >${runner.connected && fresh ? 'connected' : 'not connected'}</span
      >`,
      body: html`<div class="stack-sm">
        ${runner.unavailableReason === null
          ? null
          : Callout({
              tone: 'warn',
              title: 'Nothing is listening',
              body: html`<p>${runner.unavailableReason}</p>
                <p class="small">
                  Jobs you queue are saved. They are not lost, and they are not done — they will run when a
                  runner is paired. Anything on this page showing a queue is waiting on that.
                </p>`,
            })}
        ${KeyValues([
          ['Device', UnknownAware(runner.deviceLabel)],
          [
            'Last heartbeat',
            html`${Instant(runner.lastHeartbeatAt)}
            ${runner.heartbeatAgeSeconds === null
              ? null
              : html` <span class="micro muted">(${runner.heartbeatAgeSeconds}s ago)</span>`}`,
          ],
          [
            'Current job',
            runner.currentJob === null
              ? html`<span class="muted">nothing running</span>`
              : html`<span class="mono">${runner.currentJob.kind}</span> since
                  ${Instant(runner.currentJob.startedAt)}`,
          ],
          ['Last successful job', Instant(runner.lastSuccessAt)],
          ['Jobs waiting', html`<span class="mono">${runner.queuedJobs}</span>`],
        ])}
      </div>`,
    })}

    ${Card({
      title: 'Run a maintenance job',
      headingLevel: 2,
      body: html`<div class="stack-sm">
        <p class="measure small">
          These are whole jobs the runner knows how to do, chosen from a fixed list. Nothing you type here
          reaches a machine — you pick a job, and the runner maps it to a recipe compiled into it.
        </p>
        <div class="btn-row">
          ${ActionForm({
            action: '/owner/operations/jobs/run_health_checks',
            csrfToken: options.csrfToken,
            body: Button({ label: 'Run health checks', type: 'submit' }),
          })}
          ${ActionForm({
            action: '/owner/operations/jobs/collect_redacted_diagnostics',
            csrfToken: options.csrfToken,
            body: Button({ label: 'Collect diagnostics', type: 'submit' }),
          })}
        </div>
        <p class="micro muted">
          With no runner connected the job is still written down and waits. It is a queue, not a pretence —
          the row below will say what it is waiting for.
        </p>
      </div>`,
    })}

    ${Card({
      title: 'Messages that never finished sending',
      headingLevel: 2,
      aside: html`<span
        class="badge ${options.view.notifications.unavailableReason !== null
          ? 'badge--unverified'
          : options.view.notifications.stuck.length > 0
            ? 'badge--failed'
            : 'badge--verified'}"
        data-notifications-state="${options.view.notifications.unavailableReason !== null
          ? 'unknown'
          : options.view.notifications.stuck.length > 0
            ? 'stuck'
            : 'clear'}"
        >${options.view.notifications.unavailableReason !== null
          ? 'not checked'
          : options.view.notifications.stuck.length > 0
            ? `${options.view.notifications.stuck.length} stuck`
            : 'none stuck'}</span
      >`,
      body: html`<div class="stack-sm">
        ${Callout({
          tone: 'note',
          title: 'You are the retry',
          body: html`<p>
            We send each message at most once. If something died halfway through a send, the row below is left
            behind and <strong>nothing will try again on its own</strong> — that is deliberate, because a second
            "your data has been deleted" email is worse than a missing one. It does mean that anything listed
            here only gets dealt with because you dealt with it. Resend by hand, after you have checked what
            actually happened. Anything older than
            ${Math.round(NOTIFICATION_STUCK_AFTER_SECONDS / 60)} minutes is here.
          </p>`,
        })}
        ${options.view.notifications.unavailableReason === null
          ? Table({
              caption: 'Notifications that claimed a row and never reported an outcome',
              columns: [
                {
                  key: 'template',
                  header: 'Message',
                  rowHeader: true,
                  cell: (row) => html`<span class="mono">${row.template}</span>`,
                },
                { key: 'channel', header: 'Channel', cell: (row) => row.channel },
                {
                  key: 'workspace',
                  header: 'Workspace',
                  cell: (row) =>
                    row.workspaceId === null
                      ? html`<span class="muted">platform</span>`
                      : html`<span class="mono micro">${row.workspaceId}</span>`,
                },
                { key: 'age', header: 'Stuck for', cell: (row) => describeAge(row.ageSeconds) },
                { key: 'attempts', header: 'Attempts', numeric: true, cell: (row) => String(row.attemptCount) },
                {
                  key: 'status',
                  header: 'Last thing the provider said',
                  cell: (row) =>
                    row.providerStatus === null
                      ? html`<span class="muted" data-unknown="true">nothing</span>`
                      : html`<span class="mono micro">${row.providerStatus}</span>`,
                },
                { key: 'action', header: 'What to do', cell: (row) => suggestedActionFor(row.template) },
              ],
              rows: options.view.notifications.stuck,
              empty: html`<p class="muted">
                Nothing is stuck. This was actually checked — it is not an empty list from a read that did not run.
              </p>`,
            })
          : Callout({
              tone: 'warn',
              title: 'Not checked',
              body: html`<p data-dependency="true">${options.view.notifications.unavailableReason}</p>`,
            })}
      </div>`,
    })}

    ${Card({
      title: 'Queued maintenance jobs',
      headingLevel: 2,
      body: Table({
        caption: 'Maintenance jobs and their state',
        columns: [
          { key: 'kind', header: 'Job', rowHeader: true, cell: (job) => html`<span class="mono">${job.kind}</span>` },
          { key: 'state', header: 'State', cell: (job) => html`<span class="mono">${job.state}</span>` },
          { key: 'created', header: 'Requested', cell: (job) => Instant(job.createdAt) },
          {
            key: 'blocked',
            header: 'Waiting on',
            cell: (job) =>
              job.blockedReason === null ? html`<span class="muted">—</span>` : html`${job.blockedReason}`,
          },
        ],
        rows: options.view.maintenanceJobs,
        empty: html`<p class="muted">No maintenance jobs.</p>`,
      }),
    })}

    ${Card({
      title: 'Assistant',
      headingLevel: 2,
      body: html`<div class="stack-sm">
        ${KeyValues([
          ['Mode', html`<span class="mono">${options.view.assistant.mode}</span>`],
          [
            'Spent this period',
            options.view.assistant.spentMinor === null
              ? html`<span class="muted" data-unknown="true">unknown</span>`
              : html`<span class="mono">${formatMoney(money(options.view.assistant.spentMinor, 'GBP'))}</span>`,
          ],
          ['Proposals waiting for you', UnknownAware(options.view.assistant.pendingProposals)],
          ['Last call', Instant(options.view.assistant.lastCallAt)],
        ])}
        ${options.view.assistant.unavailableReason === null
          ? null
          : html`<p class="small">${options.view.assistant.unavailableReason}</p>`}
      </div>`,
    })}

    ${Card({
      title: 'Alerts',
      headingLevel: 2,
      body: Table({
        caption: 'Open alerts',
        columns: [
          { key: 'severity', header: 'Severity', rowHeader: true, cell: (a) => a.severity },
          { key: 'summary', header: 'What happened', cell: (a) => a.summary },
          { key: 'raised', header: 'Raised', cell: (a) => Instant(a.raisedAt) },
          {
            key: 'ack',
            header: '',
            cell: (a) =>
              a.acknowledgedAt !== null
                ? html`<span class="micro muted">acknowledged ${Instant(a.acknowledgedAt)}</span>`
                : ActionForm({
                    action: `/owner/operations/alerts/${encodeURIComponent(a.id)}/acknowledge`,
                    csrfToken: options.csrfToken,
                    body: Button({ label: 'Acknowledge', variant: 'quiet', type: 'submit' }),
                  }),
          },
        ],
        rows: options.view.alerts,
        empty: html`<p class="muted">Nothing is alerting.</p>`,
      }),
    })}

    ${Card({
      title: 'Deployment history',
      headingLevel: 2,
      body: Table({
        caption: 'What was deployed, when, and whether it worked',
        columns: [
          { key: 'when', header: 'When', rowHeader: true, cell: (d) => Instant(d.deployedAt) },
          { key: 'env', header: 'Environment', cell: (d) => d.environment },
          {
            key: 'commit',
            header: 'Commit',
            cell: (d) =>
              d.commitSha === null
                ? html`<span class="muted" data-unknown="true">unknown</span>`
                : html`<span class="mono micro">${d.commitSha.slice(0, 12)}</span>`,
          },
          { key: 'by', header: 'By', cell: (d) => d.deployedBy },
          { key: 'result', header: 'Result', cell: (d) => d.result.replace(/_/g, ' ') },
        ],
        rows: options.view.deployments,
        empty: html`<p class="muted">No deployments recorded.</p>`,
      }),
    })}

    ${Card({
      title: 'Restore a previous version',
      headingLevel: 2,
      body: ActionForm({
        action: '/owner/operations/restore',
        csrfToken: options.csrfToken,
        confirm: 'restore',
        body: html`<p class="measure">
            Rolling back replaces the running code with an earlier deployment. Anything that has been written
            to the database since then stays written — a rollback undoes code, not data, and a schema change
            made since then is not reversed.
          </p>
          ${Field({
            name: 'deployment_id',
            label: 'Deployment to restore',
            required: true,
            mono: true,
            hint: 'Copy the id from the history above.',
          })}
          ${Field({
            name: 'approval_id',
            label: 'Approval id',
            required: true,
            mono: true,
            hint: 'A restore changes what every customer is served, so it needs an approval bound to this exact deployment. Grant one on the approvals page.',
          })}
          ${Button({ label: 'Restore this deployment', variant: 'danger', type: 'submit' })}`,
      }),
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function ControlsPage(options: {
  readonly controls: Controls;
  readonly csrfToken: string | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Controls',
      title: 'Stop switches',
      lede: 'Each one stops the thing it names and nothing else. Each one says what it does not stop.',
    })}

    ${Callout({
      tone: 'note',
      title: 'These never stop working',
      body: html`<p>
          Whatever you pause, a customer can still cancel their plan and still reach support. That is not a
          convention we are being careful about — the code refuses to suspend these paths, and a test proves
          it with every switch on at once.
        </p>
        <ul class="stack-sm" data-protected-paths="true">
          ${PROTECTED_PATHS.map(
            (p) => html`<li><span class="mono">${p.path}</span> — ${p.why}</li>`,
          )}
        </ul>`,
    })}

    <div class="stack">
      ${CONTROL_KEYS.map((key) => {
        const state = options.controls[key];
        const description = CONTROL_DESCRIPTION[key];
        return Card({
          title: description.label,
          headingLevel: 2,
          aside: html`<span
            class="badge ${state.paused ? 'badge--failed' : 'badge--verified'}"
            data-control="${key}"
            data-paused="${state.paused ? 'true' : 'false'}"
            >${state.paused ? 'paused' : 'running'}</span
          >`,
          body: html`<div class="stack-sm">
            <p class="measure"><strong>Pausing this stops:</strong> ${description.stops}</p>
            <p class="measure"><strong>It does not stop:</strong> ${description.doesNotStop}</p>
            ${state.paused
              ? html`<p class="small">
                  Paused since ${Instant(state.since)} by <span class="mono">${state.by ?? 'unknown'}</span>.
                  ${state.note === null ? null : html`Note: ${state.note}`}
                </p>`
              : null}
            ${ActionForm({
              action: `/owner/controls/${encodeURIComponent(key)}`,
              csrfToken: options.csrfToken,
              body: html`<input type="hidden" name="paused" value="${state.paused ? 'no' : 'yes'}" />
                ${Field({
                  name: `note_${key}`,
                  label: 'Why (optional, for the record)',
                  hint: 'Whoever reads the audit trail later, including you, will be glad of a sentence.',
                })}
                ${Button({
                  label: state.paused ? `Resume ${description.label.toLowerCase()}` : `Pause ${description.label.toLowerCase()}`,
                  variant: state.paused ? 'default' : 'danger',
                  type: 'submit',
                })}`,
            })}
          </div>`,
        });
      })}
    </div>

    ${Card({
      title: 'Revoke a connection',
      headingLevel: 2,
      body: html`<p class="measure">
        Revoking a single provider connection is on the
        <a href="/owner/connections">connections page</a>, next to the connection it affects, so you can see
        which workspace it belongs to before you do it.
      </p>`,
    })}
  </div>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SettingsPageOptions {
  readonly business: BusinessDetails;
  readonly pricing: PricingSettings;
  readonly notifications: NotificationSettings;
  readonly retention: RetentionSettings;
  readonly budgetLimits: BudgetLimitSettings;
  readonly accessMode: AccessMode;
  readonly csrfToken: string | null;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly savedMessage: string | null;
}

export function SettingsPage(options: SettingsPageOptions): Html {
  const pending = pendingBusinessFields(options.business);
  const mode = describeAccessMode(options.accessMode);
  const error = (name: string): string | null => options.fieldErrors[name] ?? null;

  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Settings',
      title: 'Settings',
      lede: 'Things you can change without anyone deploying anything.',
    })}

    ${options.savedMessage === null
      ? null
      : Callout({ tone: 'note', title: 'Saved', body: html`<p>${options.savedMessage}</p>` })}

    ${pending.length === 0
      ? null
      : Callout({
          tone: 'todo',
          title: 'Your business details are not filled in',
          body: html`<p>
              The public terms and privacy pages have to carry a real trading name and a real address. Nobody
              on the build team knows yours, and we will not invent one — the pages currently show
              <span class="mono">${TODO_OWNER_INPUT}</span> where these belong.
            </p>
            <p class="small">Still needed: ${pending.join(', ')}.</p>`,
        })}

    ${Card({
      title: 'Business details',
      headingLevel: 2,
      body: html`<form method="post" action="/owner/settings/business" class="stack">
        <input type="hidden" name="csrf_token" value="${options.csrfToken ?? ''}" />
        <p class="small">
          You trade as a <strong>UK sole trader</strong>. That is fixed here rather than offered as a choice:
          picking the wrong one would publish something untrue about who is liable.
        </p>
        ${Field({
          name: 'tradingName',
          label: 'Trading name',
          required: true,
          value: options.business.tradingName,
          error: error('tradingName'),
        })}
        ${Field({
          name: 'proprietorName',
          label: 'Your name (the proprietor)',
          required: true,
          value: options.business.proprietorName,
          hint: 'A sole trader has to publish this. It is you, not the trading name.',
          error: error('proprietorName'),
        })}
        ${Field({
          name: 'addressLine1',
          label: 'Address line 1',
          required: true,
          value: options.business.addressLine1,
          error: error('addressLine1'),
        })}
        ${Field({ name: 'addressLine2', label: 'Address line 2', value: options.business.addressLine2 })}
        ${Field({ name: 'city', label: 'Town or city', required: true, value: options.business.city, error: error('city') })}
        ${Field({
          name: 'postcode',
          label: 'Postcode',
          required: true,
          mono: true,
          value: options.business.postcode,
          error: error('postcode'),
        })}
        ${Field({ name: 'country', label: 'Country', value: options.business.country })}
        ${Field({
          name: 'contactEmail',
          label: 'Contact email shown to customers',
          control: 'email',
          required: true,
          value: options.business.contactEmail,
          error: error('contactEmail'),
        })}
        ${Field({
          name: 'vatNumber',
          label: 'VAT number',
          mono: true,
          value: options.business.vatNumber,
          hint: 'Leave empty if you are not VAT registered. That is normal and not a problem.',
        })}
        ${Button({ label: 'Save business details', variant: 'primary', type: 'submit' })}
      </form>`,
    })}

    ${Card({
      title: 'Pricing',
      headingLevel: 2,
      body: html`<form method="post" action="/owner/settings/pricing" class="stack">
        <input type="hidden" name="csrf_token" value="${options.csrfToken ?? ''}" />
        ${Callout({
          tone: 'note',
          title: 'This applies to future purchases only',
          body: html`<p>
            Changing the price here never re-prices anyone who has already bought. Their price is held against
            their subscription at the payment provider, and nothing on this page reaches in and changes it.
          </p>`,
        })}
        ${Field({
          name: 'monthlyAmount',
          label: 'Monthly price',
          required: true,
          mono: true,
          inputmode: 'decimal',
          value: (options.pricing.monthlyAmountMinor / 100).toFixed(2),
          error: error('monthlyAmount'),
        })}
        ${Field({
          name: 'runsIncluded',
          label: 'Runs included each month',
          required: true,
          mono: true,
          inputmode: 'numeric',
          value: String(options.pricing.runsIncluded),
          error: error('runsIncluded'),
        })}
        ${Field({
          name: 'stripePriceId',
          label: 'Payment provider price id',
          mono: true,
          value: options.pricing.stripePriceId,
          hint: 'Leave empty until commerce is configured. A price typed here is never charged — the provider holds the real one.',
          error: error('stripePriceId'),
        })}
        ${Button({ label: 'Save pricing', variant: 'primary', type: 'submit' })}
      </form>`,
    })}

    ${Card({
      title: 'Notifications',
      headingLevel: 2,
      body: html`<form method="post" action="/owner/settings/notifications" class="stack">
        <input type="hidden" name="csrf_token" value="${options.csrfToken ?? ''}" />
        ${Field({
          name: 'ownerEmail',
          label: 'Where your alerts go',
          control: 'email',
          value: options.notifications.ownerEmail,
          hint: 'Empty means alerts are still recorded here but nothing is emailed.',
        })}
        ${Checkbox({
          name: 'onConnectionBroken',
          label: 'A customer connection breaks',
          checked: options.notifications.onConnectionBroken,
        })}
        ${Checkbox({
          name: 'onPaymentFailure',
          label: 'A payment fails',
          checked: options.notifications.onPaymentFailure,
        })}
        ${Checkbox({ name: 'onSupportCase', label: 'Somebody asks for help', checked: options.notifications.onSupportCase })}
        ${Checkbox({
          name: 'onBudgetThreshold',
          label: 'Spending approaches a limit you set',
          checked: options.notifications.onBudgetThreshold,
        })}
        ${Checkbox({
          name: 'onVerificationFailure',
          label: 'Any verification fails (noisy — off by default)',
          checked: options.notifications.onVerificationFailure,
        })}
        ${Field({
          name: 'digestMinutes',
          label: 'Group alerts into one message every (minutes)',
          mono: true,
          inputmode: 'numeric',
          value: String(options.notifications.digestMinutes),
        })}
        ${Button({ label: 'Save notifications', variant: 'primary', type: 'submit' })}
      </form>`,
    })}

    ${Card({
      title: 'How long things are kept',
      headingLevel: 2,
      body: html`<form method="post" action="/owner/settings/retention" class="stack">
        <input type="hidden" name="csrf_token" value="${options.csrfToken ?? ''}" />
        <p class="small">
          Shortening one of these takes effect immediately. Lengthening one applies only to things collected
          afterwards — we already told customers the shorter figure, and we are not going to quietly keep
          their data longer than we said.
        </p>
        ${(
          [
            ['evidenceDays', 'Evidence'],
            ['runDays', 'Runs'],
            ['auditDays', 'Audit trail'],
            ['visitDays', 'Visit records'],
            ['supportCaseDays', 'Support cases'],
          ] as const
        ).map(([key, label]) =>
          Field({
            name: key,
            label: `${label} (days)`,
            mono: true,
            inputmode: 'numeric',
            value: String(options.retention[key]),
            hint: `Between ${RETENTION_BOUNDS[key].min} and ${RETENTION_BOUNDS[key].max}.`,
            error: error(key),
          }),
        )}
        ${Button({ label: 'Save retention', variant: 'primary', type: 'submit' })}
      </form>`,
    })}

    ${Card({
      title: 'Approved spending limits',
      headingLevel: 2,
      body: html`<div class="stack-sm">
        ${Callout({
          tone: 'warn',
          title: 'Raising a limit needs an approval',
          body: html`<p>
            This is the one setting here that can cost money, so it does not share the ordinary save button.
            Grant an approval for the new limit on the <a href="/owner/approvals">approvals page</a> first; the
            approval is bound to the exact figure.
          </p>`,
        })}
        ${Table({
          caption: 'Current approved limits',
          columns: [
            { key: 'scope', header: 'Budget', rowHeader: true, cell: (row) => html`<span class="mono">${row[0]}</span>` },
            {
              key: 'limit',
              header: 'Limit',
              numeric: true,
              cell: (row) => html`<span class="mono">${formatMoney(money(row[1], options.budgetLimits.currency))}</span>`,
            },
          ],
          rows: Object.entries(options.budgetLimits.limits),
        })}
        <p class="small">
          Safety buffer held back from every limit:
          <span class="mono">${formatMoney(money(options.budgetLimits.safetyBufferMinor, options.budgetLimits.currency))}</span>.
        </p>
      </div>`,
    })}

    ${Card({
      title: 'Administrative entry point',
      headingLevel: 2,
      body: html`<form method="post" action="/owner/settings/access-mode" class="stack">
        <input type="hidden" name="csrf_token" value="${options.csrfToken ?? ''}" />
        ${Field({
          name: 'mode',
          label: 'Access mode',
          control: 'select',
          value: options.accessMode,
          options: [
            { value: 'PUBLIC_LOGIN', label: 'Public login — the sign-in link is shown' },
            { value: 'RESTRICTED_ENTRY', label: 'Restricted entry — the sign-in link is hidden' },
          ],
        })}
        ${Callout({
          tone: 'limit',
          title: 'Restricted entry is not a security control',
          body: html`<p data-access-mode-note="true">${mode.honestDescription}</p>`,
        })}
        ${Button({ label: 'Save access mode', variant: 'primary', type: 'submit' })}
      </form>`,
    })}

    ${Card({
      title: 'Automation test identity',
      headingLevel: 2,
      body: html`<div class="stack-sm">
        <p class="measure">
          Browser tests sign in as a scoped identity that expires on its own. It can look at this panel, ask
          for a test suite to run and preview a cleanup. It cannot do any of these, and the capability is
          simply absent rather than switched off:
        </p>
        <ul class="stack-sm">
          ${AUTOMATION_DENIED.map((capability) => html`<li><span class="mono">${capability}</span></li>`)}
        </ul>
        <p class="small">
          Anything that changes money, access or what the public sees also needs a two-factor check from the
          last ${Math.round(MFA_WINDOW_SECONDS / 60)} minutes, whoever is asking.
        </p>
      </div>`,
    })}
  </div>`;
}
