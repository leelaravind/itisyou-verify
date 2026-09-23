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
  Disclosure,
  Callout,
  CsrfField,
  Field,
  Fieldset,
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
import {
  connectionPresentation,
  formMessage,
  pageHead,
  runCountCards,
  runTally,
  runTotal,
} from './chrome.js';
import { formatDuration, formatInstant } from '../public/shared.js';
import type {
  ConnectionView,
  RunCountsView,
  RunListItem,
  TestVerificationOffer,
  TestVerificationResult,
  UsageView,
  WorkflowDetail,
} from './port.js';

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
  /** What a test verification would cost, and whether one can be started at all. */
  readonly testOffer: TestVerificationOffer;
  readonly csrfToken: string | null;
  /** The outcome of a submitted test form, when this render came from one. */
  readonly testSubmitted?: TestVerificationResult | null;
  /**
   * Identity of THIS form, minted per render and carried in a hidden field.
   *
   * Two presses of one rendered form are one submission and must cost one run. A newly
   * loaded form is a new submission and costs another, which the page says before the
   * button. Passed in rather than generated here so the page stays a pure function of its
   * options and a test can render it twice and get the same bytes.
   */
  readonly submissionId: string;
  /** True when the reader pressed "Run verification" and expects the form already open. */
  readonly openVerifyForm?: boolean;
  /** Which runs the four verdict cards count. Defaults to the automation's own. */
  readonly verdictScope?: VerdictScope;
  /** Field errors from an admission-control submission, when this render came from one. */
  readonly admissionErrors?: Readonly<Record<string, string>>;
  /** The outcome of an admission-control submission, shown above the panel. */
  readonly admissionNotice?: { readonly message: string; readonly ok: boolean };
}

/**
 * Run a test verification: the guided form, and what it costs, stated before it starts.
 *
 * ## Why the cost is above the form rather than under it
 *
 * It spends one run from the monthly allowance, because it is admitted through the same
 * path a real enquiry takes. A customer should know that before they fill four fields in,
 * not after pressing the button, so the count sits above the inputs with the number
 * remaining.
 *
 * ## What the copy must keep saying
 *
 * Three things, and none is decoration:
 *
 *  - every field names something that ALREADY EXISTS. We create no CRM record and send no
 *    email, and the connectors have no write path to do either with.
 *  - the result is whatever the evidence says. A test can come back FAILED or UNVERIFIED
 *    and that is the feature working, not the feature breaking.
 *  - passing proves the rules and the providers. It proves NOTHING about whether the
 *    customer's automation reports enquiries to us, because this event came from this
 *    form. That is the one inference somebody would most like to draw from a green tick,
 *    so it is refused in the same breath.
 */
