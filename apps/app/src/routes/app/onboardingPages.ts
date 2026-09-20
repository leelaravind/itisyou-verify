/**
 * The setup journey: compatibility → connect → map fields → expected outcome → proof run →
 * review and price → checkout hand-off → activation.
 *
 * Every page is a real `<form method="post">` that works with JavaScript off, every field
 * carries its error inline with `aria-describedby`, and every step can be reached and
 * completed with a keyboard alone.
 */
import {
  ACTIVATION_UNAVAILABLE_REASON,
  ACTIVATION_UNAVAILABLE_WHEN,
  ActivationNotice,
  AssertionRow,
  Button,
  UnavailableAction,
  ButtonRow,
  Callout,
  Card,
  Checkbox,
  CsrfField,
  EmptyState,
  Field,
  Fieldset,
  RunVerdict,
  StatusBadge,
  Table,
  gapsFrom,
  html,
  type Html,
  type StatusKey,
} from '@verify/ui';
import {
  COVERAGE_MODE_SUPPORT,
  SELECTABLE_COVERAGE_MODES,
  explainAssertion,
  explainRunStatus,
} from '@verify/domain';
import { setupGuide, type ProviderSetupGuide } from '@verify/connectors';
import { preCheckoutPanel, type DisclosureSection } from '../../billing/index.js';
import { LIMITS, type CoverageMode } from '@verify/contracts';
import { connectionPresentation, formMessage, onboardingProgress, pageHead } from './chrome.js';
import { formatDuration } from '../public/shared.js';
import type {
  ActivationView,
  ConnectionView,
  ConnectorCompatibility,
  OrderSummaryView,
  ProofRunView,
  SigningKeyIssueResult,
  WorkflowDetail,
  WriteResult,
} from './port.js';

interface StepShellOptions {
  readonly href: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly lede: string;
  readonly body: Html;
}

function stepShell(options: StepShellOptions): Html {
  return html`<div class="wrap section stack-lg">
    ${onboardingProgress(options.href)}
    ${pageHead({ eyebrow: options.eyebrow, title: options.title, lede: options.lede })}
    ${options.body}
  </div>`;
}

/* ------------------------------------------------------------- 1. compatibility */

export function CompatibilityPage(entries: readonly ConnectorCompatibility[]): Html {
  const blocked = entries.filter((entry) => !entry.supported);
  return stepShell({
    href: '/app/onboarding/compatibility',
    eyebrow: 'Step 1 of 7',
    title: 'Can we verify your setup?',
    lede: 'Version one checks exactly one workflow shape, using exactly two providers. Read this before you connect anything — if your automation does something else, we cannot verify it yet.',
    body: html`<div class="stack-lg">
      ${ActivationNotice()}
      ${
        blocked.length === 0
          ? null
          : Callout({
              tone: 'warn',
              title: 'Something here is not supported',
              body: html`<ul>
              ${blocked.map((entry) => html`<li>${entry.unsupportedReason}</li>`)}
            </ul>`,
            })
      }

      <div class="grid grid-2">
        ${entries.map((entry) =>
          Card({
            title: entry.displayName,
            aside: StatusBadge({
              status: entry.supported ? 'VERIFIED' : 'FAILED',
              label: entry.supported ? 'Supported' : 'Not supported',
            }),
            body: html`<div class="stack-sm">
              <p class="small muted">${entry.purpose}</p>
              <p class="eyebrow">You need</p>
              <ul class="small">
                ${entry.requirements.map((requirement) => html`<li>${requirement}</li>`)}
              </ul>
            </div>`,
          }),
        )}
      </div>

      ${Callout({
        tone: 'limit',
        title: 'One more thing, and it is real work',
        body: html`<p>
          Your automation has to send us one signed event for each enquiry. That means editing the flow you
          already have to add an outbound call. We cannot do this part for you, and without it we have
          nothing to check.
        </p>`,
      })}

      ${UnavailableAction({
        label: 'These all apply — continue',
        reason: ACTIVATION_UNAVAILABLE_REASON,
        whenBack: ACTIVATION_UNAVAILABLE_WHEN,
      })}
      ${ButtonRow([Button({ label: 'Read the setup requirements', href: '/how-it-works', variant: 'quiet' })])}
    </div>`,
  });
}

