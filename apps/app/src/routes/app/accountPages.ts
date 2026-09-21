/**
 * Connection health, usage against the allowance, the support form, and cancellation.
 *
 * The connections and usage screens are laid out to their approved references (the
 * connections / evidence sources screen and the reports / exports screen), translated
 * rather than copied: one framed card per provider in a row with the read-only notice
 * above them and a tally of their states beside the head; the period figures beside the
 * head as a mono bar, the meter in the wider column, and the run counts as four cards
 * under it. Nothing the reference says is on these pages — it names providers, an
 * encryption scheme, export formats and a retention period that are not ours.
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
  type StatusKey,
} from '@verify/ui';
import { PLAN_CANCELLATION_WORDING, meterFillClass, percentFloor } from '@verify/ui';
import { LIMITS } from '@verify/contracts';
import {
  connectionPresentation,
  formMessage,
  pageHead,
  runCountCards,
  runTotal,
} from './chrome.js';
import { formatInstant } from '../public/shared.js';
import type {
  ConnectionView,
  RunCountsView,
  SupportResult,
  UsageView,
  WriteResult,
} from './port.js';

/* ------------------------------------------------------------------ connections */

/**
 * The connections grouped by the state they are shown in, in the order they are listed.
 *
 * Each entry wears the same badge and the same label as the card it counts, so the strip
 * cannot say "ready" about a connection the card says is not finished. Nothing is grouped
 * under a label that no card carries.
 */
function connectionTally(connections: readonly ConnectionView[]): Html {
  const groups = new Map<string, { readonly status: StatusKey; count: number }>();
  for (const connection of connections) {
    const presentation = connectionPresentation(connection.status);
    const group = groups.get(presentation.label);
    if (group === undefined)
      groups.set(presentation.label, { status: presentation.status, count: 1 });
    else group.count += 1;
  }
  return html`<ul class="tally" aria-label="Connections by state">
    ${[...groups.entries()].map(
      ([label, group]) => html`<li data-connection-tally="${label}">
        <span class="tally__count">${String(group.count)}</span>
        ${StatusBadge({ status: group.status, label })}
      </li>`,
    )}
  </ul>`;
}

