/**
 * Transactional email templates.
 *
 * Rules every message in this file keeps:
 *
 *  - **Plain text first.** The text body is written to be read as text; the HTML body is
 *    a faithful rendering of the same words, never a richer version with extra claims.
 *    If the two ever disagree, the text body is the one that is true.
 *  - **British English, short, no marketing tone.** Nobody asked to receive an email.
 *  - **A stated reason.** Every message ends with one sentence saying why this person is
 *    receiving it. A transactional email with no stated reason is indistinguishable from
 *    spam, and rightly filtered as such.
 *  - **Never claim delivery.** Where a message talks about email outcomes it uses
 *    "accepted by the sending service", which is the only thing we can observe. See
 *    `send.ts` for the same rule applied to our own sending.
 *  - **Customer-facing claims come from A01's content constants** (`@verify/ui`) wherever
 *    A01 wrote them. Wording A01 did not write is marked `NEW WORDING (A09)` in a comment
 *    so A01's claims map stays accurate.
 *
 * No template takes raw HTML. Every interpolated value is escaped on the HTML side and
 * inserted literally on the text side.
 */
import { LIMITS } from '@verify/contracts';
import { PLAN_AT_ALLOWANCE, PRODUCT_NAME } from '@verify/ui';
// A06 owns the number. Importing it is what stops this file stating a window length that
// has drifted from the approved policy.
import { PAYMENT_FAILURE_GRACE_DAYS } from '../billing/config';

/** Every template this product can send. Adding a case here is a deliberate act. */
export const NOTIFICATION_TEMPLATE = [
  'sign_in_link',
  'welcome',
  'first_material_failure',
  'recovery',
  'provider_disconnected',
  'allowance_approaching',
  'allowance_reached',
  'payment_problem',
  'cancellation_confirmed',
  'data_export_ready',
  'deletion_scheduled',
  'deletion_completed',
] as const;
export type NotificationTemplate = (typeof NOTIFICATION_TEMPLATE)[number];

export interface RenderedNotification {
  readonly template: NotificationTemplate;
  readonly subject: string;
  /** The canonical body. Plain text, hard-wrapped by the reader, not by us. */
  readonly text: string;
  /** The same words as `text`, marked up. Never a claim `text` does not make. */
  readonly html: string;
  /** The "why you are receiving this" sentence, also appended to both bodies. */
  readonly reason: string;
}

/* -------------------------------------------------------------------------- */
/* variables                                                                  */
/* -------------------------------------------------------------------------- */

export interface TemplateVariablesByTemplate {
  sign_in_link: {
    readonly signInUrl: string;
    readonly expiresInMinutes: number;
  };
  welcome: { readonly workspaceName: string; readonly setupUrl: string };
  first_material_failure: {
    readonly workspaceName: string;
    readonly workflowName: string;
    readonly runUrl: string;
    /** One honest sentence, normally from `@verify/domain`'s `explainRun`. */
    readonly reasonSentence: string;
  };
  recovery: {
    readonly workspaceName: string;
    readonly workflowName: string;
    readonly resultsUrl: string;
    readonly interruptionStartedAt: string;
  };
  provider_disconnected: {
    readonly workspaceName: string;
    readonly provider: string;
    readonly reconnectUrl: string;
    /** The specific connector reason, e.g. "the authorisation expired". */
    readonly reasonSentence: string;
  };
  allowance_approaching: {
    readonly workspaceName: string;
    readonly runsUsed: number;
    readonly periodEndsAt: string;
  };
  allowance_reached: {
    readonly workspaceName: string;
    readonly periodEndsAt: string;
  };
  payment_problem: {
    readonly workspaceName: string;
    readonly billingPortalUrl: string;
    /**
     * A06's situation sentence: Stripe's own reason, passed through without
     * embellishment, followed by `recoveryStatement(window)`. It says which phase of the
     * recovery window this workspace is in. The paragraphs around it state the policy and
     * must not restate the phase, so the two read as one voice.
     */
    readonly reasonSentence: string;
    /**
     * Whole days left in the recovery window, from A06's `paymentRecoveryWindow()`.
     *
     * Optional so that a caller which does not yet compute it cannot be broken, and so a
     * missing address or a missing window can never stop a suspension happening
     * correctly. When it is absent the message states the window length instead of a
     * countdown — always true, never a number that can drift.
     */
    readonly daysRemaining?: number;
    /**
     * The approved window length. Pass A06's `PAYMENT_RECOVERY_DAYS`; never a literal.
     * Defaults to `PAYMENT_FAILURE_GRACE_DAYS`, which is the one place the number lives.
     */
    readonly graceDays?: number;
  };
  cancellation_confirmed: {
    readonly workspaceName: string;
    /**
     * When access actually ends. For `period_end` this is the end of the period already
     * paid for; for `immediately` it is now.
     */
    readonly accessEndsAt: string;
    /**
     * A06 supports a support-led `immediately` cancellation as well as the default
     * `period_end`. The message must not promise a paid-for period to someone whose
     * access has already stopped, so the timing is a required variable rather than an
     * assumption.
     */
    readonly timing: 'period_end' | 'immediately';
  };
  data_export_ready: {
    readonly workspaceName: string;
    readonly downloadUrl: string;
    readonly expiresAt: string;
  };
  deletion_scheduled: {
    readonly workspaceName: string;
    readonly deletionAt: string;
    readonly cancelUrl: string;
  };
  deletion_completed: {
    readonly workspaceName: string;
    /** From `privacy/deletion.ts` — what is still held, and why. */
    readonly retainedStatement: string;
  };
}

