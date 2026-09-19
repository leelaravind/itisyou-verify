/**
 * Advertising and approvals.
 *
 * The ads screen has one job beyond showing numbers: never to imply more certainty than we
 * have. Two rules do the work:
 *
 *  - A pause we requested renders as **pause requested**, never as *paused*, until the
 *    platform confirms it. The state comes from `owner/controls.ts`'s `adPauseView`, which
 *    will not return `paused` on our own say-so.
 *  - Every metric carries its observation time, and one older than an hour is marked stale
 *    in the row itself rather than in a footnote. An ad spend figure from yesterday shown
 *    without comment is how £15 becomes £60.
 */
import { Button, Callout, Card, Field, KeyValues, Table, html, type Html } from '@verify/ui';
import { formatMoney, money, type Currency } from '@verify/contracts';
import { freshness } from '../../owner/finance.js';
import { approvalStanding, OWNER_ACTION_TYPES, type OwnerApproval } from '../../owner/approvals.js';
import { adPauseView } from '../../owner/controls.js';
import { ActionForm, Instant, PageHead, UnknownAware } from './chrome.js';
import type { CampaignView } from '../../owner/port.js';

function asCurrency(code: string): Currency {
  return code === 'USD' ? 'USD' : code === 'EUR' ? 'EUR' : 'GBP';
}

function amount(minor: number | null, currency: string): Html {
  if (minor === null) return html`<span class="muted" data-unknown="true">unknown</span>`;
  return html`<span class="mono">${formatMoney(money(minor, asCurrency(currency)))}</span>`;
}