export function ConnectionsPage(options: {
  readonly connections: readonly ConnectionView[];
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Connections' }])}
    <div class="section-head">
      ${pageHead({
        eyebrow: 'Connections',
        title: 'Connection health',
        lede: 'When a connection is unhealthy we cannot read evidence through it. Runs that need it show as unverified with the reason — never as a false pass, and never as a failure we cannot evidence.',
      })}
      ${options.connections.length === 0 ? null : connectionTally(options.connections)}
    </div>
    ${formMessage(options.submitted?.message ?? null, options.submitted?.ok ? 'note' : 'warn')}

    ${Callout({
      tone: 'limit',
      title: 'We only ever read',
      body: html`<p>
        Neither connection grants permission to create or edit a CRM record, or to send an email. If a run
        fails, fixing it is still yours to do.
      </p>`,
    })}

    ${
      /*
       * A screen whose whole job is to state the position of each provider must never
       * render an empty box. If the list is empty we do not know the position of
       * anything, and saying so is the only honest rendering — silence here would read
       * as "all clear", which is the inference this product exists to refuse.
       */
      options.connections.length === 0
        ? EmptyState({
            title: 'We cannot show your connections right now',
            body:
              'No connection could be read for this workspace, so we cannot tell you whether evidence ' +
              'can be retrieved. This is not a statement that your connections are healthy. Nothing has ' +
              'been changed, and no run has been decided on the strength of this page.',
            actions: [Button({ label: 'Contact support', href: '/app/support', variant: 'quiet' })],
          })
        : html`<div class="grid grid-2">
            ${options.connections.map(
              (
                connection,
              ) => html`<section class="card stack" data-connection-card="${connection.provider}">
                <div class="card__head">
                  <h2 class="card__title">${connection.displayName}</h2>
                  ${StatusBadge(connectionPresentation(connection.status))}
                </div>
                <div class="pane">
                  <dl class="kv">
                    <dt>Account</dt>
                    <dd>${connection.accountLabel ?? 'not connected'}</dd>
                    <dt>Last checked</dt>
                    <dd>${formatInstant(connection.lastCheckedAt)}</dd>
                  </dl>
                </div>
                ${connection.problem === null ? null : html`<p class="small">${connection.problem}</p>`}
                ${
                  connection.nextStep === null
                    ? null
                    : html`<p class="small"><strong>Next step.</strong> ${connection.nextStep}</p>`
                }
                <form method="post" action="/app/onboarding/connect">
                  ${CsrfField(options.csrfToken)}
                  <input type="hidden" name="provider" value="${connection.provider}" />
                  <input type="hidden" name="intent" value="authorise" />
                  ${Button({
                    label: `${connection.status === 'ready' ? 'Reconnect' : 'Connect'} ${connection.displayName}`,
                    variant: connection.status === 'ready' ? 'quiet' : 'primary',
                    type: 'submit',
                  })}
                </form>
              </section>`,
            )}
          </div>`
    }
  </div>`;
}

/* ------------------------------------------------------------------------ usage */

/**
 * @param counts The workflow's run counts by status, when the route could read a workflow.
 *   Null renders no count cards at all rather than four zeros — no workflow is not the same
 *   fact as no runs, and the page must not draw the second when it only knows the first.
 */
export function UsagePage(usage: UsageView, counts: RunCountsView | null = null): Html {
  // `percentFloor`, not `Math.round`. At 499 of 500 the rounded figure is 100, which both
  // prints "100%" and selects `meter__fill--100` — a bar drawn completely full, and an
  // accessible name saying "100 per cent", for an allowance with a run still in it. Same
  // defect as the 33%-drawn-as-full-green bar, one layer up from the CSP that caused it.
  const percent = percentFloor(usage.runsUsed, usage.runsIncluded);
  const remaining = Math.max(0, usage.runsIncluded - usage.runsUsed);
  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Usage' }])}
    <div class="section-head">
      ${pageHead({
        eyebrow: 'Usage',
        title: 'Runs used this period',
        lede: `Your plan includes ${String(LIMITS.PLAN_RUNS_PER_PERIOD)} runs a month. We do not charge overage — when the allowance is used we stop accepting events until the next period.`,
      })}
      <!--
        Not "Period start". The usage method on the customer port says plainly that it
        cannot resolve one: A06 has not exported a period-start resolver, and a second spelling
        of the allowance key here is the A13-010 defect. So this field carries the instant
        the figures were read, and the label now says that. An honest value under a
        dishonest label is the disease this product treats.
      -->
      <ul class="meta-bar" aria-label="This billing period">
        <li>Figures read at <b>${formatInstant(usage.periodStart)}</b></li>
        <li>Period end <b>${formatInstant(usage.periodEnd)}</b></li>
        <li>Subscription <b>${usage.subscriptionStatus ?? 'none'}</b></li>
      </ul>
    </div>

    <div class="grid grid-7-5">
      <div class="stack">
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
            <p class="small muted">
              ${String(remaining)} run${remaining === 1 ? '' : 's'} remaining until ${formatInstant(usage.periodEnd)}.
            </p>
          </div>`,
        })}
      </div>
      <div class="stack">
        ${
          usage.admissionBlocked
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
              })
        }
        ${ButtonRow([Button({ label: 'Manage billing', href: '/app/cancel', variant: 'quiet' })])}
      </div>
    </div>

    ${
      counts === null
        ? null
        : html`<section class="stack-sm" aria-labelledby="runs-by-result-heading" data-runs-by-result>
            <div class="section-head">
              <div class="section-head__text"><h2 id="runs-by-result-heading">Runs by result</h2></div>
              <ul class="meta-bar" aria-label="Runs received">
                <li>Runs received <b>${String(runTotal(counts))}</b></li>
              </ul>
            </div>
            ${runCountCards(counts)}
          </section>`
    }
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

    ${
      succeeded
        ? Callout({
            tone: 'note',
            title: `Message recorded — reference ${options.submitted?.reference ?? 'none'}`,
            body: html`<p>${options.submitted?.message ?? ''}</p>`,
          })
        : formMessage(options.submitted?.message ?? null, options.submitted?.ok ? 'note' : 'warn')
    }

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

    ${
      options.portal.href === null
        ? EmptyState({
            title: 'There is no subscription to cancel',
            body:
              options.portal.reason ??
              'No reason was recorded, which is itself a defect worth reporting.',
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
          ])
    }

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