/* -------------------------------------------------------------------- 2. connect */

export interface ConnectPageOptions {
  readonly connections: readonly ConnectionView[];
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
  /** Which provider's form the last submission concerned, so its errors land on its card. */
  readonly submittedProvider?: string;
  /** False when the port cannot yet accept a credential; the page says so instead of lying. */
  readonly canSubmitCredentials: boolean;
}

/**
 * The permission notice.
 *
 * Rendered **above the paste box**, at full size, never inside a disclosure control. For
 * Resend it is the most important paragraph on the site: it says that Resend publishes no
 * read-only key, that reading a message back therefore needs a full-access key, and that the
 * key the customer is about to hand over could also send mail from their domain and delete
 * resources in their account. It then says the connector has no send path — without
 * pretending the key is narrower than it is.
 *
 * A customer deserves to read that on the page where they paste it, not to discover it
 * afterwards. `broaderThanNeeded` picks the warn tone so it cannot be skimmed past.
 */
function permissionNotice(guide: ProviderSetupGuide): Html {
  return Callout({
    tone: guide.permissionNotice.broaderThanNeeded ? 'warn' : 'note',
    title: guide.permissionNotice.headline,
    body: html`<p data-permission-notice="${guide.provider}">${guide.permissionNotice.body}</p>`,
  });
}

/** Three lists that together say exactly where this connection's power begins and ends. */
function scopeLists(guide: ProviderSetupGuide): Html {
  const list = (heading: string, items: readonly string[]): Html => html`<div class="stack-sm">
    <p class="eyebrow">${heading}</p>
    <ul class="small muted">
      ${items.map((item) => html`<li>${item}</li>`)}
    </ul>
  </div>`;
  return html`<div class="grid grid-3">
    ${list('What we read', guide.weRead)}${list('What we never do', guide.weNeverDo)}
    ${list('What this cannot prove', guide.cannotProve)}
  </div>`;
}

function setupInstructions(guide: ProviderSetupGuide): Html {
  return html`<ol class="steps steps--tight">
    ${guide.instructions.map(
      (instruction) => html`<li>
        <p class="small">${instruction.text}</p>
      </li>`,
    )}
  </ol>`;
}

/**
 * The paste form.
 *
 * A secret field is never given a value: a credential is not echoed back to the page, not
 * even the one just submitted and not even masked. `autocomplete="off"` keeps a browser from
 * filing an API key in a password-manager entry the customer did not mean to create.
 */
function credentialForm(
  guide: ProviderSetupGuide,
  options: ConnectPageOptions,
  errors: Readonly<Record<string, string>>,
): Html {
  return html`<form method="post" action="/app/onboarding/connect" class="stack">
    ${CsrfField(options.csrfToken)}
    <input type="hidden" name="provider" value="${guide.provider}" />
    <input type="hidden" name="intent" value="credentials" />
    ${Fieldset({
      legend: `Paste your ${guide.displayName} credentials`,
      hint: guide.whatHappensNext,
      body: html`${guide.fields.map((field) =>
        Field({
          name: field.name,
          label: field.label,
          control: field.secret ? 'password' : 'text',
          required: field.required,
          mono: true,
          placeholder: field.placeholder,
          hint: field.hint,
          autocomplete: 'off',
          error: errors[field.name] ?? null,
        }),
      )}`,
    })}
    ${Button({
      label: options.canSubmitCredentials
        ? `Check this ${guide.displayName} credential`
        : 'Checking is not available yet',
      variant: 'primary',
      type: 'submit',
      disabled: !options.canSubmitCredentials,
    })}
  </form>`;
}