function testVerification(options: WorkspacePageOptions): Html {
  const offer = options.testOffer;
  const submitted = options.testSubmitted ?? null;
  const errors = submitted?.fieldErrors ?? {};
  return html`<section class="stack" id="run-verification" aria-labelledby="test-verification-heading" data-test-verification>
    <div class="section-head">
      <div class="section-head__text">
        <p class="eyebrow">Check it end to end</p>
        <h2 id="test-verification-heading">Run a test verification</h2>
      </div>
      <p class="small muted">
        One enquiry you describe, checked by the same engine and the same provider reads that decide a
        real one.
      </p>
    </div>

    ${submitted === null || submitted.ok ? null : formMessage(submitted.message, 'warn')}

    ${Callout({
      tone: 'limit',
      title: offer.consumesAllowance
        ? `This uses one of your ${String(offer.runsIncluded)} runs, and ${String(offer.runsRemaining)} remain`
        : 'This does not use your allowance',
      body: html`<p>
        It is admitted exactly like an enquiry from your automation, so it costs the same: one run. We
        did not build a free side door, because a result from a different path would tell you nothing
        about the path your automation actually uses.
      </p>`,
    })}

    ${
      !offer.canStart
        ? UnavailableAction({
            label: 'Run a test verification',
            reason: offer.reason ?? 'A test verification cannot be started right now.',
          })
        : /*
           * The four fields sit behind a disclosure, closed until somebody wants them.
           *
           * This is an occasional action on a page whose job is to answer "is my automation
           * working". Open, the form and its hints ran about 500 pixels and pushed the
           * verification rate, the activity warning and the recent runs below the fold on a
           * laptop: the page answered its own question last. Closed, it is one line, and the
           * answers are the first thing a reader meets.
           *
           * What does NOT go inside it: the allowance cost above and the refusal of the
           * inference below. A limitation behind a disclosure is a limitation somebody can
           * say they never saw, and the owner's requirement is that the cost is stated
           * BEFORE the test is started. It reopens itself when a submission came back with
           * errors, because the reader has to see what they typed.
           */
          Disclosure({
            open: options.openVerifyForm || (submitted !== null && !submitted.ok),
            summary: 'Describe the enquiry to check',
            body: html`<form method="post" action="/app/test-verification" class="stack" data-verify-form>
            ${CsrfField(options.csrfToken)}
            <input type="hidden" name="submissionId" ${attrs({ value: options.submissionId })} />
            ${Fieldset({
              legend: 'The enquiry to check',
              hint: 'Every value names something that already exists. We create nothing and send nothing.',
              body: html`${Field({
                name: 'crmRecordId',
                label: 'An existing CRM record id',
                hint: 'A contact already in HubSpot. We read it; we never create or edit one.',
                required: true,
                error: errors['crmRecordId'] ?? null,
              })}
              ${Field({
                name: 'correlationValue',
                label: `The value in ${offer.correlationProperty}`,
                hint: 'What that record carries in your correlation property. This is how we match the record back to the enquiry.',
                required: true,
                error: errors['correlationValue'] ?? null,
              })}
              ${Field({
                name: 'messageId',
                label: 'An existing message id',
                hint: 'The provider id of an acknowledgement that was already sent. We read its delivery events; we never send mail.',
                required: true,
                error: errors['messageId'] ?? null,
              })}
              ${Field({
                name: 'expectedRecipient',
                label: 'The address it should have reached',
                control: 'email',
                hint: 'Checked after we bind the message, so the right message delivered to the wrong address is a contradiction rather than a miss.',
                required: true,
                error: errors['expectedRecipient'] ?? null,
              })}`,
            })}
            ${ButtonRow([
              Button({ label: 'Run a test verification', variant: 'primary', type: 'submit' }),
            ])}
          </form>`,
          })
    }

    ${Callout({
      tone: 'limit',
      title: 'What a pass here would and would not prove',
      body: html`<p>
        A pass proves your rules are right and that we can read your providers. It proves nothing about
        whether your automation reports its enquiries to us, because this one came from the form above
        rather than from your automation. It can also come back failed or unverified: that is the check
        working, not the check breaking.
      </p>`,
    })}
  </section>`;
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

/** Which runs the four verdict cards are counting. */
export type VerdictScope = 'automation' | 'tests' | 'all';

const SCOPE_HEADING: Readonly<Record<VerdictScope, string>> = {
  automation: 'Results from your automation',
  tests: 'Results from your own test verifications',
  all: 'Results from everything, tests included',
};

function addCounts(a: RunCountsView, b: RunCountsView): RunCountsView {
  return {
    verified: a.verified + b.verified,
    failed: a.failed + b.failed,
    unverified: a.unverified + b.unverified,
    pending: a.pending + b.pending,
  };
}

function countsFor(workflow: WorkflowDetail, scope: VerdictScope): RunCountsView {
  if (scope === 'tests') return workflow.testCounts;
  if (scope === 'all') return addCounts(workflow.counts, workflow.testCounts);
  return workflow.counts;
}

function scopeSelector(active: VerdictScope): Html {
  const link = (value: VerdictScope, label: string): Html => {
    const href = value === 'automation' ? '/app' : `/app?scope=${value}`;
    return value === active
      ? html`<span ${attrs({ class: 'chip chip--on', 'aria-current': 'true' })}>${label}</span>`
      : html`<a ${attrs({ class: 'chip', href: safeHref(href) })}>${label}</a>`;
  };
  return html`<nav ${attrs({ class: 'cluster', 'aria-label': 'Which runs these results count' })}>
    ${link('automation', 'Automation')} ${link('tests', 'Tests')} ${link('all', 'All')}
  </nav>`;
}

/**
 * One sentence reconciling the cards above against the runs underneath them.
 *
 * Built only from counts that were actually queried. A zero stays a zero and is explained;
 * it is never dressed up as activity.
 */
function scopeReconciliation(workflow: WorkflowDetail, scope: VerdictScope): string {
  const automation = runTotal(workflow.counts);
  const tests = runTotal(workflow.testCounts);
  const testPart =
    tests === 0
      ? 'no test verifications run'
      : `${String(tests)} test ${tests === 1 ? 'run' : 'runs'} completed`;
  if (scope === 'tests') {
    return `Counting only verifications you started. ${String(automation)} ${automation === 1 ? 'run' : 'runs'} arrived from your automation and ${automation === 0 ? 'are' : 'are'} counted under Automation. Every run here was charged to your allowance.`;
  }
  if (scope === 'all') {
    return `Counting both: ${String(automation)} from your automation and ${String(tests)} you started. This is the number your allowance was charged for.`;
  }
  return automation === 0
    ? `No automation events received; ${testPart}. Test runs are charged to your allowance but left out of these four, so testing cannot change your verification rate.`
    : `${String(automation)} ${automation === 1 ? 'run' : 'runs'} from your automation; ${testPart}, counted separately.`;
}

/**
 * Automatic verification: what is arriving, what is being checked, and the two controls.
 *
 * Three states, kept apart because they need different actions from the reader. `paused` is
 * a choice they made and undo in a click. `awaiting_setup` means we have never heard from
 * their automation, so the answer is a setup guide rather than a switch. `receiving` means
 * events are arriving. A single "not working" would collapse all three.
 *
 * The last event shown here is the last event their AUTOMATION sent. A test verification the
 * customer ran themselves is not evidence their integration is alive, and showing one here
 * would answer the page's own question wrongly.
 */
function automationPanel(options: WorkspacePageOptions, workflow: WorkflowDetail): Html {
  const admission = workflow.admission;
  const outcome = workflow.outcome;
  const checks: string[] = [];
  if (outcome.requireRecordExists) checks.push('a CRM record exists');
  if (outcome.requireCorrelationMatch) checks.push('it carries this enquiry reference');
  if (outcome.requireEmailDelivered) checks.push('the acknowledgement was delivered');
  if (outcome.requireRecipientMatch) checks.push('it went to the address the enquiry named');

  const coverage =
    checks.length === 0
      ? 'No checks are required yet, so a verified result would not mean anything.'
      : `Checking ${String(checks.length)} of 4: ${checks.join('; ')}.`;
  const half =
    (outcome.requireEmailDelivered || outcome.requireRecipientMatch) &&
    (outcome.requireRecordExists || outcome.requireCorrelationMatch);

  const statusLine =
    admission.status === 'paused'
      ? 'Paused by you. New events from your automation are refused without being charged.'
      : admission.status === 'awaiting_setup'
        ? 'Awaiting setup. We have never received an event from your automation.'
        : 'Receiving events from your automation.';

  const canWrite = options.canStartSetup && options.csrfToken !== null;

  return html`<section class="stack-sm" aria-labelledby="automation-heading" data-automation-panel>
    <div class="section-head">
      <div class="section-head__text"><h2 id="automation-heading">Automatic verification</h2></div>
      ${StatusBadge(
        admission.status === 'receiving'
          ? { status: 'VERIFIED', label: 'Receiving' }
          : admission.status === 'paused'
            ? { status: 'UNVERIFIED', label: 'Paused' }
            : { status: 'PENDING', label: 'Awaiting setup' },
      )}
    </div>
    <p class="small">${statusLine}</p>
    <dl class="metrics" aria-label="Automatic verification">
      <div>
        <dt>Last automation event</dt>
        <dd data-last-automation-event>
          ${
            workflow.lastEventAt === null
              ? html`<span class="small muted">None received</span>`
              : formatInstant(workflow.lastEventAt)
          }
        </dd>
      </div>
      <div>
        <dt>Active checks</dt>
        <dd data-active-checks>${String(checks.length)} of 4</dd>
      </div>
      <div>
        <dt>Admitted this period</dt>
        <dd>
          ${String(admission.admittedThisPeriod)}${
            admission.limitPerPeriod === null
              ? ''
              : ` of your ${String(admission.limitPerPeriod)} limit`
          }
        </dd>
      </div>
    </dl>
    <p class="small">${coverage}</p>
    ${
      half
        ? null
        : Callout({
            tone: 'note',
            title: 'This workflow checks one side only',
            body: html`<p>
              Only the ${outcome.requireRecordExists || outcome.requireCorrelationMatch ? 'CRM' : 'email'}
              side is required, so a verified result says nothing about the other one. Change the required
              checks if you meant to cover both.
            </p>`,
          })
    }
    ${
      workflow.lastEventAt === null
        ? Callout({
            tone: 'note',
            title: 'Your automation has not sent us anything yet',
            body: html`<p>
              Until it does there is nothing to verify automatically, and no result here should be read as a
              pass. The activation step has the signing key and the endpoint your automation posts to.
              <a href="/app/onboarding/activation">Finish setting up your automation</a>.
            </p>`,
          })
        : null
    }
    ${
      canWrite
        ? html`<div class="cluster">
          <form method="post" action="/app/admissions" class="stack-sm">
            ${CsrfField(options.csrfToken)}
            <input type="hidden" name="paused" ${attrs({ value: admission.status === 'paused' ? '0' : '1' })} />
            ${Button({
              label: admission.status === 'paused' ? 'Resume verifications' : 'Pause new verifications',
              variant: admission.status === 'paused' ? 'primary' : 'default',
              type: 'submit',
            })}
          </form>
          <form method="post" action="/app/admission-limit" class="stack-sm">
            ${CsrfField(options.csrfToken)}
            ${Field({
              name: 'admissionLimit',
              label: 'Limit for this period',
              hint: 'A safety catch below your plan, so a faulty automation cannot drain it. Leave empty for no limit.',
              value: admission.limitPerPeriod === null ? '' : String(admission.limitPerPeriod),
              error: options.admissionErrors?.['admissionLimit'] ?? null,
            })}
            ${Button({ label: 'Save limit', type: 'submit' })}
          </form>
        </div>`
        : null
    }
    ${
      admission.status === 'paused'
        ? Callout({
            tone: 'note',
            title: 'What happens while you are paused',
            body: html`<p>
              Runs already under way keep going and still reach a verdict — pausing does not cancel work you
              have already paid for. New events your automation sends are refused with a "not now" your
              integration can retry, and nothing is written or charged for them, so it can send the same
              events again when you resume and they will be accepted then.
            </p>`,
          })
        : null
    }
  </section>`;
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

  const scope: VerdictScope = options.verdictScope ?? 'automation';
  const shownCounts = countsFor(workflow, scope);
  const scopeNoun =
    scope === 'all' ? '' : scope === 'tests' ? ' · your tests' : ' · from your automation';
  const shownSummary = `${String(options.recentRuns.length)} of ${String(runTotal(shownCounts))} shown${scopeNoun}`;

  return html`<div class="wrap section stack-lg">
    <div class="section-head">
      ${pageHead({
        eyebrow: 'Workspace',
        title: workflow.name,
        /*
         * The primary action, beside the heading, where a reader looks for it.
         *
         * "Run verification" and not "Run automation": this starts OUR checks against
         * evidence we read back. It does not trigger the customer's own workflow, and a
         * label implying it did would be the single most misleading word on the page.
         *
         * It is a link to the same page with the form open rather than a second form, so
         * there is exactly one submission path and exactly one submission identity.
         */
        action: options.testOffer.canStart
          ? Button({
              label: 'Run verification',
              variant: 'primary',
              href: '/app?verify=1#run-verification',
            })
          : null,
      })}
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

    ${
      options.admissionNotice === undefined
        ? null
        : formMessage(options.admissionNotice.message, options.admissionNotice.ok ? 'note' : 'warn')
    }
    <!--
      The counters, and what they count.
      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      These four excluded test runs from the day they were written, which is right: a run
      the customer built by hand must not raise their own pass rate. Nothing on the page
      SAID so, so a workspace reading "7 of 500 used" beside four zeroes looked broken. The
      heading now names the scope, the line beneath reconciles it against real counts, and
      the selector lets a reader see the other scope rather than deduce it.
    -->
    <section class="stack-sm" aria-labelledby="verdicts-heading" data-verdict-scope="${scope}">
      <div class="section-head">
        <div class="section-head__text">
          <h2 id="verdicts-heading">${SCOPE_HEADING[scope]}</h2>
        </div>
        ${scopeSelector(scope)}
      </div>
      ${runCountCards(shownCounts)}
      <p class="small">${scopeReconciliation(workflow, scope)}</p>
    </section>

    <section class="stack-sm" aria-labelledby="period-heading">
      <div class="section-head">
        <div class="section-head__text"><h2 id="period-heading">This period</h2></div>
        <div class="cluster">
          <a href="/app/usage">Usage detail</a>
        </div>
      </div>
      <dl class="metrics" aria-label="This period">
        <div>
          <dt>Runs used</dt>
          <dd>${String(options.usage.runsUsed)} of ${String(options.usage.runsIncluded)} (${String(usedPercent)}%)</dd>
        </div>
        <!--
          The two halves of "used", kept apart. Both are subtracted from the allowance
          identically, so the sum above is right; it is still not the thing a customer asks
          about when a figure surprises them, which is how much of this is still happening.
        -->
        <div>
          <dt>Settled</dt>
          <dd data-allowance="consumed">${String(options.usage.consumed)}</dd>
        </div>
        <div>
          <dt>In flight</dt>
          <dd data-allowance="reserved">${String(options.usage.reserved)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd data-allowance="remaining">${String(options.usage.runsRemaining)}</dd>
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
      <!-- When these figures were read, and how to read them again. A page left open is
           a page whose numbers have moved; saying WHEN is the difference between a stale
           figure and a wrong one. Reload rather than poll: nothing here changes fast
           enough to justify a request every few seconds on somebody else's account. -->
      <p class="small">
        Figures read ${formatInstant(options.usage.readAt)}.
        <a href="/app">Refresh</a>
      </p>
    </section>

    <!-- The next useful action, above the figures.
         A workspace whose numbers are all zero gives a customer nothing to do. This is
         the one action that turns an empty dashboard into an answer, so it sits before
         the readouts rather than at the bottom of the page. -->
    ${testVerification(options)}

    <div class="health">
      ${Card({ title: 'Verification rate', headingLevel: 2, body: HealthReadout(health) })}
      ${Card({ title: 'Are enquiries still arriving?', headingLevel: 2, body: InactivityNotice(inactivity) })}
    </div>

    <!--
      Results left and wider; connection health right and narrower.
      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
      Results come FIRST in source order, so the single-column stack on a phone puts them
      above connections with no CSS reordering -- a visual order that disagrees with the
      reading order is a trap for anyone using a screen reader or tabbing through.
    -->
    <div class="split">
      <div class="split__main stack-lg">
    <section class="stack-sm" aria-labelledby="recent-runs-heading">
      <div class="section-head">
        <div class="section-head__text"><h2 id="recent-runs-heading">Recent runs</h2></div>
        <a href="/app/runs">View all runs</a>
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
              key: 'ref',
              header: 'Enquiry reference',
              rowHeader: true,
              cell: (run: RunListItem) =>
                html`<a ${attrs({ class: 'mono', href: safeHref(`/app/runs/${encodeURIComponent(run.id)}`) })}
                  >${run.correlationId === '' ? run.id : run.correlationId}</a
                >${
                  // The same mark the runs list carries. A test the customer ran themselves
                  // must not read as their automation's record, on any surface that shows it.
                  run.isTest
                    ? html` <span ${attrs({ class: 'chip chip--test', title: 'You started this one from your workspace. It cost a run and is left out of your automation figures.' })}>TEST</span>`
                    : null
                }`,
            },
            {
              key: 'occurred',
              header: 'Received',
              numeric: true,
              cell: (run: RunListItem) => formatInstant(run.occurredAt),
            },
            {
              // "Checks", not "Required checks": this table now lives in the narrower of two
              // columns, and the longer header was the one thing pushing it wide enough to
              // need sideways scrolling to read its last value.
              key: 'checks',
              header: 'Checks',
              numeric: true,
              cell: (run: RunListItem) => `${run.mandatorySupported}/${run.mandatoryTotal}`,
            },
          ],
          rows: options.recentRuns,
        })}
        <div class="results__bar">
          <!--
            The tally, the total and the rows all read the SAME scope.
            ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
            This line read "5 of 3 runs shown": the rows included the customer's own test
            verifications while the total counted only their automation, so the panel
            contradicted itself in four characters. Both now come from the SELECTED scope --
            Automation, Tests or All -- and the rows are fetched under that same filter.
            (No backticks in this comment: it sits inside a template literal.)
          -->
          ${runTally(shownCounts)}
          <p class="micro mono">${shownSummary}</p>
        </div>
      </div>
    </section>
      </div>
      <aside class="split__side stack" aria-label="Connections and automation">
        ${Card({
          title: 'Connection health',
          headingLevel: 2,
          aside: html`<a href="/app/connections">Manage connections</a>`,
          body: html`<div class="stack">
            ${options.connections.map((connection) => connectionRow(connection))}
            ${ButtonRow([
              Button({ label: 'Test connection', href: '/app/connections', variant: 'quiet' }),
            ])}
          </div>`,
        })}
        ${automationPanel(options, workflow)}
        ${Card({ title: 'Coverage', headingLevel: 2, body: CoverageNotice(coverage) })}
      </aside>
    </div>

    ${StandingLimitations()}
  </div>`;
}
