/**
 * Shared chrome for the customer pages: the synthetic-data notice, the onboarding
 * progress trail, and the page heading block.
 */
import {
  Callout,
  STATUS_DEFINITIONS,
  StatusBadge,
  attrs,
  html,
  safeHref,
  type Html,
  type StatusKey,
} from '@verify/ui';
import type { ConnectionStatus } from '@verify/contracts';
import type { ConnectionView, RunCountsView } from './port.js';

/**
 * The banner every page carries while it is running on the synthetic port.
 *
 * It is a `warn` callout rather than a quiet note on purpose: a customer who mistakes
 * placeholder runs for their own would draw exactly the wrong conclusion about their
 * automation, which is the one failure this product cannot afford.
 */
export function syntheticNotice(synthetic: boolean): Html | null {
  if (!synthetic) return null;
  return Callout({
    tone: 'warn',
    title: 'This workspace is showing synthetic data',
    // One paragraph, deliberately. At 390px the two-paragraph version pushed the workspace
    // heading below the fold, which buries the thing the customer came for.
    body: html`<p>
      Every workflow, run, connection and number on these pages is invented: nothing here reflects your own
      automation. The verdicts come from the real verification engine run against fixed synthetic evidence,
      so they are genuine answers about made-up facts. No provider, payment or support queue is connected.
    </p>`,
  });
}

/** The stripe that sits directly under the header on any page showing synthetic data. */
export function syntheticStripe(synthetic: boolean): Html | null {
  if (!synthetic) return null;
  return html`<p class="synthetic__stripe" role="note">
    Synthetic data: not your workspace, not your runs
  </p>`;
}

export interface OnboardingStep {
  readonly href: string;
  readonly label: string;
}

/** The onboarding journey, in order. Order carries information here, so it is a real list. */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { href: '/app/onboarding/compatibility', label: 'Check compatibility' },
  { href: '/app/onboarding/connect', label: 'Connect' },
  { href: '/app/onboarding/mapping', label: 'Map fields' },
  { href: '/app/onboarding/outcome', label: 'Expected outcome' },
  { href: '/app/onboarding/proof', label: 'Proof run' },
  { href: '/app/onboarding/review', label: 'Review and price' },
  { href: '/app/onboarding/activation', label: 'Activate' },
];

/**
 * The progress trail. It is an ordered list with `aria-current` on the step you are on, so
 * the position is available to a screen reader and not only to the eye.
 */
export function onboardingProgress(currentHref: string): Html {
  const currentIndex = ONBOARDING_STEPS.findIndex((step) => step.href === currentHref);
  return html`<nav aria-label="Setup progress">
    <ol class="progress">
      ${ONBOARDING_STEPS.map((step, index) => {
        const done = currentIndex > index;
        const current = currentIndex === index;
        return html`<li ${current ? html`aria-current="step"` : null} data-done="${done ? 'yes' : 'no'}">
          ${current || done ? html`<a ${attrs({ href: safeHref(step.href) })}>${step.label}</a>` : step.label}
        </li>`;
      })}
    </ol>
  </nav>`;
}

export interface PageHeadOptions {
  readonly eyebrow: string;
  readonly title: string;
  readonly lede?: string;
  /**
   * The page's primary action, rendered beside the heading.
   *
   * The workspace's only way to start a verification used to be a closed disclosure reading
   * "Describe the enquiry to check", four screens down. A reader looking for the button did
   * not find one, because there was not one.
   */
  readonly action?: Html | null;
}

export function pageHead(options: PageHeadOptions): Html {
  const heading = html`<div class="stack-sm">
    <p class="eyebrow">${options.eyebrow}</p>
    <h1>${options.title}</h1>
    ${options.lede === undefined ? null : html`<p class="lede measure">${options.lede}</p>`}
  </div>`;
  if (options.action === undefined || options.action === null) return heading;
  // Wraps under the heading on a narrow screen rather than squeezing beside it.
  return html`<div class="page-head">${heading}<div class="page-head__action">${options.action}</div></div>`;
}

/** A form-level error, rendered above the fields it concerns. */
export function formMessage(message: string | null, tone: 'warn' | 'note' = 'warn'): Html | null {
  if (message === null || message.length === 0) return null;
  return Callout({ tone, body: html`<p role="alert">${message}</p>` });
}

export interface ConnectionPresentation {
  readonly label: string;
  readonly status: StatusKey;
}