function connectCard(connection: ConnectionView, options: ConnectPageOptions): Html {
  const guide = setupGuide(connection.provider);
  const presentation = connectionPresentation(connection.status);
  const mine = options.submittedProvider === connection.provider;
  const errors = mine ? (options.submitted?.fieldErrors ?? {}) : {};

  return html`<section class="card stack" data-connect-card="${connection.provider}">
    <div class="card__head">
      <h2 class="card__title">${guide.displayName}</h2>
      ${StatusBadge({ status: presentation.status, label: presentation.label })}
    </div>
    <p class="small muted">${guide.purpose}</p>

    ${
      connection.status === 'testing' || connection.status === 'authorising'
        ? Callout({
            tone: 'limit',
            title: 'Not finished yet',
            body: html`<p>
            We have stored what you gave us, and that is not the same as it working. This connection
            only becomes ready once a correctly signed message actually arrives and we can read it.
            Until then we will not claim it is working.
          </p>`,
          })
        : null
    }
    ${connection.problem === null ? null : html`<p class="small">${connection.problem}</p>`}

    ${permissionNotice(guide)}

    ${mine ? formMessage(options.submitted?.message ?? null) : null}
    ${
      options.canSubmitCredentials
        ? null
        : Callout({
            tone: 'warn',
            title: 'We cannot check a credential yet',
            body: html`<p>
            The paste box below renders, but this workspace has no way to validate a credential
            against ${guide.displayName} yet, so submitting one would do nothing. Do not paste a real
            key until this notice is gone.
          </p>`,
          })
    }

    ${credentialForm(guide, options, errors)}

    ${
      guide.provider === 'resend'
        ? Callout({
            tone: 'limit',
            title: 'The webhook address is not published yet',
            body: html`<p>
            Step 3 asks you to point a Resend webhook at an address on this page. That endpoint does
            not exist in this deployment yet, so that step cannot be completed today. The key on its
            own still validates; the connection stays unfinished until a signed callback arrives.
          </p>`,
          })
        : null
    }

    <div class="stack">
      <h3>How to get it</h3>
      ${setupInstructions(guide)}
      ${ButtonRow([
        Button({
          label: `${guide.displayName} documentation`,
          href: guide.docUrl,
          variant: 'quiet',
          external: true,
        }),
      ])}
    </div>

    ${scopeLists(guide)}
  </section>`;
}

export function ConnectPage(options: ConnectPageOptions): Html {
  /*
   * The `length > 0` half is load bearing, not defensive noise. `[].every(...)` is `true`,
   * so an empty connection list read as "everything is ready": it promoted the Continue
   * button to primary and suppressed the callout warning that unfinished connections
   * produce unverified runs. Zero connections is the furthest thing from ready, and this is
   * a product that exists to refuse exactly that inference — absence is never a pass.
   */
  const allReady =
    options.connections.length > 0 &&
    options.connections.every((connection) => connection.status === 'ready');
  return stepShell({
    href: '/app/onboarding/connect',
    eyebrow: 'Step 2 of 7',
    title: 'Connect HubSpot and Resend',
    lede: 'Read what each credential can do before you paste it. Where a provider offers nothing narrower than we need, we say so rather than glossing over it.',
    body: html`<div class="stack-lg">
      ${
        options.connections.length === 0
          ? EmptyState({
              title: 'No providers to connect',
              body:
                'We could not list the providers this workflow needs. That is a fault on our side, not ' +
                'something you have done — nothing about your setup has changed. Try again shortly, and ' +
                'tell us if it keeps happening.',
              actions: [
                Button({ label: 'Contact support', href: '/app/support', variant: 'quiet' }),
              ],
            })
          : options.connections.map((connection) => connectCard(connection, options))
      }
      ${ButtonRow([
        Button({
          label: 'Continue to field mapping',
          href: '/app/onboarding/mapping',
          variant: allReady ? 'primary' : 'default',
        }),
      ])}
      ${
        allReady
          ? null
          : Callout({
              tone: 'limit',
              body: html`<p>
              You can carry on setting up while a connection is unfinished, but runs that need it will
              show as unverified until it is working — not as failures, and never as passes.
            </p>`,
            })
      }
    </div>`,
  });
}

/* --------------------------------------------------------------- 3. map fields */

export interface MappingPageOptions {
  readonly workflow: WorkflowDetail;
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
  readonly value: string;
}