export type TemplateVariables<T extends NotificationTemplate> = TemplateVariablesByTemplate[T];

/* -------------------------------------------------------------------------- */
/* escaping                                                                   */
/* -------------------------------------------------------------------------- */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape text for an HTML body. Local on purpose: A05 owns `@verify/ui`'s renderer and
 * an email body must not depend on a file that is being reshaped for the web UI.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

const SAFE_LINK = /^https:\/\/[^\s"'<>]+$/;

/**
 * Only an absolute `https` URL may become a link. Anything else is rendered as inert
 * text, so a malformed or hostile value cannot produce a `javascript:` anchor in an
 * email client that still honours one.
 */
function link(url: string, label?: string): string {
  const text = escapeHtml(label ?? url);
  if (!SAFE_LINK.test(url)) return text;
  return `<a href="${escapeHtml(url)}">${text}</a>`;
}

function paragraphsToHtml(paragraphs: readonly string[]): string {
  return paragraphs.map((p) => `<p>${p}</p>`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* the shared footer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * NEW WORDING (A09): A01 wrote no transactional email copy, so every sentence below that
 * is not read from a `@verify/ui` constant is mine. Flagged in the handoff.
 */
const SUPPORT_LINE =
  'If you did not expect this, or anything here looks wrong, reply to this message and a person will read it.';

interface Body {
  readonly subject: string;
  readonly paragraphs: readonly string[];
  /** The stated reason for receipt. One sentence, no marketing. */
  readonly reason: string;
  /** Optional call to action rendered as a link on the HTML side. */
  readonly action?: { readonly url: string; readonly label: string };
}

function assemble(template: NotificationTemplate, body: Body): RenderedNotification {
  const textParagraphs = [...body.paragraphs];
  if (body.action !== undefined) {
    textParagraphs.push(`${body.action.label}: ${body.action.url}`);
  }
  textParagraphs.push(SUPPORT_LINE, body.reason);

  const htmlParagraphs = body.paragraphs.map(escapeHtml);
  if (body.action !== undefined) {
    htmlParagraphs.push(link(body.action.url, body.action.label));
  }
  htmlParagraphs.push(escapeHtml(SUPPORT_LINE), escapeHtml(body.reason));

  return {
    template,
    subject: body.subject,
    text: textParagraphs.join('\n\n'),
    html: paragraphsToHtml(htmlParagraphs),
    reason: body.reason,
  };
}

/* -------------------------------------------------------------------------- */
/* the templates                                                              */
/* -------------------------------------------------------------------------- */

type Renderer<T extends NotificationTemplate> = (
  vars: TemplateVariables<T>,
) => RenderedNotification;

const signInLink: Renderer<'sign_in_link'> = (vars) =>
  assemble('sign_in_link', {
    subject: `Your ${PRODUCT_NAME} sign-in link`,
    paragraphs: [
      `Use the link below to sign in. It works once and expires in ${String(vars.expiresInMinutes)} minutes.`,
      'We never ask for a password, so there is no password for anyone to steal or for you to remember.',
    ],
    action: { url: vars.signInUrl, label: 'Sign in' },
    reason: `You are receiving this because someone asked ${PRODUCT_NAME} to send a sign-in link to this address. If that was not you, ignore this message — the link is useless without this inbox.`,
  });

const welcome: Renderer<'welcome'> = (vars) =>
  assemble('welcome', {
    subject: `${PRODUCT_NAME}: your workspace is ready`,
    paragraphs: [
      `Your workspace "${vars.workspaceName}" exists. It will not check anything yet, because nothing is connected.`,
      'Three things have to happen before we can verify a single enquiry: connect HubSpot with read access, connect Resend, and change your automation so it sends us one signed event per enquiry. That last step is real work in your own automation, not a switch here.',
      'Until all three are done, your results page will be empty. An empty results page means we have nothing to check, not that everything passed.',
    ],
    action: { url: vars.setupUrl, label: 'Finish setting up' },
    reason: `You are receiving this because this address created a ${PRODUCT_NAME} workspace.`,
  });

const firstMaterialFailure: Renderer<'first_material_failure'> = (vars) =>
  assemble('first_material_failure', {
    subject: `${vars.workflowName}: a check failed`,
    paragraphs: [
      `A run of "${vars.workflowName}" in ${vars.workspaceName} failed a mandatory check.`,
      vars.reasonSentence,
      'We have not changed anything in HubSpot or Resend, and we will not. Fixing the underlying automation is still yours to do.',
      'We will not email you about every further failure of the same kind. You will hear from us again when this recovers, or when something materially different goes wrong.',
    ],
    action: { url: vars.runUrl, label: 'See the evidence for this run' },
    reason: `You are receiving this because you are the owner of ${vars.workspaceName} and this is the first material failure of this workflow.`,
  });

const recovery: Renderer<'recovery'> = (vars) =>
  assemble('recovery', {
    subject: `${vars.workflowName}: back to normal`,
    paragraphs: [
      `"${vars.workflowName}" in ${vars.workspaceName} is producing verified results again. The interruption we told you about began at ${vars.interruptionStartedAt}.`,
      'Runs that were unverified during the interruption stay unverified. We do not retrospectively mark them as passed, because we never saw the evidence that would justify it.',
    ],
    action: { url: vars.resultsUrl, label: 'See the results' },
    reason: `You are receiving this because we emailed you when this workflow started failing, and it has now recovered.`,
  });

const providerDisconnected: Renderer<'provider_disconnected'> = (vars) =>
  assemble('provider_disconnected', {
    subject: `${vars.provider} is no longer connected to ${vars.workspaceName}`,
    paragraphs: [
      `We can no longer read from ${vars.provider}. ${vars.reasonSentence}`,
      'While this lasts, affected runs are shown as unverified with the reason recorded. They are not shown as passed, and they are not shown as failed — we simply cannot see.',
    ],
    action: { url: vars.reconnectUrl, label: `Reconnect ${vars.provider}` },
    reason: `You are receiving this because you are the owner of ${vars.workspaceName} and one of its connections needs your attention.`,
  });

const allowanceApproaching: Renderer<'allowance_approaching'> = (vars) =>
  assemble('allowance_approaching', {
    subject: `${vars.workspaceName}: ${String(vars.runsUsed)} of ${String(LIMITS.PLAN_RUNS_PER_PERIOD)} runs used`,
    paragraphs: [
      `You have used ${String(vars.runsUsed)} of the ${String(LIMITS.PLAN_RUNS_PER_PERIOD)} runs included in this billing period, which ends on ${vars.periodEndsAt}.`,
      PLAN_AT_ALLOWANCE,
      'You do not need to do anything. This is a notice, not a bill.',
    ],
    reason: `You are receiving this because you are the owner of ${vars.workspaceName} and its included runs are nearly used.`,
  });

const allowanceReached: Renderer<'allowance_reached'> = (vars) =>
  assemble('allowance_reached', {
    subject: `${vars.workspaceName}: this period's runs are used`,
    paragraphs: [
      `All ${String(LIMITS.PLAN_RUNS_PER_PERIOD)} runs included in this billing period have been used. We have stopped accepting new events for this workflow until the period ends on ${vars.periodEndsAt}.`,
      'Events sent between now and then are declined rather than queued. Nothing is being counted up to charge you later.',
      'Existing runs already in progress will finish being checked as normal.',
    ],
    reason: `You are receiving this because you are the owner of ${vars.workspaceName} and we have stopped accepting its events for the rest of this period.`,
  });

/**
 * The recovery-window sentence.
 *
 * `daysRemaining` is A06's, computed from the window anchor. When it is not supplied the
 * message states the window length instead of a countdown — still true, and read from
 * `PAYMENT_FAILURE_GRACE_DAYS` so it cannot drift from the approved policy.
 */
function recoveryWindowSentence(vars: {
  readonly daysRemaining?: number;
  readonly graceDays?: number;
}): string {
  const grace = vars.graceDays ?? PAYMENT_FAILURE_GRACE_DAYS;
  const window = `${String(grace)}-day recovery window that started when the renewal failed`;
  if (vars.daysRemaining === undefined) {
    return `You have a ${window} to sort this out.`;
  }
  if (vars.daysRemaining <= 0) {
    return `The ${window} has now run out.`;
  }
  const days = Math.trunc(vars.daysRemaining);
  return `You have ${String(days)} day${days === 1 ? '' : 's'} left of the ${window}.`;
}

/**
 * NEW WORDING (A09), rewritten 2026-09-19 after the founder approved the payment-recovery
 * policy in `apps/app/src/billing/policy.ts`.
 *
 * The paragraph this replaced said "We have not suspended anything yet", which was true
 * when it was written and is false under the approved policy — new runs pause from the
 * first failed renewal. It would have contradicted A06's own sentence inside the same
 * email, and the false half was the reassuring one.
 *
 * Division of labour with A06, so the message reads as one voice: `reasonSentence` is the
 * *situation* (Stripe's reason, and which phase of the window this workspace is in). The
 * paragraphs here are the *policy* — what stopped, what did not, how long, what day 8
 * means, and what resuming takes. Neither restates the other.
 */
const paymentProblem: Renderer<'payment_problem'> = (vars) =>
  assemble('payment_problem', {
    subject: `${vars.workspaceName}: new runs are paused after a failed payment`,
    paragraphs: [
      `Our payment provider could not take this month's payment for ${vars.workspaceName}, so we have paused checking new verification runs. New enquiries are not being verified until the payment goes through.`,
      vars.reasonSentence,
      'Nothing else has stopped. You can still sign in, read your full run history and every past result, see evidence that is still inside its retention period, export your data, update your payment method, and cancel. All of that stays available throughout.',
      recoveryWindowSentence(vars),
      'If the window runs out, verification stays suspended and the subscription is marked unpaid. It is not cancelled — we will not end your subscription for you — and nothing of yours is deleted. A missed payment is not a deletion trigger; your data is kept exactly as our published retention policy says and nothing else.',
      'Checking starts again when a payment is actually confirmed by our payment provider. Not on a retry, and not on a promise to pay — we will not tell you it is working again until it is.',
      'Card details are handled entirely by the payment provider. We never see them, and we cannot update them for you.',
    ],
    action: { url: vars.billingPortalUrl, label: 'Open the billing portal' },
    reason: `You are receiving this because you are the billing contact for ${vars.workspaceName}.`,
  });

const cancellationConfirmed: Renderer<'cancellation_confirmed'> = (vars) =>
  assemble('cancellation_confirmed', {
    subject: `${vars.workspaceName}: your subscription is cancelled`,
    paragraphs: [
      'Your subscription is cancelled. It will not renew, and you will not be charged again.',
      vars.timing === 'period_end'
        ? `You keep access until ${vars.accessEndsAt}, which is the end of the period you have already paid for.`
        : `Access ended at ${vars.accessEndsAt}, because this cancellation was made to take effect immediately rather than at the end of the period.`,
      'You do not need to speak to anyone to make this stick, and there is nothing further to cancel. If you would also like your data removed, ask and we will tell you exactly what goes and what we are required to keep.',
    ],
    reason: `You are receiving this because a cancellation was recorded for ${vars.workspaceName}.`,
  });

const dataExportReady: Renderer<'data_export_ready'> = (vars) =>
  assemble('data_export_ready', {
    subject: `${vars.workspaceName}: your data export is ready`,
    paragraphs: [
      'Your export is ready to download. It contains your workspace configuration, your runs and their results, the evidence we still hold, your support cases and your billing records.',
      'It does not contain any credential, not even a masked one, and it contains nothing belonging to any other customer.',
      `The download link stops working at ${vars.expiresAt}. Ask again if you need another copy.`,
    ],
    action: { url: vars.downloadUrl, label: 'Download the export' },
    reason: `You are receiving this because an export was requested from inside ${vars.workspaceName}.`,
  });

const deletionScheduled: Renderer<'deletion_scheduled'> = (vars) =>
  assemble('deletion_scheduled', {
    subject: `${vars.workspaceName}: deletion scheduled for ${vars.deletionAt}`,
    paragraphs: [
      `We have scheduled the deletion of "${vars.workspaceName}" for ${vars.deletionAt}. Nothing has been removed yet.`,
      'When it runs, we revoke your sign-in sessions, stop all scheduled checks and expire shareable links, then remove your evidence, runs and results, workflow configuration and rules, provider connections and the credentials stored against them, support messages, notification records and every membership of the workspace.',
      'We keep billing and tax records, and a record that the deletion happened, because we are required to. We will send you a plain statement of exactly what remains.',
      'Our database backups are not rewritten. Data already captured in a backup stays there until that backup expires on its own schedule. We would rather tell you that than claim an erasure we cannot perform.',
    ],
    action: { url: vars.cancelUrl, label: 'Stop this deletion' },
    reason: `You are receiving this because deletion of ${vars.workspaceName} was requested by an owner of that workspace.`,
  });

const deletionCompleted: Renderer<'deletion_completed'> = (vars) =>
  assemble('deletion_completed', {
    subject: `${vars.workspaceName}: deletion complete`,
    paragraphs: [
      `"${vars.workspaceName}" has been deleted. Your sessions and stored provider credentials are revoked, scheduled checks are stopped, and your evidence, runs and workflow configuration are removed.`,
      vars.retainedStatement,
      'This address will receive nothing further from us apart from anything legally required about the records above.',
    ],
    reason: `You are receiving this because you asked us to delete ${vars.workspaceName}, and this is the confirmation that it is done.`,
  });

const RENDERERS: { [T in NotificationTemplate]: Renderer<T> } = {
  sign_in_link: signInLink,
  welcome,
  first_material_failure: firstMaterialFailure,
  recovery,
  provider_disconnected: providerDisconnected,
  allowance_approaching: allowanceApproaching,
  allowance_reached: allowanceReached,
  payment_problem: paymentProblem,
  cancellation_confirmed: cancellationConfirmed,
  data_export_ready: dataExportReady,
  deletion_scheduled: deletionScheduled,
  deletion_completed: deletionCompleted,
};

/**
 * Render one notification. The mapped `RENDERERS` type means a template added to
 * `NOTIFICATION_TEMPLATE` will not compile until it has words and a stated reason.
 */
export function renderNotification<T extends NotificationTemplate>(
  template: T,
  vars: TemplateVariables<T>,
): RenderedNotification {
  const renderer = RENDERERS[template];
  return renderer(vars);
}

/**
 * Templates a customer can switch off. Everything absent from this set is operational or
 * legal — a sign-in link, a payment failure, a deletion confirmation — and is sent
 * regardless, because suppressing it would be worse for the customer than receiving it.
 */
export const OPTIONAL_TEMPLATES: ReadonlySet<NotificationTemplate> = new Set([
  'first_material_failure',
  'recovery',
  'allowance_approaching',
]);
