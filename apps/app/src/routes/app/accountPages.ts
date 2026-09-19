/**
 * Connection health, usage against the allowance, the support form, and cancellation.
 */
import {
  Button,
  ButtonRow,
  Breadcrumb,
  Callout,
  Card,
  CsrfField,
  EmptyState,
  Field,
  Fieldset,
  StatusBadge,
  html,
  type Html,
} from '@verify/ui';
import { PLAN_CANCELLATION_WORDING, meterFillClass } from '@verify/ui';
import { LIMITS } from '@verify/contracts';
import { formMessage, pageHead } from './chrome.js';
import { formatInstant } from '../public/shared.js';
import type { ConnectionView, SupportResult, UsageView, WriteResult } from './port.js';

/* ------------------------------------------------------------------ connections */

export function ConnectionsPage(options: {
  readonly connections: readonly ConnectionView[];
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Connections' }])}
    ${pageHead({
      eyebrow: 'Connections',
      title: 'Connection health',
      lede:
        'When a connection is unhealthy we cannot read evidence through it. Runs that need it show as unverified with the reason — never as a false pass, and never as a failure we cannot evidence.',
    })}
    ${formMessage(options.submitted?.message ?? null)}

    <div class="stack">
      ${options.connections.map(
        (connection) => html`<div class="card stack-sm">
          <div class="card__head">
            <h2 class="card__title">${connection.displayName}</h2>
            ${StatusBadge({
              status: connection.status === 'ready' ? 'VERIFIED' : 'UNVERIFIED',
              label: connection.status.replace(/_/g, ' '),
            })}
          </div>
          <dl class="kv">
            <dt>Account</dt>
            <dd>${connection.accountLabel ?? 'not connected'}</dd>
            <dt>Last checked</dt>
            <dd>${formatInstant(connection.lastCheckedAt)}</dd>
          </dl>
          ${connection.problem === null ? null : html`<p class="small">${connection.problem}</p>`}
          ${connection.nextStep === null
            ? null
            : html`<p class="small"><strong>Next step.</strong> ${connection.nextStep}</p>`}
          <form method="post" action="/app/onboarding/connect">
            ${CsrfField(options.csrfToken)}
            <input type="hidden" name="provider" value="${connection.provider}" />
            ${Button({
              label: `${connection.status === 'ready' ? 'Reconnect' : 'Connect'} ${connection.displayName}`,
              variant: connection.status === 'ready' ? 'quiet' : 'primary',
              type: 'submit',
            })}
          </form>
        </div>`,
      )}
    </div>

    ${Callout({
      tone: 'limit',
      title: 'We only ever read',
      body: html`<p>
        Neither connection grants permission to create or edit a CRM record, or to send an email. If a run
        fails, fixing it is still yours to do.
      </p>`,
    })}
  </div>`;
}

/* ------------------------------------------------------------------------ usage */

export function UsagePage(usage: UsageView): Html {
  const percent = Math.round((usage.runsUsed / usage.runsIncluded) * 100);
  const remaining = Math.max(0, usage.runsIncluded - usage.runsUsed);
  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Usage' }])}
    ${pageHead({
      eyebrow: 'Usage',
      title: 'Runs used this period',
      lede: `Your plan includes ${String(LIMITS.PLAN_RUNS_PER_PERIOD)} runs a month. We do not charge overage — when the allowance is used we stop accepting events until the next period.`,
    })}

    ${Card({
      title: 'This billing period',
      headingLevel: 2,
      body: html`<div class="stack-sm">
        <p class="score">${String(usage.runsUsed)}<span class="faint">/${String(usage.runsIncluded)}</span></p>
        <div
          class="meter"
          role="img"
          aria-label="${String(usage.runsUsed)} of ${String(usage.runsIncluded)} runs used, ${String(percent)} per cent"
        >
          <div class="${meterFillClass(percent)}"></div>
        </div>
        <p class="small muted">${String(remaining)} runs remaining until ${formatInstant(usage.periodEnd)}.</p>
        <dl class="kv">
          <dt>Period start</dt>
          <dd>${formatInstant(usage.periodStart)}</dd>
          <dt>Period end</dt>
          <dd>${formatInstant(usage.periodEnd)}</dd>
          <dt>Subscription</dt>
          <dd>${usage.subscriptionStatus ?? 'none'}</dd>
        </dl>
      </div>`,
    })}

    ${usage.admissionBlocked
      ? Callout({
          tone: 'warn',
          title: "This period's allowance is used",
          body: html`<p>
            We have stopped accepting new events for this workflow until the next period starts. Enquiries
            arriving now are not being checked, and they will not appear as runs later.
          </p>`,
        })
      : Callout({
          tone: 'note',
          title: 'What counts as a run',
          body: html`<p>
            One signed event, for one enquiry, counted once. Sending the same event id again returns the
            existing run rather than starting — or charging for — a second one.
          </p>`,
        })}

    ${ButtonRow([Button({ label: 'Manage billing', href: '/app/cancel', variant: 'quiet' })])}
  </div>`;
}

/* ---------------------------------------------------------------------- support */

export function SupportFormPage(options: {
  readonly csrfToken: string | null;
  readonly submitted: SupportResult | null;
  readonly subject: string;
  readonly body: string;
  readonly runId: string | null;
}): Html {
  const errors = options.submitted?.fieldErrors ?? {};
  const succeeded = options.submitted?.ok === true;
  return html`<div class="wrap section stack-lg measure">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Support' }])}
    ${pageHead({
      eyebrow: 'Support',
      title: 'Ask us something',
      lede: 'Tell us what you expected and what you saw. If it is about one run, include its reference.',
    })}

    ${succeeded
      ? Callout({
          tone: 'note',
          title: `Message recorded — reference ${options.submitted?.reference ?? 'none'}`,
          body: html`<p>${options.submitted?.message ?? ''}</p>`,
        })
      : formMessage(options.submitted?.message ?? null)}

    <form method="post" action="/app/support" class="stack">
      ${CsrfField(options.csrfToken)}
      ${Fieldset({
        legend: 'Your message',
        body: html`${Field({
          name: 'subject',
          label: 'Subject',
          control: 'text',
          value: options.subject,
          required: true,
          maxlength: 160,
          error: errors['subject'] ?? null,
        })}
        ${Field({
          name: 'runId',
          label: 'Run reference',
          control: 'text',
          value: options.runId ?? '',
          mono: true,
          hint: 'Optional. Copy it from the run page if your question is about one result.',
          error: errors['runId'] ?? null,
        })}
        ${Field({
          name: 'body',
          label: 'What happened',
          control: 'textarea',
          value: options.body,
          required: true,
          rows: 7,
          hint: 'What you expected, what you saw, and the run reference if there is one.',
          error: errors['body'] ?? null,
        })}`,
      })}
      ${Button({ label: 'Send message', variant: 'primary', type: 'submit' })}
    </form>

    <p class="small muted">
      Most questions are answered on the <a href="/support">public support page</a>, which lists what this
      product deliberately does not do.
    </p>
  </div>`;
}

/* ----------------------------------------------------------------- cancellation */

export function CancelPage(options: {
  readonly portal: { readonly href: string | null; readonly reason: string | null };
}): Html {
  return html`<div class="wrap section stack-lg measure">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Billing and cancellation' }])}
    ${pageHead({
      eyebrow: 'Billing',
      title: 'Cancel your plan',
      lede: 'Cancelling takes one action and does not go through us. You do not have to ask, explain, or wait.',
    })}

    ${Callout({ tone: 'note', title: 'What cancelling does', body: html`<p>${PLAN_CANCELLATION_WORDING}</p>` })}

    ${options.portal.href === null
      ? EmptyState({
          title: 'There is no subscription to cancel',
          body: options.portal.reason ?? 'No reason was recorded, which is itself a defect worth reporting.',
          actions: [Button({ label: 'Back to the workspace', href: '/app' })],
        })
      : ButtonRow([
          Button({
            label: 'Open the billing portal',
            href: options.portal.href,
            variant: 'primary',
            external: true,
          }),
          Button({ label: 'Back to the workspace', href: '/app', variant: 'quiet' }),
        ])}

    ${Callout({
      tone: 'limit',
      title: 'After you cancel',
      body: html`<p>
        We stop accepting events when the period you have paid for ends. Evidence already collected is
        removed on the normal ${String(LIMITS.EVIDENCE_RETENTION_DAYS)}-day schedule, not immediately.
      </p>`,
    })}
  </div>`;
}