export function MappingPage(options: MappingPageOptions): Html {
  const errors = options.submitted?.fieldErrors ?? {};
  return stepShell({
    href: '/app/onboarding/mapping',
    eyebrow: 'Step 3 of 7',
    title: 'Which property carries your enquiry reference?',
    lede: 'We match a HubSpot record to an enquiry by a value your automation writes onto the record. Tell us which property holds it. If nothing does yet, this is the change you have to make first.',
    body: html`<form method="post" action="/app/onboarding/mapping" class="stack-lg">
      ${CsrfField(options.csrfToken)}
      ${formMessage(options.submitted?.message ?? null)}
      ${Fieldset({
        legend: 'Correlation property',
        hint: 'Every enquiry needs a stable, unique value in this property. If two records share one, we report the run as unverified rather than guessing which record is yours.',
        body: html`${Field({
          name: 'correlationProperty',
          label: 'HubSpot contact property',
          control: 'text',
          value: options.value,
          required: true,
          mono: true,
          maxlength: 128,
          hint: 'Letters, numbers and underscores. Example: verify_correlation_id',
          error: errors['correlationProperty'] ?? null,
        })}
        ${
          options.workflow.mapping.availableProperties.length === 0
            ? null
            : html`<p class="small muted">
              Properties we can currently see on your contacts:
              ${options.workflow.mapping.availableProperties.map(
                (property, index) =>
                  html`${index === 0 ? '' : ', '}<span class="mono">${property}</span>`,
              )}
            </p>`
        }`,
      })}
      ${ButtonRow([
        Button({ label: 'Save and continue', variant: 'primary', type: 'submit' }),
        Button({ label: 'Back to connections', href: '/app/onboarding/connect', variant: 'quiet' }),
      ])}
    </form>`,
  });
}

/* --------------------------------------------------------- 4. expected outcome */

/**
 * Customer-facing labels for the coverage modes.
 *
 * Every mode in the contract gets a label, including the one that cannot be chosen — the
 * unavailable control has to name what is unavailable, and a reader who is told a step
 * exists but is closed is better served than one who never learns it existed.
 */
const COVERAGE_MODE_LABELS: Readonly<Record<CoverageMode, string>> = {
  customer_triggered: 'Your automation tells us',
  independently_sourced: 'We find enquiries ourselves',
};

export interface OutcomePageOptions {
  readonly workflow: WorkflowDetail;
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
  readonly deadlineChoices: readonly number[];
}

export function OutcomePage(options: OutcomePageOptions): Html {
  const errors = options.submitted?.fieldErrors ?? {};
  const outcome = options.workflow.outcome;
  return stepShell({
    href: '/app/onboarding/outcome',
    eyebrow: 'Step 4 of 7',
    title: 'What has to be true for this to count as done?',
    lede: 'These are the checks we will make against evidence we read back ourselves. At least one must be required — with nothing required, a verified result would not mean anything.',
    body: html`<form method="post" action="/app/onboarding/outcome" class="stack-lg">
      ${CsrfField(options.csrfToken)}
      ${formMessage(options.submitted?.message ?? null)}

      ${Fieldset({
        legend: 'Required checks',
        hint: 'Each one is evidenced independently from HubSpot or Resend, never from your automation.',
        body: html`${Checkbox({
          name: 'requireRecordExists',
          label: 'A CRM record was created',
          checked: outcome.requireRecordExists,
          error: errors['requireRecordExists'] ?? null,
        })}
        ${Checkbox({
          name: 'requireCorrelationMatch',
          label: 'The CRM record carries this enquiry reference',
          checked: outcome.requireCorrelationMatch,
        })}
        ${Checkbox({
          name: 'requireEmailDelivered',
          label: 'The acknowledgement email was delivered to the receiving mail server',
          checked: outcome.requireEmailDelivered,
        })}
        ${Checkbox({
          name: 'requireRecipientMatch',
          label: 'The acknowledgement went to the address the enquiry named',
          checked: outcome.requireRecipientMatch,
        })}
        ${Callout({
          tone: 'limit',
          body: html`<p>
            "Delivered" means the receiving mail server took the message. It is a different and stronger
            claim than "accepted by the sending service", and we never merge the two. An email being opened
            is never treated as proof anyone read it.
          </p>`,
        })}`,
      })}

      ${Fieldset({
        legend: 'Completion window',
        hint: `How long your automation may take before a missing result counts against it. Between ${formatDuration(LIMITS.MIN_DEADLINE_SECONDS)} and ${formatDuration(LIMITS.MAX_DEADLINE_SECONDS)}.`,
        body: Field({
          name: 'deadlineSeconds',
          label: 'Allow up to',
          control: 'select',
          value: String(outcome.deadlineSeconds),
          required: true,
          options: options.deadlineChoices.map((seconds) => ({
            value: String(seconds),
            label: formatDuration(seconds),
          })),
          error: errors['deadlineSeconds'] ?? null,
        }),
      })}

      <!--
        Coverage mode.

        This control used to offer "We find enquiries ourselves" (independently_sourced).
        Nothing implements it: no connector can enumerate records it was never told about,
        and no scheduler pass reconciles them — see packages/domain/src/coverage.ts, which
        marks the mode supported:false, selectable:false. A customer who chose it would
        have been told we detect enquiries their automation never reported. We cannot.

        The development story page has publicly claimed since commit 3c94f8d that the mode
        "is marked unsupported as data the onboarding UI reads". It was not: the option list
        was two hard-coded literals. The list now genuinely comes from
        SELECTABLE_COVERAGE_MODES, so an unsupported mode cannot be offered by forgetting
        to remove a line, and the unavailable one is stated with A03's own reason rather
        than vanishing without explanation.
      -->
      ${Fieldset({
        legend: 'Coverage mode',
        hint: 'How we find out an enquiry happened at all. This decides whether we can ever tell you a run never started.',
        body: html`${Field({
          name: 'coverageMode',
          label: 'How we learn about an enquiry',
          control: 'select',
          value: outcome.coverageMode,
          required: true,
          options: SELECTABLE_COVERAGE_MODES.map((mode) => ({
            value: mode,
            label: COVERAGE_MODE_LABELS[mode],
          })),
          hint: 'Your automation tells us. An enquiry your automation never reported is invisible to us.',
          error: errors['coverageMode'] ?? null,
        })}
        ${UnavailableAction({
          label: COVERAGE_MODE_LABELS.independently_sourced,
          reason: COVERAGE_MODE_SUPPORT.independently_sourced.unavailable_reason ?? '',
        })}`,
      })}

      ${ButtonRow([
        Button({ label: 'Save and run a proof', variant: 'primary', type: 'submit' }),
        Button({
          label: 'Back to field mapping',
          href: '/app/onboarding/mapping',
          variant: 'quiet',
        }),
      ])}
    </form>`,
  });
}

