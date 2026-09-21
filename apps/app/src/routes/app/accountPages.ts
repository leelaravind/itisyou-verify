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
  SETUP_UNAVAILABLE_VIEWER_REASON,
  SETUP_UNAVAILABLE_VIEWER_WHEN,
  UnavailableAction,
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
  ConnectionTestResult,
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

/**
 * The three things a connection test establishes, drawn as three, never as one tick.
 *
 * A provider answering our API call proves the credential is live and scoped. It does not
 * prove a webhook has ever arrived, and neither proves the customer's automation reports
 * enquiries to us. One green "Connected" covering all three is how somebody ends up
 * believing a workflow is monitored while nothing reaches us.
 */
function testFindings(result: ConnectionTestResult): Html {
  const rows: readonly (readonly [string, StatusKey, string])[] = [
    [
      'API access',
      result.apiAccess === 'ok' ? 'VERIFIED' : result.apiAccess === 'failed' ? 'FAILED' : 'UNVERIFIED',
      result.apiAccess === 'ok'
        ? 'The provider answered our read with this credential, just now.'
        : result.apiAccess === 'failed'
          ? 'The provider refused or could not answer our read.'
          : 'Not checked.',
    ],
    [
      'Webhook readiness',
      result.webhookReadiness === 'received'
        ? 'VERIFIED'
        : result.webhookReadiness === 'not_applicable'
          ? 'PENDING'
          : 'UNVERIFIED',
      result.webhookReadiness === 'received'
        ? 'A correctly signed callback from this provider has been received and understood.'
        : result.webhookReadiness === 'not_applicable'
          ? 'This provider is polled rather than received, so there is no webhook to be ready.'
          : 'No correctly signed callback has ever arrived. A stored signing secret is a promise that one will; it is not a record that one did.',
    ],
    [
      'Workflow verification',
      'UNVERIFIED',
      'Not checked, and this button cannot check it. Whether your automation reports its enquiries to us is only observable from the events it sends, so a healthy connection tells you nothing about it.',
    ],
  ];
  return html`<div class="stack-sm" data-test-findings="${result.provider}">
    ${rows.map(
      ([label, status, detail]) => html`<div class="margin-row">
        <div class="margin-row__gutter">${StatusBadge({ status, label })}</div>
        <p class="small muted">${detail}</p>
      </div>`,
    )}
  </div>`;
}

/** What the last press of Test connection found, rendered on the card it belongs to. */
function testOutcome(result: ConnectionTestResult): Html {
  return html`<div
    class="ruled-col stack-sm"
    data-connection-test-result="${result.provider}"
    aria-live="polite"
  >
    <h3>Checked ${formatInstant(result.checkedAt)}</h3>
    ${
      result.blockedReason === null
        ? null
        : formMessage(result.blockedReason, 'warn')
    }
    ${result.blockedReason !== null ? null : html`<p class="small">${result.summary}</p>`}
    ${result.blockedReason !== null ? null : testFindings(result)}
    ${
      result.nextStep === null
        ? null
        : html`<p class="small"><strong>Next step.</strong> ${result.nextStep}</p>`
    }
    ${
      result.credentialsPreserved
        ? html`<p class="micro">
            Your stored credential was not changed by this check. A provider we cannot reach is our
            problem or theirs, never a reason to make you paste a working key again.
          </p>`
        : null
    }
  </div>`;
}

export function ConnectionsPage(options: {
  readonly connections: readonly ConnectionView[];
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
  /** False for a viewer, and for a port that cannot test. The control says which. */
  readonly canTest: boolean;
  /** The result of the press that produced this render, if this render came from one. */
  readonly tested: ConnectionTestResult | null;
}): Html {
  return html`<div class="wrap section stack-lg">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Connections' }])}
    <div class="section-head">
      ${pageHead({
        eyebrow: 'Connections',
        title: 'Connection health',
        lede: 'When a connection is unhealthy we cannot read evidence through it. Runs that need it show as unverified with the reason, never as a false pass, and never as a failure we cannot evidence.',
      })}
      ${options.connections.length === 0 ? null : connectionTally(options.connections)}
    </div>
    ${formMessage(options.submitted?.message ?? null, options.submitted?.ok ? 'note' : 'warn')}

    <!--
      This notice said "We only ever read" and then "Neither connection grants permission
      to create or edit a CRM record, or to send an email". The first half is true of us.
      The second half was a claim about the CREDENTIAL, and for Resend it was false:
      Resend publishes no read-only key, so the key a customer pastes is a full-access one
      that CAN send mail from their domain and delete resources in their account. The
      connect page already says so where the key is pasted; this page contradicted it.

      What is true, and is what it says now, is a statement about our code rather than
      about the permissions they handed us. The difference matters precisely because the
      key is more powerful than we need: a customer deciding whether to trust us with it
      deserves the accurate version.
    -->
    ${Callout({
      tone: 'limit',
      title: 'What we do with these credentials',
      body: html`<p>
        Our code only ever reads. It has no path that creates or edits a CRM record, and no path that
        sends an email. That is a fact about this application, not about the keys you gave us: Resend
        publishes no read-only key, so the Resend credential is a full-access one that could send mail
        from your domain if something else used it. We do not, and if a run fails, fixing it is still
        yours to do.
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
                <!-- Test connection, beside the provider it tests.
                     A form rather than a link: each press costs a real outbound call to
                     the customer's own provider account, so it must not be reachable by a
                     prefetch, a crawler or a link preview, and it goes through the CSRF
                     check like every other state-changing action here. The result renders
                     on this card, below. -->
                ${
                  options.canTest
                    ? html`<form method="post" action="/app/connections/test" class="stack-sm">
                        ${CsrfField(options.csrfToken)}
                        <input type="hidden" name="provider" value="${connection.provider}" />
                        ${ButtonRow([
                          Button({
                            label: `Test ${connection.displayName} connection`,
                            type: 'submit',
                          }),
                        ])}
                      </form>`
                    : UnavailableAction({
                        label: `Test ${connection.displayName} connection`,
                        reason: SETUP_UNAVAILABLE_VIEWER_REASON,
                        whenBack: SETUP_UNAVAILABLE_VIEWER_WHEN,
                      })
                }
                ${
                  options.tested === null || options.tested.provider !== connection.provider
                    ? null
                    : testOutcome(options.tested)
                }
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
        lede: `Your plan includes ${String(LIMITS.PLAN_RUNS_PER_PERIOD)} runs a month. We do not charge overage: when the allowance is used we stop accepting events until the next period.`,
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
                existing run rather than starting, or charging for, a second one.
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
            title: `Message recorded · reference ${options.submitted?.reference ?? 'none'}`,
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
  /**
   * Whether the portal could be opened, not a link to it. The same change as on
   * `/app/billing`: a Stripe portal session is single-use, so minting one to decide
   * whether to draw a button meant the link was usually spent before it was clicked.
   */
  readonly portal: { readonly canOpen: boolean; readonly reason: string | null };
  readonly csrfToken: string | null;
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
      !options.portal.canOpen
        ? EmptyState({
            title: 'There is no subscription to cancel',
            body:
              options.portal.reason ??
              'No reason was recorded, which is itself a defect worth reporting.',
            actions: [Button({ label: 'Back to the workspace', href: '/app' })],
          })
        : html`<form method="post" action="/app/billing/portal" class="stack-sm">
            ${CsrfField(options.csrfToken)}
            ${ButtonRow([
              Button({ label: 'Open the billing portal', variant: 'primary', type: 'submit' }),
              Button({ label: 'Back to the workspace', href: '/app', variant: 'quiet' }),
            ])}
          </form>`
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
