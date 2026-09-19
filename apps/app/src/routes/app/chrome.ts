/**
 * Shared chrome for the customer pages: the synthetic-data notice, the onboarding
 * progress trail, and the page heading block.
 */
import { Callout, attrs, html, safeHref, type Html, type StatusKey } from '@verify/ui';
import type { ConnectionStatus } from '@verify/contracts';

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
      Every workflow, run, connection and number on these pages is invented — nothing here reflects your own
      automation. The verdicts come from the real verification engine run against fixed synthetic evidence,
      so they are genuine answers about made-up facts. No provider, payment or support queue is connected.
    </p>`,
  });
}

/** The stripe that sits directly under the header on any page showing synthetic data. */
export function syntheticStripe(synthetic: boolean): Html | null {
  if (!synthetic) return null;
  return html`<p class="synthetic__stripe" role="note">
    Synthetic data — not your workspace, not your runs
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
}

export function pageHead(options: PageHeadOptions): Html {
  return html`<div class="stack-sm">
    <p class="eyebrow">${options.eyebrow}</p>
    <h1>${options.title}</h1>
    ${options.lede === undefined ? null : html`<p class="lede measure">${options.lede}</p>`}
  </div>`;
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