/* ------------------------------------------------------------------ 5. proof run */

export interface ProofPageOptions {
  readonly proof: ProofRunView | null;
  readonly csrfToken: string | null;
}

export function ProofPage(options: ProofPageOptions): Html {
  const proof = options.proof;
  return stepShell({
    href: '/app/onboarding/proof',
    eyebrow: 'Step 5 of 7',
    title: 'See a result before you pay for one',
    lede: 'We run your rules against evidence we invent, using the same engine that decides real runs. Nothing is sent to HubSpot or Resend, and no run is counted against your allowance.',
    body: html`<div class="stack-lg">
      <form method="post" action="/app/onboarding/proof">
        ${CsrfField(options.csrfToken)}
        ${Button({ label: proof === null ? 'Run the proof' : 'Run it again', variant: 'primary', type: 'submit' })}
      </form>

      ${
        proof === null
          ? EmptyState({
              title: 'No proof run yet',
              body: 'Run one and you will see exactly what a real result looks like: the verdict, every check, and the reason for each one in plain language.',
            })
          : proof.ran === false || proof.status === null
            ? Callout({
                tone: 'warn',
                title: 'We could not run the proof',
                body: html`<p>${proof.blockedReason ?? 'No reason was recorded, which is itself a defect.'}</p>`,
              })
            : html`<div class="stack">
              ${Card({
                title: 'Proof result',
                headingLevel: 2,
                body: html`<div class="stack">
                  ${RunVerdict({
                    status: proof.status as StatusKey,
                    explanation: explainRunStatus(proof.status),
                    gaps: gapsFrom(proof.results, (result) => explainAssertion(result).sentence),
                  })}
                  ${proof.statusReason === null ? null : html`<p class="small mono">${proof.statusReason}</p>`}
                </div>`,
              })}
              ${Card({
                title: 'Every check',
                headingLevel: 2,
                body: html`<div>
                  ${proof.results.map((result) => {
                    const explanation = explainAssertion(result);
                    return AssertionRow({
                      status: result.status,
                      explanation,
                      origin: 'synthetic evidence',
                      mandatory: result.mandatory,
                      reasonCode: result.reason_code,
                    });
                  })}
                </div>`,
              })}
              ${Callout({
                tone: 'limit',
                title: 'What this proof does not prove',
                body: html`<p>
                  It proves your rules are evaluable and shows you what a result looks like. It says nothing
                  about whether your automation works, because no real record was read.
                </p>`,
              })}
            </div>`
      }

      ${ButtonRow([
        Button({
          label: 'Review scope and price',
          href: '/app/onboarding/review',
          variant: 'primary',
        }),
        Button({ label: 'Change the checks', href: '/app/onboarding/outcome', variant: 'quiet' }),
      ])}
    </div>`,
  });
}

