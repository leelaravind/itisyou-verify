/**
 * The three pages Stripe sends a customer back to.
 *
 * ## Why this file exists
 *
 * `checkoutReturnUrls` has always told Stripe to return the browser to
 * `/app/billing/return?session_id=…` after a successful payment and to `/app/billing` after
 * a cancelled one, and `portalReturnUrl` sends it to `/app/billing` after the billing
 * portal. None of those routes existed. On 20 September 2026 the first real sandbox payment
 * went through and Stripe returned the customer to a **404**.
 *
 * It is the project's dominant defect class reaching its worst possible location: the
 * moment after a person has paid, when the product had said "You are handed to Stripe's own
 * hosted checkout page" and then had nowhere to hand them back to. No test could see it,
 * because every test drove the POST and read its redirect — the journey ended at Stripe's
 * front door and nothing followed the customer home.
 *
 * ## What these pages may claim
 *
 * `/app/billing/return` is reached the instant Stripe redirects, which is **before** the
 * `checkout.session.completed` webhook has necessarily arrived. So it must not say the
 * subscription is active: it says the payment was accepted by Stripe and that activation
 * follows when Stripe confirms it to us, and it shows whatever the workspace's subscription
 * state actually is at that instant. Saying "you are subscribed" on the strength of a
 * redirect would be claiming an outcome from the fact that a request was made — precisely
 * what this product exists to catch in other people's systems.
 *
 * The page is read-only. It activates nothing, and a reload changes nothing.
 */
import {
  Breadcrumb,
  Button,
  ButtonRow,
  Callout,
  Card,
  EmptyState,
  StatusBadge,
  html,
  type Html,
} from '@verify/ui';
import { pageHead } from './chrome.js';
import type { ActivationView } from './port.js';

/** The subscription state, said plainly, with no verb the evidence does not support. */
function subscriptionSummary(activation: ActivationView): Html {
  const status = activation.subscriptionStatus;
  return Card({
    title: 'Your subscription',
    headingLevel: 2,
    body: html`<div class="stack">
      <p>
        Status:
        ${
          status === null
            ? 'no subscription is recorded for this workspace yet'
            : html`<strong>${status}</strong>`
        }
      </p>
      <p>
        ${
          activation.active
            ? 'Verification runs are accepted for this workspace.'
            : 'Verification runs are not accepted for this workspace yet.'
        }
      </p>
    </div>`,
  });
}

export interface BillingReturnPageOptions {
  readonly activation: ActivationView;
  /** Stripe substitutes this into the URL. Shown so a person can quote it to support. */
  readonly sessionId: string | null;
}

export function BillingReturnPage(options: BillingReturnPageOptions): Html {
  const active = options.activation.active;
  return html`<div class="wrap section stack-lg measure">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Billing' }])}
    ${pageHead({
      eyebrow: 'Billing',
      title: active ? 'Your subscription is active' : 'Stripe has taken your payment',
      lede: active
        ? 'Stripe has confirmed the payment to us and this workspace is subscribed.'
        : 'Stripe accepted the payment. We record the subscription when Stripe confirms it to us, which is usually within a few seconds.',
    })}

    ${
      active
        ? null
        : Callout({
            tone: 'note',
            title: 'Why this page does not simply say you are subscribed',
            body: html`<p>
              You arrived here because your browser was redirected, and a redirect is not evidence that we
              have been told anything. Stripe confirms the payment to us over a separate signed channel,
              and until that arrives we will not claim an outcome we have not observed. That is the same
              rule this service applies to your automations. Reload this page in a moment; nothing you do
              here changes the result either way.
            </p>`,
          })
    }

    ${subscriptionSummary(options.activation)}

    ${
      options.sessionId === null
        ? null
        : Card({
            title: 'Your payment reference',
            headingLevel: 2,
            body: html`<p>
              Quote this to support if anything looks wrong: <code>${options.sessionId}</code>. It
              identifies the checkout, never a card.
            </p>`,
          })
    }

    ${ButtonRow([
      Button({
        label: active ? 'Set up your workflow' : 'Go to activation',
        href: '/app/onboarding/activation',
        variant: 'primary',
      }),
      Button({ label: 'Back to the workspace', href: '/app', variant: 'quiet' }),
      Button({ label: 'Billing', href: '/app/billing', variant: 'quiet' }),
    ])}
  </div>`;
}

export interface BillingPageOptions {
  readonly activation: ActivationView;
  readonly portal: { readonly href: string | null; readonly reason: string | null };
  /** True when Stripe returned the customer here from an abandoned checkout. */
  readonly checkoutCancelled: boolean;
}

export function BillingPage(options: BillingPageOptions): Html {
  return html`<div class="wrap section stack-lg measure">
    ${Breadcrumb([{ label: 'Workspace', href: '/app' }, { label: 'Billing' }])}
    ${pageHead({
      eyebrow: 'Billing',
      title: 'Billing',
      lede: 'What this workspace is subscribed to, and how to change or stop it.',
    })}

    ${
      options.checkoutCancelled
        ? Callout({
            tone: 'note',
            title: 'Checkout was cancelled',
            body: html`<p>
              You left the payment page before finishing, so <strong>no card was charged</strong> and
              nothing about this workspace has changed. You can start again whenever you like.
            </p>`,
          })
        : null
    }

    ${subscriptionSummary(options.activation)}

    ${
      options.portal.href === null
        ? EmptyState({
            title: 'There is nothing to manage yet',
            body:
              options.portal.reason ??
              'No reason was recorded, which is itself a defect worth reporting.',
            actions: [
              Button({ label: 'See what you would be buying', href: '/app/onboarding/review' }),
            ],
          })
        : ButtonRow([
            Button({
              label: 'Open the billing portal',
              href: options.portal.href,
              variant: 'primary',
              external: true,
            }),
            Button({ label: 'Cancel your plan', href: '/app/cancel', variant: 'quiet' }),
          ])
    }

    ${Callout({
      tone: 'note',
      title: 'Card details',
      body: html`<p>
        Your card is held by Stripe and never reaches us. Changing it, or seeing your invoices, happens
        in Stripe's own billing portal above.
      </p>`,
    })}
  </div>`;
}

/** Re-exported so a route can show the status without importing the badge directly. */
export { StatusBadge };
