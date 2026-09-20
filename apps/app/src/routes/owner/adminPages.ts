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
/**
 * The answer when this deployment CAN send and the attempt failed.
 *
 * Distinct from the sentence below, because "we are not set up to email you" and "we tried
 * and it did not go" are different facts and only one of them is worth retrying. Reporting
 * the first when the second happened is the same class of false statement this page was
 * just fixed for.
 */
export const LOGIN_SEND_FAILED =
  'No sign-in link was sent. We tried and the attempt failed, so nothing arrived. Please try ' +
  'again in a moment. We do not say whether an account exists, to anyone, ever.';

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
  readonly delivery?: 'sent' | 'no_transport' | 'send_failed';
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
            tone: options.delivery === 'sent' ? 'note' : 'warn',
            title: options.delivery === 'sent' ? 'Check your email' : 'Nothing was sent',
            body: html`<p>
              ${
                options.delivery === 'send_failed'
                  ? LOGIN_SEND_FAILED
                  : options.delivery === 'no_transport'
                    ? LOGIN_NO_TRANSPORT
                    : LOGIN_ACKNOWLEDGEMENT
              }
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

// ---------------------------------------------------------------------------
// Authenticator enrolment
// ---------------------------------------------------------------------------

export interface AuthenticatorPageOptions {
  readonly csrfToken: string | null;
  /** Whether this owner already has an authenticator; null when the deployment cannot say. */
  readonly enrolled: boolean | null;
  /** Whether the Enrol button is offered on this render. */
  readonly canEnrol: boolean;
  /** The freshly minted seed and codes. Rendered on exactly one response, then gone. */
  readonly issued: {
    readonly provisioningUri: string;
    readonly secretBase32: string;
    readonly recoveryCodes: readonly string[];
  } | null;
  readonly refusal: string | null;
}

/**
 * Enrol the platform owner's authenticator.
 *
 * This page did not exist until 20 September 2026. `enrolTotp` had been written and tested
 * and had no caller, so on production no owner could ever pass the two-factor gate in
 * front of every consequential action -- the gate was correct and unreachable. The seed and
 * the recovery codes appear once, in the response to the Enrol post, and there is no route
 * that can show them again: losing them means enrolling again.
 */
export function AuthenticatorPage(options: AuthenticatorPageOptions): Html {
  const verifyForm = html`<form method="post" action="/admin/verify" class="stack">
    ${CsrfField(options.csrfToken)}
    <input type="hidden" name="return_to" value="/owner" />
    <div class="field">
      <label class="field__label" for="f-totp"
        >Six-digit code from your authenticator <span class="field__req">required</span></label
      >
      <input
        class="input input--mono"
        id="f-totp"
        name="totp"
        inputmode="numeric"
        autocomplete="one-time-code"
        pattern="[0-9]{6}"
        maxlength="6"
        required
      />
    </div>
    ${Button({ label: 'Confirm', variant: 'primary', type: 'submit' })}
  </form>`;

  return html`<div class="wrap section stack">
    <div class="stack-sm">
      <p class="eyebrow">Administration</p>
      <h1>Authenticator</h1>
      <p class="lede measure">
        Anything that changes money, access or what the public sees needs a six-digit code from the last fifteen
        minutes. This is where the code comes from.
      </p>
    </div>

    ${
      options.refusal === null
        ? null
        : Callout({
            tone: 'warn',
            title: 'Nothing was changed',
            body: html`<p data-enrolment-refusal="true">${options.refusal}</p>`,
          })
    }

    ${
      options.issued === null
        ? null
        : html`${Callout({
            tone: 'warn',
            title: 'Shown once. It will not be shown again.',
            body: html`<p class="measure">
              Add the secret to your authenticator app now, and store the recovery codes somewhere that is not
              this browser. If you lose both, you enrol again and these stop working.
            </p>`,
          })}
          ${Card({
            title: 'Secret for your authenticator app',
            headingLevel: 2,
            body: html`<p class="mono" data-totp-secret="true" style="word-break:break-all">${options.issued.secretBase32}</p>
              <p class="small muted measure">
                Or add it by address (most apps accept this when pasted):
              </p>
              <p class="mono small" style="word-break:break-all">${options.issued.provisioningUri}</p>`,
          })}
          ${Card({
            title: 'Recovery codes',
            headingLevel: 2,
            body: html`<p class="measure">Each works once, in place of a six-digit code.</p>
              <ul class="mono" data-recovery-codes="true">
                ${options.issued.recoveryCodes.map((code) => html`<li>${code}</li>`)}
              </ul>`,
          })}
          ${Card({
            title: 'Now confirm a code from the app',
            headingLevel: 2,
            body: verifyForm,
          })}`
    }

    ${
      options.issued !== null
        ? null
        : Callout({
            tone: options.enrolled === true ? 'note' : 'warn',
            title:
              options.enrolled === true
                ? 'An authenticator is enrolled'
                : options.enrolled === false
                  ? 'No authenticator is enrolled'
                  : 'Enrolment state unknown',
            body: html`<p class="measure" data-enrolment-state="${
              options.enrolled === null ? 'unknown' : options.enrolled ? 'enrolled' : 'none'
            }">
              ${
                options.enrolled === true
                  ? 'Replacing it retires the current seed and every unused recovery code, and needs a code from the current app first.'
                  : options.enrolled === false
                    ? 'Until one is, every consequential action in this panel is refused. Enrolling takes a minute.'
                    : 'This deployment cannot report whether an authenticator exists.'
              }
            </p>`,
          })
    }

    ${
      options.issued !== null || !options.canEnrol
        ? null
        : Card({
            title:
              options.enrolled === true ? 'Replace the authenticator' : 'Enrol an authenticator',
            headingLevel: 2,
            body: html`<form method="post" action="/admin/authenticator/enrol" class="stack">
              ${CsrfField(options.csrfToken)}
              <p class="measure">
                A new secret and ten recovery codes are minted and shown on the next page, once.
              </p>
              ${Button({ label: 'Enrol', variant: 'primary', type: 'submit' })}
            </form>`,
          })
    }

    ${
      options.issued === null && options.enrolled === true
        ? Card({ title: 'Confirm a code now', headingLevel: 2, body: verifyForm })
        : null
    }
  </div>`;
}

export function authenticatorDocument(options: AuthenticatorPageOptions): Html {
  return OwnerLayout({
    title: 'Authenticator',
    path: '/admin/authenticator',
    body: AuthenticatorPage(options),
    ...(options.csrfToken === null ? {} : { csrfToken: options.csrfToken }),
  });
}