/* --------------------------------------------------------- 6. review and price */

/**
 * The pre-checkout disclosure.
 *
 * The founder's requirement was that the recovery policy is **displayed before checkout,
 * not discovered afterwards**. A06 wrote `preCheckoutPanel()` next to the policy constants
 * it derives from, and until now it had no caller — so the disclosure existed, was tested,
 * and was rendered nowhere. This is the caller.
 *
 * Nothing is retyped here. Not the price, not the allowance, not the number of days. Every
 * string comes from the panel, so changing the policy changes this page and cannot leave a
 * stale promise behind on it.
 *
 * `mustBeVisible` is rendered first, at body size and above every section, and there is no
 * disclosure control anywhere in this block — no `<details>`, nothing collapsed. It carries
 * the price, the allowance, the seven-day window and the fact that cancellation is always
 * available, which is the set of things a customer must not have to go looking for.
 */
function disclosureSection(section: DisclosureSection): Html {
  return html`<section class="disclosure__section" data-disclosure-section="${section.id}">
    <h4>${section.heading}</h4>
    ${
      section.style === 'list'
        ? html`<ul>
          ${section.lines.map((line) => html`<li>${line}</li>`)}
        </ul>`
        : section.lines.map((line) => html`<p>${line}</p>`)
    }
  </section>`;
}

function preCheckoutDisclosure(): Html {
  const panel = preCheckoutPanel();
  return html`<section class="disclosure stack" aria-labelledby="disclosure-heading">
    <h3 id="disclosure-heading">${panel.heading}</h3>
    <p class="disclosure__must" data-must-be-visible>${panel.mustBeVisible}</p>
    <dl class="kv">
      ${panel.facts.map(
        (fact) => html`<dt>${fact.label}</dt>
          <dd>${fact.value}</dd>`,
      )}
    </dl>
    ${panel.sections.map((section) => disclosureSection(section))}
  </section>`;
}

export interface ReviewPageOptions {
  readonly order: OrderSummaryView;
  readonly workflow: WorkflowDetail;
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
}

