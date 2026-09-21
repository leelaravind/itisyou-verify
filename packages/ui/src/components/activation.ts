/**
 * The service activation notice, and the way a closed path says it is closed.
 *
 * ## Why this exists
 *
 * This comment used to open by stating that `POST /api/v1/events` was not mounted. It is
 * mounted now: `apps/app/src/index.ts` routes it and `apps/app/src/money/eventsRoute.ts`
 * answers it. Leaving the old sentence standing would have been the very defect this
 * module exists to prevent, one level down, so it is corrected rather than kept for
 * history.
 *
 * What is still true, and is what the notice now says, is narrower: live payments are
 * switched off until the owner turns them on separately, and public signup is closed.
 * While that holds, a page that invites a stranger to hand over a card is making a claim
 * the system cannot honour. The description stays up, because the description is true and
 * the checking logic behind it is real and tested. The transaction comes down.
 *
 * A01 owns the wording and it is rendered verbatim. When the gaps are wired, this stops
 * being rendered because it stops being *true* — not because it stops being convenient.
 */
import { attrs, html, type Html } from '../html.js';
import { PROVIDER_PROOF_NOTICE, SERVICE_ACTIVATION_NOTICE } from '../content/site.js';
import { Callout } from './card.js';

/**
 * A01's notice, at full size, in the loudest tone the system has.
 *
 * `warn`, not `note`: this is not context, it is the single most important thing a visitor
 * can know today. It is never placed inside a `<details>`, never abbreviated, and on any
 * page that leads toward connecting a real account or paying it comes before the first
 * call to action rather than after it.
 */
export function ActivationNotice(): Html {
  return Callout({
    tone: 'warn',
    title: SERVICE_ACTIVATION_NOTICE.headline,
    body: html`<p data-activation-notice>${SERVICE_ACTIVATION_NOTICE.body}</p>`,
  });
}

/**
 * A01's provider-proof notice, at full size.
 *
 * `limit`, not `warn`: this is a stated boundary of what has been proven, not an outage.
 * It belongs on every page that tells a reader we read their records back from HubSpot and
 * Resend — the home page, how it works, and security — because that sentence is the
 * product, and "we have never actually done this against a real account" is the single most
 * material thing a buyer could want to know about it.
 *
 * Never inside a `<details>`, never abbreviated to "in beta".
 */
export function ProviderProofNotice(): Html {
  return Callout({
    tone: 'limit',
    title: PROVIDER_PROOF_NOTICE.headline,
    body: html`<p data-provider-proof-notice>${PROVIDER_PROOF_NOTICE.body}</p>`,
  });
}

export interface UnavailableActionOptions {
  /** The label the control would have carried. Kept, so the reader sees what is unavailable. */
  readonly label: string;
  /** Why it cannot be used, in the same register as the rest of the interface. */
  readonly reason: string;
  /** When it is expected back, if that can be said honestly. Omitted rather than guessed. */
  readonly whenBack?: string;
}

/**
 * A call to action that has been taken down, shown rather than hidden.
 *
 * Three things it deliberately does *not* do:
 *
 *  - It does not render an `<a>` or a `<button>`. A `<button disabled>` is still a button
 *    that a form could submit if the attribute were ever dropped, and a styled-grey link is
 *    still a link. There is no interactive element here at all.
 *  - It does not silently disappear. A customer who cannot proceed deserves to know that
 *    the step exists, that it is closed, and why — removing the control entirely would
 *    leave them hunting for something that was there yesterday.
 *  - It does not say "coming soon". `whenBack` is rendered only when the caller can say
 *    something true about it.
 */
export function UnavailableAction(options: UnavailableActionOptions): Html {
  return html`<div ${attrs({ class: 'unavailable', 'data-unavailable': options.label })}>
    <p class="unavailable__control" aria-disabled="true" role="note">${options.label}</p>
    <p class="unavailable__reason">${options.reason}</p>
    ${options.whenBack === undefined ? null : html`<p class="unavailable__when">${options.whenBack}</p>`}
  </div>`;
}

/**
 * The standing reason every taken-down activation control gives.
 *
 * Drawn from the same fact as the banner above it, and it drifted anyway: the banner was
 * corrected when the signed-event endpoint went live and this copy was not, so `/pricing`
 * served both sentences at once and one of them was false. "One sentence so they cannot
 * drift apart" was the intention; two constants was the implementation, and the intention
 * does not survive that. Found by the independent auditor on 20 September 2026.
 *
 * It now names the reason that is actually true, which is also the one that matters to
 * somebody about to pay.
 */
export const ACTIVATION_UNAVAILABLE_REASON =
  'We are not taking payment or activating new workspaces yet: live payments are switched off until the owner turns them on separately, and no customer workspace exists on this deployment yet: public signup is closed, and only the owner can create one, by hand. Nothing here is broken on your side.';

/** What we can honestly say about when it returns, which is not a date. */
export const ACTIVATION_UNAVAILABLE_WHEN =
  'This comes back when the notice above comes down. We would rather leave it visibly closed than take money for something we cannot yet deliver.';

/**
 * Why the setup path is closed to *this* reader, when it is closed for a reason about them
 * rather than about the deployment.
 *
 * ## Why this is not `ACTIVATION_UNAVAILABLE_REASON`
 *
 * That constant answers "why can nobody buy this yet": live payments are off and public
 * signup is closed. Both are true, and neither is true of somebody who is already signed
 * in to a workspace. Rendering it to them said "nothing here is broken on your side" while
 * standing in front of a path that works, which is the one thing the notice promised not to
 * do. The server has always refused a viewer's write with its own sentence
 * (`customerPort.saveFieldMapping`, `saveExpectedOutcome`, `submitConnectionCredentials`);
 * this is that same refusal said before the attempt instead of after it.
 */
export const SETUP_UNAVAILABLE_VIEWER_REASON =
  'Your role in this workspace is viewer. You can read everything here, but only a workspace admin can connect a provider or change a workflow, so the setup is not yours to run. Ask whoever invited you to this workspace.';

/** Said to a viewer rather than a date, because nothing is scheduled to change for them. */
export const SETUP_UNAVAILABLE_VIEWER_WHEN =
  'This returns if your role is changed to workspace admin.';