export function AdsPage(options: {
  readonly campaigns: readonly CampaignView[];
  readonly csrfToken: string | null;
  readonly now: Date;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Advertising',
      title: 'Campaigns',
      lede: 'What is drafted, what is approved, what is actually running, and what it has cost.',
    })}

    ${Callout({
      tone: 'limit',
      title: 'What this page can and cannot tell you',
      body: html`<p>
        We can tell you what we submitted and what the ad platform last told us. We cannot tell you what is
        being shown right now. Anything marked <strong>pause requested</strong> may still be spending, and
        anything marked <strong>out of date</strong> is a figure we have not refreshed recently enough to act
        on.
      </p>`,
    })}

    <div class="stack">
      ${options.campaigns.map((campaign) => CampaignCard({ campaign, csrfToken: options.csrfToken, now: options.now }))}
      ${options.campaigns.length === 0
        ? html`<p class="muted">No campaigns have been drafted.</p>`
        : null}
    </div>
  </div>`;
}

export function CampaignCard(options: {
  readonly campaign: CampaignView;
  readonly csrfToken: string | null;
  readonly now: Date;
}): Html {
  const c = options.campaign;
  const sync = freshness(c.lastSyncAt, options.now);
  const pause = adPauseView({
    pauseRequested: c.state === 'pause_pending',
    providerState: c.lastSyncAt === null ? null : c.state,
    providerObservedAt: c.lastSyncAt,
    ownerConfirmedPaused: false,
  });

  return Card({
    title: c.headline,
    headingLevel: 2,
    aside: html`<span class="badge ${pause.state === 'active' ? 'badge--verified' : 'badge--unverified'}"
      data-campaign-state="${pause.state}"
      >${pause.state.replace(/_/g, ' ')}</span
    >`,
    body: html`<div class="stack">
      <p class="small">${pause.explanation}</p>

      ${KeyValues([
        ['Campaign', html`<span class="mono">${c.id}</span>`],
        [
          'Platform id',
          c.externalId === null
            ? html`<span class="muted">not submitted</span>`
            : html`<span class="mono">${c.externalId}</span>`,
        ],
        ['Destination', html`<span class="mono micro">${c.destinationUrl}</span>`],
        ['Audience', c.audienceSummary],
        ['Approved budget', amount(c.budgetMinor, c.currency)],
        ['Spend', amount(c.spendMinor, c.currency)],
        ['Visits', UnknownAware(c.visits)],
        ['Signups', UnknownAware(c.signups)],
        [
          'Approval',
          c.approvalId === null
            ? html`<span class="muted">not approved</span>`
            : html`<span class="mono micro">${c.approvalId}</span>`,
        ],
        ['Runs', html`${Instant(c.startsAt)} → ${Instant(c.endsAt)}`],
        [
          'Last synchronised',
          html`${Instant(c.lastSyncAt)}
          ${sync.stale
            ? html` <span class="badge badge--unverified" data-stale="true">out of date</span>`
            : null}`,
        ],
      ])}

      ${c.lastSyncError === null
        ? null
        : Callout({
            tone: 'warn',
            title: 'The last synchronisation failed',
            body: html`<p class="mono micro">${c.lastSyncError}</p>
              <p class="small">
                Until this succeeds, the spend and status above are the last ones we managed to read, not the
                current ones.
              </p>`,
          })}

      <div class="btn-row">
        ${ActionForm({
          action: `/owner/ads/${encodeURIComponent(c.id)}/pause`,
          csrfToken: options.csrfToken,
          body: Button({ label: 'Request pause', variant: 'danger', type: 'submit' }),
        })}
        ${ActionForm({
          action: `/owner/ads/${encodeURIComponent(c.id)}/resume`,
          csrfToken: options.csrfToken,
          body: Button({ label: 'Resume', variant: 'quiet', type: 'submit' }),
        })}
        ${ActionForm({
          action: `/owner/ads/${encodeURIComponent(c.id)}/activate`,
          csrfToken: options.csrfToken,
          confirm: 'activate',
          body: html`<p class="small">
              Activating submits this campaign to the ad platform and starts spending real money against the
              approval named above.
            </p>
            <div class="field">
              <label class="field__label" for="f-approval-${c.id}"
                >Approval id <span class="field__req">required</span></label
              >
              <input class="input input--mono" id="f-approval-${c.id}" name="approval_id" required />
            </div>
            ${Button({ label: 'Activate campaign', variant: 'primary', type: 'submit' })}`,
        })}
      </div>
    </div>`,
  });
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const STANDING_LABEL: Readonly<Record<'usable' | 'expired' | 'used' | 'withdrawn', string>> = {
  usable: 'stands',
  expired: 'expired',
  used: 'already used',
  withdrawn: 'withdrawn',
};

export function ApprovalsPage(options: {
  readonly approvals: readonly OwnerApproval[];
  readonly csrfToken: string | null;
  readonly now: Date;
  readonly formError: string | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${PageHead({
      eyebrow: 'Approvals',
      title: 'What you have approved',
      lede:
        'Each approval records exactly what action, at exactly what amount, by whom and when — and stops applying if any of it changes.',
    })}

    ${Callout({
      tone: 'note',
      title: 'An approval is about one exact thing',
      body: html`<p>
        Approving a £15.00 campaign does not approve a £15.01 one. The approval is bound to a fingerprint of
        the whole payload, so changing a budget, a date, an audience or a word of the ad text makes it stop
        applying — you will be asked again rather than the change slipping through.
      </p>`,
    })}

    ${options.formError === null
      ? null
      : Callout({ tone: 'warn', title: 'That approval was not granted', body: html`<p>${options.formError}</p>` })}

    ${Card({
      title: 'Standing approvals',
      headingLevel: 2,
      body: Table({
        caption: 'Every approval and whether it still stands',
        columns: [
          {
            key: 'summary',
            header: 'What was approved',
            rowHeader: true,
            cell: (a) => html`${a.summary}<br /><span class="micro mono">${a.id}</span>`,
          },
          { key: 'action', header: 'Action', cell: (a) => html`<span class="mono micro">${a.action_type}</span>` },
          {
            key: 'max',
            header: 'Up to',
            numeric: true,
            cell: (a) =>
              a.maximum_amount_minor === null
                ? html`<span class="muted">no amount</span>`
                : html`<span class="mono"
                    >${formatMoney(money(a.maximum_amount_minor, a.currency ?? 'GBP'))}</span
                  >`,
          },
          { key: 'by', header: 'Approved by', cell: (a) => html`<span class="mono micro">${a.owner_id}</span>` },
          { key: 'when', header: 'Approved', cell: (a) => Instant(a.created_at) },
          { key: 'until', header: 'Lapses', cell: (a) => Instant(a.expires_at) },
          {
            // Half the point of an approval existing: when it was actually spent.
            key: 'spent',
            header: 'Spent',
            cell: (a) =>
              a.consumed_at === null
                ? html`<span class="muted" data-spent="never">not yet</span>`
                : html`<span data-spent="${a.consumed_at}">${Instant(a.consumed_at)}</span>`,
          },
          {
            key: 'standing',
            header: 'Standing',
            cell: (a) => {
              const standing = approvalStanding(a, options.now);
              return html`<span data-standing="${standing}">${STANDING_LABEL[standing]}</span>`;
            },
          },
          {
            key: 'actions',
            header: '',
            cell: (a) =>
              approvalStanding(a, options.now) === 'usable'
                ? ActionForm({
                    action: `/owner/approvals/${encodeURIComponent(a.id)}/revoke`,
                    csrfToken: options.csrfToken,
                    body: Button({ label: 'Withdraw', variant: 'quiet', type: 'submit' }),
                  })
                : html`<span class="muted micro">—</span>`,
          },
        ],
        rows: options.approvals,
        empty: html`<p class="muted">Nothing has been approved yet.</p>`,
      }),
    })}

    ${Card({
      title: 'Approve something',
      headingLevel: 2,
      body: html`<form method="post" action="/owner/approvals" class="stack">
        <input type="hidden" name="csrf_token" value="${options.csrfToken ?? ''}" />
        ${Field({
          name: 'action_type',
          label: 'What kind of action',
          control: 'select',
          required: true,
          options: OWNER_ACTION_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })),
        })}
        ${Field({
          name: 'summary',
          label: 'What you are approving, in your own words',
          required: true,
          hint: 'You will read this back in a year. "Refund September for the broken HubSpot connection" beats "refund".',
        })}
        ${Field({
          name: 'maximum_amount',
          label: 'Maximum amount',
          hint: 'Leave empty for an action that moves no money. Otherwise the most this may cost, like 15.00.',
          inputmode: 'decimal',
          mono: true,
        })}
        ${Field({
          name: 'payload_json',
          label: 'The exact payload being approved',
          control: 'textarea',
          required: true,
          mono: true,
          rows: 8,
          hint: 'This is fingerprinted. If any of it changes afterwards, the approval stops applying.',
        })}
        ${Button({ label: 'Approve', variant: 'primary', type: 'submit' })}
      </form>`,
    })}
  </div>`;
}
