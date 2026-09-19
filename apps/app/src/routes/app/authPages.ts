/**
 * Sign in.
 *
 * A magic link, one field, and a response that is the same whether or not the address has
 * an account — a sign-in form that says "no account with that email" is an account
 * enumeration oracle, and this one refuses to be.
 */
import { Button, Callout, CsrfField, Field, html, type Html } from '@verify/ui';
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
      New here? Start with the <a href="/demo">worked example</a> and the
      <a href="/how-it-works">setup requirements</a> before you sign up — this is not a one-click product.
    </p>
  </div>`;
}
