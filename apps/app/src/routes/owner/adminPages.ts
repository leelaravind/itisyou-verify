/**
 * `/admin` and `/admin/login` — the administrative entry point.
 *
 * The sign-in page is reachable by anyone on the internet, on purpose. Hiding it is not a
 * control (see `owner/access.ts`), and a login page nobody can find is a login page the
 * owner cannot reach from a phone in a hurry.
 *
 * What it must therefore never do is leak. Every rule below is a thing this page is
 * forbidden from putting in its HTML:
 *
 *   - no customer name, address, count or identifier;
 *   - no "how many owners exist", no "bootstrap is available", no "this address has an
 *     account". A submitted address always gets the same answer;
 *   - no build metadata, no environment name, no database state;
 *   - no differing response between a known and an unknown address, in body or in status.
 *
 * {@link LOGIN_ACKNOWLEDGEMENT} is the single sentence returned for every submission,
 * whatever happened, and it is a constant so the two branches cannot drift apart.
 */
import { Button, Callout, Card, CsrfField, Field, html, type Html } from '@verify/ui';
import { OwnerLayout } from './chrome.js';

/**
 * The answer when a link genuinely went out.
 *
 * It is identical for every address, which is the point: it must never reveal whether an
 * account exists. What it may vary with is whether this DEPLOYMENT can send mail at all,
 * because that is not a fact about the address and every visitor can observe it anyway.
 */
export const LOGIN_ACKNOWLEDGEMENT =
  'If that address can sign in here, a link is on its way. It expires in fifteen minutes and can be used once. ' +
  'We do not say whether an account exists, to anyone, ever.';

/**
 * The answer when nothing was sent, because no mail transport is configured here.
 *
 * Until 20 September 2026 this page showed the sentence above on every deployment,
 * including ones that send nothing, so a visitor waited for a mail that did not exist. The
 * token really was minted and really did expire; it was simply never delivered. Saying
 * "a link is on its way" when no link is on its way is the precise failure this product
 * was built to catch in other people's systems.
 *
 * It still reveals nothing about the address.
 */
export const LOGIN_NO_TRANSPORT =
  'No sign-in link was sent. This deployment has no email delivery configured, so nothing ' +
  'would arrive and we will not pretend otherwise. We do not say whether an account ' +
  'exists, to anyone, ever.';

export interface LoginPageOptions {
  readonly csrfToken: string | null;
  /** Shown after a submission. */
  readonly submitted: boolean;
  /**
   * What the deployment actually did. Governs which of the two acknowledgements is shown,
   * and nothing else -- it carries no information about the address.
   */
  readonly delivery?: 'sent' | 'no_transport';
  /** A field-level error for a genuinely malformed address. Never an existence signal. */
  readonly fieldError: string | null;
  /** The address the person typed, echoed so they do not retype it. Escaped by the template. */
  readonly email: string;
}

/**
 * The sign-in page.
 *
 * It renders identically for a first-time visitor, a customer who wandered in and the
 * owner. There is no conditional anywhere below that depends on the state of the database.
 */
export function AdminLoginPage(options: LoginPageOptions): Html {
  return html`<div class="wrap section stack">
    <div class="stack-sm">
      <p class="eyebrow">Administration</p>
      <h1>Sign in</h1>
      <p class="lede measure">
        This page is for the person who runs ITISYOU Verify. If you are a customer, your workspace is at
        <a href="/app">the customer sign-in page</a>.
      </p>
    </div>

    ${
      options.submitted
        ? Callout({
            // "Check your email" over a deployment that sent nothing is the whole defect.
            // Both the heading and the tone follow what actually happened.
            tone: options.delivery === 'no_transport' ? 'warn' : 'note',
            title: options.delivery === 'no_transport' ? 'Nothing was sent' : 'Check your email',
            body: html`<p>
              ${options.delivery === 'no_transport' ? LOGIN_NO_TRANSPORT : LOGIN_ACKNOWLEDGEMENT}
            </p>`,
          })
        : null
    }

    ${Card({
      title: 'Email a sign-in link',
      headingLevel: 2,
      body: html`<form method="post" action="/admin/login" class="stack">
        ${CsrfField(options.csrfToken)}
        ${Field({
          name: 'email',
          label: 'Email address',
          control: 'email',
          required: true,
          autocomplete: 'email',
          inputmode: 'email',
          value: options.email,
          hint: 'We send a single-use link. There is no password to steal and none to forget.',
          error: options.fieldError,
        })}
        ${Button({ label: 'Email me a link', variant: 'primary', type: 'submit' })}
      </form>`,
    })}

    ${Card({
      title: 'After the link',
      headingLevel: 2,
      body: html`<p class="measure">
          Opening the link signs you in. Before anything that changes money, access or what the public sees,
          you will be asked for a six-digit code from your authenticator app — and again if more than fifteen
          minutes have passed since the last one.
        </p>
        <p class="measure small muted">
          Administrative pages are marked <span class="mono">noindex</span>, which asks search engines not to
          list them. That is tidiness. The session check is the protection.
        </p>`,
    })}
  </div>`;
}