export function ReviewPage(options: ReviewPageOptions): Html {
  const order = options.order;
  return stepShell({
    href: '/app/onboarding/review',
    eyebrow: 'Step 6 of 7',
    title: 'What you are buying',
    lede: 'The price is resolved on our side, not sent from your browser. Card details never reach us.',
    body: html`<div class="stack-lg">
      ${formMessage(options.submitted?.message ?? null)}

      ${Card({
        title: `${order.planName} — ${order.priceDisplay} ${order.billingPeriod}`,
        headingLevel: 2,
        body: html`<div class="stack">
          ${Table({
            caption: 'What this subscription covers',
            captionHidden: true,
            columns: [
              {
                key: 'k',
                header: 'Item',
                rowHeader: true,
                cell: (row: readonly [string, string]) => row[0],
              },
              {
                key: 'v',
                header: 'Value',
                numeric: true,
                cell: (row: readonly [string, string]) => row[1],
              },
            ],
            rows: [
              ['Workflow', options.workflow.name],
              ['Runs included', `${String(order.runsIncluded)} per month`],
              ['Completion window', formatDuration(options.workflow.deadlineSeconds)],
              ['Coverage mode', options.workflow.coverageMode.replace(/_/g, ' ')],
              ['Correlation property', options.workflow.mapping.correlationProperty],
              ['Evidence retention', `${String(LIMITS.EVIDENCE_RETENTION_DAYS)} days`],
            ] as readonly (readonly [string, string])[],
          })}
        </div>`,
      })}

      ${
        order.blockers.length === 0
          ? null
          : Callout({
              tone: 'warn',
              title: 'Fix these before you subscribe',
              body: html`<ul>
              ${order.blockers.map((blocker) => html`<li>${blocker}</li>`)}
            </ul>`,
            })
      }

      ${preCheckoutDisclosure()}

      ${
        order.paymentsMode === 'live'
          ? null
          : Callout({
              tone: 'note',
              title: 'Payments are in Stripe’s sandbox right now',
              body: html`<p>
                Continuing hands you to a Stripe test checkout, which will say so at the top of its own
                page. No card is charged and no money moves. We are deliberately not taking live payment
                until the owner approves it, so this path exists to be exercised end to end rather than
                to sell you anything today.
              </p>`,
            })
      }

      <!-- The control exists exactly when createCheckout would succeed, and is absent
           otherwise. It used to be absent unconditionally, behind a comment explaining that
           a disabled button is still a button -- a good argument for not using a disabled
           attribute, and no argument at all for hard-coding the answer. The condition is
           order.ready, the same value createCheckout refuses on, so this page cannot offer
           a purchase the server would decline. The blockers are what make it false, so the
           blockers are the reason shown. (No backticks in this comment: it sits inside a
           template literal, and one closed it.) -->
      ${
        order.ready
          ? html`<form method="post" action="/app/onboarding/checkout" class="stack-sm">
              ${CsrfField(options.csrfToken)}
              ${Button({
                label: 'Continue to secure checkout',
                variant: 'primary',
                type: 'submit',
              })}
            </form>`
          : UnavailableAction({
              label: 'Continue to secure checkout',
              reason:
                order.blockers[0] ??
                'Something above is not finished yet, so there is nothing to buy.',
              whenBack: 'The button appears here as soon as it is.',
            })
      }
      ${ButtonRow([Button({ label: 'Back to the proof run', href: '/app/onboarding/proof', variant: 'quiet' })])}

      ${Callout({
        tone: 'note',
        title: 'What happens at checkout',
        body: html`<p>
          You are handed to Stripe's own hosted checkout page. We never see or store a card number. You can
          cancel at any time from the billing portal; cancelling stops the next renewal and you keep access
          for the rest of the period you have paid for.
        </p>`,
      })}
    </div>`,
  });
}
/* ------------------------------------------------------------------ 7. activation */

export interface ActivationPageOptions {
  readonly csrfToken: string | null;
  /** The outcome of the issue/rotate POST this response answers. Null on a plain GET. */
  readonly issued: SigningKeyIssueResult | null;
}

const ISSUE_SIGNING_KEY_PATH = '/app/onboarding/activation/signing-key';

/**
 * The one-time secret display.
 *
 * Rendered only on the response to the POST that derived it. The secret is never stored,
 * so no later GET can show it, and the page says so in the words a customer reads before
 * closing the tab. The two `data-` hooks are what the integration test asserts on; they
 * appear nowhere else in the product, which is itself the property being tested.
 */
function issuedKeyPanel(issued: Extract<SigningKeyIssueResult, { outcome: 'issued' }>): Html {
  return Callout({
    tone: 'warn',
    title: issued.rotated
      ? 'Your signing key was rotated. Copy the new secret now.'
      : 'Your signing key was issued. Copy the secret now.',
    body: html`<div class="stack-sm">
      <p>
        <strong>This secret will not be shown again.</strong> We keep only a reference and a hash, so we
        cannot recover it for you. If you lose it, rotate: a new key is issued and this one stops being
        accepted immediately.
      </p>
      <dl class="kv">
        <dt>Key id</dt>
        <dd><code data-signing-key-id>${issued.keyId}</code></dd>
        <dt>Secret</dt>
        <dd><code data-signing-secret>${issued.secret}</code></dd>
      </dl>
      ${
        issued.rotated
          ? html`<p>The previous key is no longer accepted. Update your automation before its next event.</p>`
          : null
      }
    </div>`,
  });
}

function signingKeyOutcome(issued: SigningKeyIssueResult | null): Html | null {
  if (issued === null) return null;
  if (issued.outcome === 'issued') return issuedKeyPanel(issued);
  if (issued.outcome === 'unconfigured') {
    return Callout({
      tone: 'warn',
      title: 'Signing keys cannot be issued on this deployment',
      body: html`<p role="alert">${issued.message}</p>`,
    });
  }
  return formMessage(issued.message);
}

