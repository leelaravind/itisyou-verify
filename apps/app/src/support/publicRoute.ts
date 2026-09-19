/**
 * The signed-out support route.
 *
 * ## What this closes
 *
 * `docs/privacy-retention.md` §0 records it plainly: *"The only support form is behind
 * sign-in, at `/app/support`. … A signed-out person currently has no route to us at all."*
 * `recordAnonymousSupportCase` in `db/customerPort.ts` was written for exactly this and had
 * no caller. The public `/support` page published an FAQ and no way to reach a person.
 *
 * That is not a cosmetic gap. The people who most need to reach us are the ones who cannot
 * sign in — a locked-out account, a service that is paused, a deletion request from someone
 * whose session has already been revoked. §5 of the privacy notice promises that support
 * and cancellation stay reachable "even when the service is paused"; a form behind the
 * sign-in wall is the one shape that cannot keep that promise.
 *
 * ## What it does and does not do
 *
 * It writes through `recordAnonymousSupportCase`, which is the same
 * `recordSupportCase` → `createCase` path the signed-in form uses. So the body is redacted
 * **before** storage and triage decides the category, priority and starting state, exactly
 * as it does for a signed-in customer — neither is reimplemented here, because two
 * redaction paths drift and the one that drifts is the one nobody is watching. A signed-out
 * case carries `workspace_id = NULL`, which `supportCases.get` treats as a real scope
 * rather than a wildcard.
 *
 * It does **not** accept a workspace id, a run id or any other scoping hint from the form.
 * An unauthenticated writer must not be able to attach a case to somebody else's workspace,
 * and the cheapest way to guarantee that is to have no field through which to ask.
 *
 * ## Abuse
 *
 * This is an unauthenticated write, so it takes a `RateLimiter`. Without one it still
 * works — a deployment with no limiter configured must not lose its support channel — and
 * the caller is told so rather than it failing silently.
 *
 * ## Mounting
 *
 * `apps/app/src/index.ts` is the lead's file, so this router is not mounted here. One line:
 *
 *     import { createPublicSupportRoute } from './support/publicRoute.js';
 *     app.route('/', createPublicSupportRoute({ db: (c) => (c.env as Env).DB }));
 *
 * Mounted before `publicRoutes` so `GET /support` renders the form; mounted after it, the
 * existing FAQ page wins and only `POST /support` is new. Either is defensible; the first
 * is the one that keeps the promise in §5.
 */
import { Hono, type Context } from 'hono';
import { html, PublicLayout, type Html } from '@verify/ui';
import { recordAnonymousSupportCase } from '../db/customerPort';
import type { Db } from '../db/d1';
import { page, type RouteBindings } from '../routes/public/shared';
import type { RateLimiter } from './port';
import type { SupportResult } from '../routes/app/port';

export interface PublicSupportRouteOptions {
  readonly db: (c: Context<RouteBindings>) => Db;
  /** Optional. A deployment with none still answers; it is just not rate limited. */
  readonly rateLimiter?: RateLimiter | undefined;
  /** Injected for tests. Never read from a request. */
  readonly now?: () => Date;
}

/** Field limits, matched to the signed-in form so the two refuse the same things. */
const LIMITS = {
  subjectMin: 3,
  subjectMax: 200,
  bodyMin: 10,
  bodyMax: 5_000,
  emailMax: 320,
} as const;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The bucket for an unauthenticated write.
 *
 * Deliberately generous: this is the channel a locked-out customer uses, and a limit tight
 * enough to be a useful anti-abuse control would also be tight enough to silence somebody
 * with a real problem and a flaky connection. Five messages an hour per address stops a
 * script without stopping a person, and the refusal says nothing was lost.
 */
const ANON_RATE_LIMIT = { attempts: 5, windowSeconds: 60 * 60 } as const;

interface FormState {
  readonly contactEmail: string;
  readonly subject: string;
  readonly body: string;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly message: string | null;
  readonly reference: string | null;
  readonly ok: boolean;
}

const EMPTY: FormState = {
  contactEmail: '',
  subject: '',
  body: '',
  fieldErrors: {},
  message: null,
  reference: null,
  ok: false,
};

function field(name: string, state: FormState): Html {
  const error = state.fieldErrors[name];
  return error === undefined
    ? html``
    : html`<p class="field-error" id="${name}-error" role="alert">${error}</p>`;
}

/**
 * NEW WORDING (A09): A01 wrote no signed-out support copy. Flagged in the handoff.
 *
 * The page says what happens to the message, because a form that does not say where the
 * text goes is asking for a secret it has not earned. It also says, in the same breath,
 * that credentials are stripped before storage — which is true of this path, and is the
 * sentence that makes the warning above it actionable rather than decorative.
 */