/** The page wrapper. Public — so it uses no account label and shows no synthetic banner. */
export function adminLoginDocument(options: LoginPageOptions): Html {
  return OwnerLayout({
    title: 'Sign in',
    path: '/admin/login',
    body: AdminLoginPage(options),
  });
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapPageOptions {
  readonly csrfToken: string | null;
  /** The address this session has already proved, or null when it has proved none. */
  readonly verifiedSubject: string | null;
  /** A refusal from a previous attempt, in plain language. */
  readonly refusal: string | null;
}

/**
 * The one-time owner bootstrap.
 *
 * It is reachable only by a session that has already redeemed a magic link, and it says so
 * rather than quietly failing: a bootstrap token is proof of a deployment, never proof of a
 * person, and both are required.
 */
export function BootstrapPage(options: BootstrapPageOptions): Html {
  return html`<div class="wrap section stack">
    <div class="stack-sm">
      <p class="eyebrow">First run</p>
      <h1>Claim the owner account</h1>
      <p class="lede measure">
        This happens once, from the deployment secret, and then it is closed permanently.
      </p>
    </div>

    ${
      options.refusal === null
        ? null
        : Callout({
            tone: 'warn',
            title: 'That did not work',
            body: html`<p>${options.refusal}</p>`,
          })
    }

    ${
      options.verifiedSubject === null
        ? Callout({
            tone: 'warn',
            title: 'Sign in first',
            body: html`<p>
            You have not proved an email address in this session yet.
            <a href="/admin/login">Ask for a sign-in link</a>, open it, then come back. The bootstrap token
            proves which deployment this is; it does not prove who you are, and both are needed.
          </p>`,
          })
        : Card({
            title: 'Bootstrap token',
            headingLevel: 2,
            body: html`<form method="post" action="/admin/bootstrap" class="stack">
            ${CsrfField(options.csrfToken)}
            <p class="small">
              Signed in as <span class="mono">${options.verifiedSubject}</span>. The token must match this
              deployment's <span class="mono">OWNER_BOOTSTRAP_TOKEN</span>, and this address must be the one
              the deployment authorises.
            </p>
            ${Field({
              name: 'token',
              label: 'Owner bootstrap token',
              control: 'password',
              required: true,
              mono: true,
              autocomplete: 'off',
              hint: 'Paste the value you set as the deployment secret. It is never stored or shown again.',
            })}
            ${Button({ label: 'Claim the owner account', variant: 'primary', type: 'submit' })}
          </form>`,
          })
    }

    ${Card({
      title: 'What happens next',
      headingLevel: 2,
      body: html`<ul class="stack-sm">
        <li>Your user row is marked as the platform owner.</li>
        <li>An audit entry records that it happened, and when.</li>
        <li>
          This page stops working. Not because the secret was deleted — because an owner now exists, and the
          code refuses while one does. You do not have to remember to tidy anything up.
        </li>
      </ul>`,
    })}
  </div>`;
}

export function bootstrapDocument(options: BootstrapPageOptions): Html {
  return OwnerLayout({
    title: 'Claim the owner account',
    path: '/admin/bootstrap',
    body: BootstrapPage(options),
  });
}
