/**
 * Sign in.
 *
 * A magic link, one field, and a response that is the same whether or not the address has
 * an account — a sign-in form that says "no account with that email" is an account
 * enumeration oracle, and this one refuses to be.
 */
import { ActivationNotice, Button, Callout, CsrfField, Field, html, type Html } from '@verify/ui';
import { pageHead, formMessage } from './chrome.js';
import type { WriteResult } from './port.js';

export interface SignInPageOptions {
  readonly csrfToken: string | null;
  readonly submitted: WriteResult | null;
  readonly email: string;
  /** True after a link has been requested, so the page can show the confirmation instead. */
  readonly linkSent: boolean;
}

export function SignInPage(options: SignInPageOptions): Html {
  if (options.linkSent) {
    return html`<div class="wrap section stack-lg measure">
      ${pageHead({
        eyebrow: 'Sign in',
        title: 'Check your email',
        lede: 'If that address has a workspace, a sign-in link is on its way to it. The link works once and expires.',
      })}
      ${Callout({
        tone: 'note',
        title: 'We tell everybody the same thing',
        body: html`<p>
          We do not say whether an address has an account, because that would let anyone find out who our
          customers are. If no link arrives, the address probably does not have a workspace yet.
        </p>`,
      })}
      <p><a href="/app/sign-in">Use a different address</a></p>
    </div>`;
  }

  const errors = options.submitted?.fieldErrors ?? {};
  return html`<div class="wrap section stack-lg measure">
    ${pageHead({
      eyebrow: 'Sign in',
      title: 'Sign in to your workspace',
      lede: 'We send a one-time link rather than asking for a password, so there is no password to lose.',
    })}
    <!-- A GET of /app answers 401 with this page, so a stranger who clicks "Sign in" in
         the public header lands here. That makes it a public surface whatever the router
         calls it, and it was the one activation page carrying no notice: it invited the
         reader to "sign up" when no workspace is being activated and no payment is being
         taken. Signing in is untouched — an existing account must still be able to get to
         its workspace, so the form below stays exactly as it was. CUST-340. -->
    ${ActivationNotice()}
    ${formMessage(options.submitted?.message ?? null)}
    <form method="post" action="/app/sign-in" class="stack">
      ${CsrfField(options.csrfToken)}
      ${Field({
        name: 'email',
        label: 'Email address',
        control: 'email',
        value: options.email,
        required: true,
        autocomplete: 'email',
        inputmode: 'email',
        hint: 'The address the workspace was created with.',
        error: errors['email'] ?? null,
      })}
      ${Button({ label: 'Email me a sign-in link', variant: 'primary', type: 'submit' })}
    </form>
    <p class="small muted">
      New here? There is nothing to sign up for yet. Start with the <a href="/demo">worked example</a> and
      the <a href="/how-it-works">setup requirements</a>, which describe what this will take when new
      workspaces open.
    </p>
  </div>`;
}