/**
 * The control. A real form posting to a real route when the key can be issued; an explicitly
 * inert element saying why when it cannot — never a disabled button, which is still a button.
 */
function signingKeyControl(activation: ActivationView, csrfToken: string | null): Html {
  const hasKey = activation.signingKeyId !== null;
  const label = hasKey ? 'Rotate signing key' : 'Issue signing key';
  if (!activation.signingKeyIssuance.canIssue) {
    return UnavailableAction({
      label,
      reason: activation.signingKeyIssuance.cannotIssueReason ?? 'Not available right now.',
    });
  }
  return html`<form method="post" action="${ISSUE_SIGNING_KEY_PATH}" class="stack-sm">
    ${CsrfField(csrfToken)}
    <p class="small muted">
      ${
        hasKey
          ? 'Rotating issues a new key and stops accepting the old one immediately. Have your automation ready to take the new secret.'
          : 'The secret is shown once, on the next page, and never again.'
      }
    </p>
    ${ButtonRow([
      Button({
        label,
        variant: hasKey ? 'danger' : 'primary',
        type: 'submit',
        name: 'intent',
        value: hasKey ? 'rotate' : 'issue',
      }),
    ])}
  </form>`;
}

export function ActivationPage(
  activation: ActivationView,
  options: ActivationPageOptions = { csrfToken: null, issued: null },
): Html {
  return stepShell({
    href: '/app/onboarding/activation',
    eyebrow: 'Step 7 of 7',
    title: activation.active ? 'You are set up' : 'Not active yet',
    lede: activation.active
      ? 'Send your first signed event and the first run will appear here.'
      : 'The subscription is not active, so we are not accepting events for this workflow yet.',
    body: html`<div class="stack-lg">
      ${signingKeyOutcome(options.issued)}

      ${
        activation.active
          ? null
          : Callout({
              tone: 'warn',
              title: 'No active subscription',
              body: html`<p>
              We are not accepting events for this workflow. Nothing is being checked, and nothing here should
              be read as a pass.
            </p>`,
            })
      }

      ${Card({
        title: 'What your automation has to send',
        headingLevel: 2,
        body: html`<div class="stack-sm">
          <dl class="kv">
            <dt>Endpoint</dt>
            <dd>${activation.eventEndpoint}</dd>
            <dt>Workflow id</dt>
            <dd>${activation.workflowId}</dd>
            <dt>Key id</dt>
            <dd>${activation.signingKeyId ?? 'not issued yet'}</dd>
            <dt>Key fingerprint</dt>
            <dd>${activation.signingKeyHint ?? 'not issued yet'}</dd>
          </dl>
          <p class="small muted">
            Send the key id in <code>X-Verify-Key-Id</code> and the signature in
            <code>X-Verify-Signature</code> as <code>t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code>, where the
            hex is HMAC-SHA-256 over <code>t.body</code> under your secret.
          </p>
          <p class="small muted">
            The signing key proves the event came from you. It does not make the event true — we still go and
            read the evidence ourselves.
          </p>
          <p class="small muted">
            Include <code>expected.email_message_id</code> — the id your sending provider returned when it sent
            the acknowledgement. It is what ties a delivery event to <em>this</em> enquiry. Without it we cannot
            tell which enquiry a delivery belongs to, because two enquiries from the same customer share an
            email address, so the email checks stay unknown and the run finishes as
            <strong>unverified</strong> rather than verified. That is the honest answer, not a fault — but it is
            avoidable, and it is the one field worth going back to your automation for.
          </p>
        </div>`,
      })}

      ${Card({
        title: activation.signingKeyId === null ? 'Your signing key' : 'Rotate your signing key',
        headingLevel: 2,
        body: signingKeyControl(activation, options.csrfToken),
      })}

      ${
        activation.firstRunId === null
          ? EmptyState({
              title: 'No runs received yet',
              body: 'Nothing has reached us for this workflow. Until an enquiry arrives there is nothing to verify, and an empty list is not a passing score.',
            })
          : ButtonRow([
              Button({
                label: 'See your first run',
                href: `/app/runs/${activation.firstRunId}`,
                variant: 'primary',
              }),
              Button({ label: 'Go to the workspace', href: '/app', variant: 'quiet' }),
            ])
      }
    </div>`,
  });
}