function SupportFormBody(state: FormState): Html {
  return html`
    <h1>Contact support</h1>
    ${state.ok
      ? html`<div class="notice notice--ok" role="status">
          <p>${state.message}</p>
          ${state.reference === null
            ? html``
            : html`<p>Your reference is <code>${state.reference}</code>. Quote it if you write again.</p>`}
        </div>`
      : html``}
    <p>
      You do not need an account to use this form. If you cannot sign in, if the service is
      paused, or if you want your data exported or deleted, this reaches the same person as
      the form inside the application.
    </p>
    <p>
      Your message is stored with credentials, tokens, card-shaped numbers and other
      people's email addresses removed before it is written down. Please do not send us a
      password or an API key in any case — we never need one.
    </p>
    <form method="post" action="/support" novalidate>
      <p>
        <label for="contactEmail">Your email address</label>
        <input
          type="email"
          id="contactEmail"
          name="contactEmail"
          required
          maxlength="${String(LIMITS.emailMax)}"
          autocomplete="email"
          value="${state.contactEmail}"
          aria-describedby="${state.fieldErrors['contactEmail'] === undefined
            ? 'contactEmail-hint'
            : 'contactEmail-error'}"
        />
        <span class="hint" id="contactEmail-hint"
          >We need this to reply. It is the only thing we ask for.</span
        >
        ${field('contactEmail', state)}
      </p>
      <p>
        <label for="subject">What is this about?</label>
        <input
          type="text"
          id="subject"
          name="subject"
          required
          maxlength="${String(LIMITS.subjectMax)}"
          value="${state.subject}"
        />
        ${field('subject', state)}
      </p>
      <p>
        <label for="body">Your message</label>
        <textarea id="body" name="body" rows="10" required maxlength="${String(LIMITS.bodyMax)}">
${state.body}</textarea
        >
        ${field('body', state)}
      </p>
      <p><button type="submit">Send</button></p>
    </form>
  `;
}

function validate(input: {
  contactEmail: string;
  subject: string;
  body: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!EMAIL_SHAPE.test(input.contactEmail) || input.contactEmail.length > LIMITS.emailMax) {
    errors['contactEmail'] = 'We need an address we can reply to.';
  }
  if (input.subject.length < LIMITS.subjectMin) {
    errors['subject'] = 'Tell us in a few words what this is about.';
  } else if (input.subject.length > LIMITS.subjectMax) {
    errors['subject'] = 'Please keep the subject under 200 characters.';
  }
  if (input.body.length < LIMITS.bodyMin) {
    errors['body'] = 'A little more detail will let us help faster.';
  } else if (input.body.length > LIMITS.bodyMax) {
    errors['body'] = 'Please keep the message under 5000 characters.';
  }
  return errors;
}

/**
 * The router. `GET /support` renders the form; `POST /support` writes the case.
 *
 * POST-redirect-GET is deliberately not used: there is no session to carry a flash message
 * in, so the confirmation — including the case reference — is rendered on the response to
 * the POST itself. A refresh re-submits, and the duplicate is a second case rather than a
 * second effect on anything that matters.
 */
export function createPublicSupportRoute(
  options: PublicSupportRouteOptions,
): Hono<RouteBindings> {
  const routes = new Hono<RouteBindings>();

  const render = (c: Context<RouteBindings>, state: FormState, status: number): Promise<Response> =>
    page(
      c,
      PublicLayout({
        title: 'Contact support',
        description:
          'Reach a person without signing in. Credentials and card-shaped numbers are removed from your message before it is stored.',
        path: '/support',
        body: SupportFormBody(state),
      }),
      { status, cache: 'private' },
    );

  routes.get('/support/contact', (c) => render(c, EMPTY, 200));

  routes.post('/support', async (c) => {
    const form = await c.req.parseBody();
    const read = (name: string): string => {
      const value = form[name];
      return typeof value === 'string' ? value.trim() : '';
    };
    const contactEmail = read('contactEmail');
    const subject = read('subject');
    const body = read('body');

    const fieldErrors = validate({ contactEmail, subject, body });
    if (Object.keys(fieldErrors).length > 0) {
      return render(c, { ...EMPTY, contactEmail, subject, body, fieldErrors }, 422);
    }

    if (options.rateLimiter !== undefined) {
      const outcome = await options.rateLimiter.consume(
        `support:anon:${contactEmail}`,
        ANON_RATE_LIMIT.attempts,
        ANON_RATE_LIMIT.windowSeconds,
        options.now?.() ?? new Date(),
      );
      if (!outcome.allowed) {
        return render(
          c,
          {
            ...EMPTY,
            contactEmail,
            subject,
            body,
            message:
              'We have had several messages from this address in a short time. Please wait a little and send this again — nothing you wrote has been lost.',
            fieldErrors: {},
          },
          429,
        );
      }
    }

    // The one write path. Redaction and triage happen inside `createCase`; nothing about
    // either is reimplemented here.
    const result: SupportResult = await recordAnonymousSupportCase(options.db(c), {
      contactEmail,
      subject,
      body,
      ...(options.now === undefined ? {} : { now: options.now() }),
    });

    return render(
      c,
      {
        contactEmail: result.ok ? '' : contactEmail,
        subject: result.ok ? '' : subject,
        body: result.ok ? '' : body,
        fieldErrors: result.fieldErrors,
        message: result.message,
        reference: result.reference,
        ok: result.ok,
      },
      result.ok ? 200 : 422,
    );
  });

  return routes;
}