/**
 * How each connection lifecycle state is shown.
 *
 * The one that matters is `testing`. A04 tightened Resend so that a stored signing secret
 * no longer counts as validation — a stored secret is a promise, not evidence — and a
 * connection only reaches `ready` once a correctly signed callback has actually arrived.
 * So `testing` wears the PENDING clock and reads "Not finished yet". It must never wear a
 * tick: a customer who sees a tick stops setting up, and then wonders why their runs are
 * unverified.
 *
 * `authorising` is the same case for the same reason.
 */
export const CONNECTION_PRESENTATION: Readonly<Record<ConnectionStatus, ConnectionPresentation>> = {
  not_connected: { label: 'Not connected', status: 'UNVERIFIED' },
  authorising: { label: 'Not finished yet', status: 'PENDING' },
  testing: { label: 'Not finished yet', status: 'PENDING' },
  ready: { label: 'Ready', status: 'VERIFIED' },
  degraded: { label: 'Degraded', status: 'UNVERIFIED' },
  expired: { label: 'Expired', status: 'UNVERIFIED' },
  revoked: { label: 'Access revoked', status: 'FAILED' },
  unsupported: { label: 'Not supported', status: 'FAILED' },
};

export function connectionPresentation(status: ConnectionStatus): ConnectionPresentation {
  return CONNECTION_PRESENTATION[status];
}

/**
 * The connections grouped by the state they are shown in, in the order they are listed —
 * the strip of counts the approved connections screen closes with.
 *
 * Each entry wears the same badge and the same label as the card it counts, so the strip
 * cannot say "ready" about a connection the card says is not finished. Nothing is grouped
 * under a label that no card carries. The connect step draws this under its cards;
 * `/app/connections` draws the same strip beside its head from its own copy in
 * accountPages.ts, which predates this one and was left where it is.
 */
export function connectionTally(connections: readonly ConnectionView[]): Html {
  const groups = new Map<string, { readonly status: StatusKey; count: number }>();
  for (const connection of connections) {
    const presentation = connectionPresentation(connection.status);
    const group = groups.get(presentation.label);
    if (group === undefined) groups.set(presentation.label, { status: presentation.status, count: 1 });
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

/* ------------------------------------------------------------- run counts */

/** The four statuses in the contract's order, so a tally always has four entries and never a fifth. */
export const COUNT_ORDER: readonly StatusKey[] = ['VERIFIED', 'FAILED', 'UNVERIFIED', 'PENDING'];

const COUNT_FIELD: Readonly<Record<StatusKey, keyof RunCountsView>> = {
  VERIFIED: 'verified',
  FAILED: 'failed',
  UNVERIFIED: 'unverified',
  PENDING: 'pending',
};

export function countFor(counts: RunCountsView, status: StatusKey): number {
  return counts[COUNT_FIELD[status]];
}

export function runTotal(counts: RunCountsView): number {
  return counts.verified + counts.failed + counts.unverified + counts.pending;
}

/**
 * The run counts as four cards in one row — the approved dashboard's opening block.
 *
 * One card per status, in the contract's order, each ruled along its top in its own colour
 * (the shared `.status-card`, so UNVERIFIED keeps its dash) and each carrying the badge, so
 * the colour is never the only signal. The figure is the port's count and nothing else; the
 * sentence under it is the content module's definition of that status. Zero is rendered as
 * 0, never dropped: a missing card would make three results look like the whole vocabulary.
 */
export function runCountCards(counts: RunCountsView): Html {
  return html`<div class="count-grid" data-run-counts>
    ${STATUS_DEFINITIONS.map((definition) => {
      const total = countFor(counts, definition.status);
      return html`<div
        class="status-card status-card--${definition.status.toLowerCase()}"
        data-count-card="${definition.status}"
      >
        <div>${StatusBadge({ status: definition.status })}</div>
        <p class="count"><span data-count="${definition.status}">${String(total)}</span><span class="count__noun">${total === 1 ? 'run' : 'runs'}</span></p>
        <p class="small muted">${definition.description}</p>
      </div>`;
    })}
  </div>`;
}

/**
 * One count per status under a run table — all four, always, including any that are zero —
 * computed from the same counts as the cards above it, so the strip can never disagree with
 * the table it closes. Colour comes only from the badge.
 */
export function runTally(counts: RunCountsView): Html {
  return html`<ul class="tally" aria-label="Runs by result">
    ${COUNT_ORDER.map(
      (status) => html`<li data-tally="${status}">
        <span class="tally__count">${String(countFor(counts, status))}</span>
        ${StatusBadge({ status })}
      </li>`,
    )}
  </ul>`;
}
