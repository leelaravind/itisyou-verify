/**
 * The home page.
 *
 * Fifteen seconds is the budget. In that time a visitor has to learn what is checked, how
 * it is checked, and — the part most products hide — what is *not* checked. So the page
 * leads with the claim rule: what an automation said, against what we retrieved. Every
 * sentence below the hero comes from A01's content modules verbatim.
 *
 * ## Composition
 *
 * Recomposed on 21 September 2026. The section order still follows the approved landing
 * design (`design/stitch/screens/batch-02/.../itisyou_verify_ground_truth_automation_verification_for_agencies`)
 * because the order is an argument and the order is sound: what we report, what we do not
 * do, what setting it up involves, what you need before you start. Three of its *devices*
 * are gone, because the owner's exclusions override a conflicting reference style and
 * these conflicted:
 *
 *  - the centred single column became a seven-to-five split, copy beside evidence. A
 *    centred hero with a centred lede and centred buttons is the shape every template
 *    ships with, and it pushed the one thing on this page worth reading first, the claim
 *    rule, below the fold on a laptop.
 *  - the exclusions were five cards in a three-across grid, which is a generic
 *    three-feature-card row with an orphan row under it. They are now ruled rows in the
 *    evidence margin, the same device the workspace and run pages use for a finding.
 *  - the three steps were three cards. They are now the numbered `.steps` list the
 *    how-it-works page already uses, so a step looks the same wherever it is read.
 *
 * What was NOT taken from the reference is any of its copy: it carries prices, a trial, a
 * certification and named competitors that are not ours. Layout only.
 * `scripts/scan-claims.mjs` is the gate.
 */
import {
  Button,
  ButtonRow,
  ActivationNotice,
  ProviderProofNotice,
  EvidenceDiff,
  StatusBadge,
  html,
  type Html,
  HOME_HEADLINE_ACCENT,
  HOME_HEADLINE_LEAD,
  HOME_HOW_IT_WORKS,
  HOME_SUBHEAD,
  HOME_WHAT_THIS_DOES_NOT_DO,
  ONE_LINE_PROMISE,
  PLAN_PRICE_DISPLAY,
  STATUS_DEFINITIONS,
  iconArrow,
} from '@verify/ui';
import { LIMITS } from '@verify/contracts';
import { findFaq } from './faq.js';

/** The one-line plan summary that closes both the hero and the page. */
function planLine(): Html {
  return html`<p class="micro mono">
    ${PLAN_PRICE_DISPLAY} a month · ${LIMITS.PLAN_RUNS_PER_PERIOD} runs · one workflow · HubSpot and Resend
  </p>`;
}

/**
 * The hero.
 *
 * The signature device carries the argument rather than a stock illustration: a claim in
 * muted mono, a verdict on the rule, and what we actually retrieved underneath. The values
 * shown are the same synthetic enquiry the demo page uses, so a visitor who clicks through
 * meets something they recognise.
 *
 * Left-aligned, seven to five: eyebrow, headline, subhead, the two calls to action and the
 * plan line in the wider column; the evidence card in the narrower one, beside them rather
 * than below. The notice spans both, above everything, because it qualifies both.
 *
 * The split is the point. The claim rule is the argument this page is making, and under a
 * centred hero it sat below a full-height column of centred prose, which on a 1440 by 900
 * laptop put it under the fold. Beside the headline it is the second thing a reader's eye
 * lands on, which is where it belongs.
 */
function hero(): Html {
  return html`<section class="section">
    <div class="wrap stack-lg">
      <!-- Before the first call to action, deliberately. A visitor must not read the
           headline, form an intention, and only then learn we cannot serve them. It spans
           the full width rather than sitting in a column: it qualifies both of them. -->
      ${ActivationNotice()}
      <div class="stack-lg">
        <div class="stack measure-wide">
          <p class="eyebrow">Independent verification of one automation</p>
          <!-- The accent falls on the clause that is the product's argument, which is a
               decision made in the content module rather than by where a span sits here. -->
          <h1 class="display">
            <span class="display__lead">${HOME_HEADLINE_LEAD}</span>
            <span class="accent">${HOME_HEADLINE_ACCENT}</span>
          </h1>
          <p class="lede measure">${HOME_SUBHEAD}</p>
          <div class="btn-row btn-row--stack">
            ${Button({
              label: 'See a worked example',
              href: '/demo',
              variant: 'primary',
              icon: iconArrow(),
            })}
            ${Button({ label: 'How it works', href: '/how-it-works', variant: 'quiet' })}
          </div>
          ${planLine()}
        </div>
        <div>
          ${EvidenceDiff({
            caption: 'Synthetic example',
            reference: 'enq_0000000000000001',
            reported: [
              { key: 'contact', value: 'created' },
              { key: 'ack email', value: 'sent to a**@example.test' },
              { key: 'http', value: '200, workflow completed' },
            ],
            retrieved: [
              { key: 'contact', value: 'crm-rec-1, created 30s after the enquiry' },
              { key: 'ack email', value: 'a**@example.test, status bounced' },
              { key: 'read at', value: '2026-09-20 11:50 UTC' },
            ],
            status: 'FAILED',
            verdict:
              'The contact exists and carries the right correlation value. The acknowledgement did not reach the address the enquiry named, so this run failed.',
            checks: [
              {
                label: 'The CRM record exists',
                outcome: 'pass',
                detail: 'read back from HubSpot, not from the automation report',
              },
              {
                label: 'It carries the enquiry correlation value',
                outcome: 'pass',
                detail: 'verify_correlation_id = enq_0000000000000001',
              },
              {
                label: 'The acknowledgement reached the recipient',
                outcome: 'fail',
                detail: 'Resend message outcome: bounced',
              },
            ],
            footnote:
              'A synthetic example. The same record, read back from HubSpot and Resend, is what decides the verdict, not the automation own report.',
          })}
        </div>
      </div>
    </div>
  </section>`;
}

/**
 * The four statuses as four cards, one row at desktop width.
 *
 * Shared with the pricing page, which draws the same row under the plan. Each card takes a
 * rule along its top in the status colour; the badge inside it is the signal that
 * survives greyscale and forced colours, and UNVERIFIED's rule is dashed like its badge.
 */
export function statusCards(): Html {
  return html`<div class="grid grid-4">
    ${STATUS_DEFINITIONS.map(
      (definition) =>
        html`<div class="status-card status-card--${definition.status.toLowerCase()}">
          <div>${StatusBadge({ status: definition.status })}</div>
          <p class="small muted">${definition.description}</p>
        </div>`,
    )}
  </div>`;
}

/** The four statuses, in A01's words. This is the product's whole vocabulary. */
function statuses(): Html {
  return html`<section class="section-tight band">
    <div class="wrap stack">
      <!-- The approved band: eyebrow and heading on the left, the one-line promise as the
           qualifying sentence on the right, bottoms aligned. -->
      <div class="section-head">
        <div class="section-head__text">
          <p class="eyebrow">Four results, never a fifth</p>
          <h2>What we report</h2>
        </div>
        <p class="small muted">${ONE_LINE_PROMISE}</p>
      </div>
      <!-- Four across at desktop width, per the approved design. Counting them is how a
           reader learns there are exactly four, which is the section's whole claim. -->
      ${statusCards()}
    </div>
  </section>`;
}

/** Connect, define, receive. A genuine sequence, so it is genuinely numbered. */
function howItWorks(): Html {
  return html`<section class="section">
    <div class="wrap stack-lg">
      <div class="stack-sm">
        <p class="eyebrow">Three steps</p>
        <h2>What setting this up actually involves</h2>
      </div>
      <!-- The numbered list, not three cards across. It is a real sequence: step 2 cannot
           be done before step 1, and a row of equal cards says the opposite. Each step
           takes a hairline above it and its number in the gutter, which is the same
           device the how-it-works page uses, so a step looks the same wherever it is read. -->
      <ol class="steps">
        ${HOME_HOW_IT_WORKS.map(
          (step) => html`<li>
            <h3>${step.title}</h3>
            <p>${step.description}</p>
            <div class="snip">
              <p class="snip__caption">${step.shape.caption}</p>
              <ul class="snip__lines">
                ${step.shape.lines.map((line) => html`<li>${line}</li>`)}
              </ul>
            </div>
          </li>`,
        )}
      </ol>
      <!-- Directly under step 3, which is the sentence it qualifies: "We read the record
           and the email status back ourselves". That code is written and tested and has
           never been pointed at a real HubSpot or Resend account. A reader who takes step 3
           at face value has been misled by omission, so the correction sits against the
           claim rather than in a footer. -->
      ${ProviderProofNotice()}
      ${ButtonRow([Button({ label: 'Read the full setup requirements', href: '/how-it-works' })])}
    </div>
  </section>`;
}

/**
 * The exclusions, given the same weight as the features.
 *
 * This is the section most products bury. Here it gets its own full-width band, because a
 * customer who discovers a limitation after paying is a refund and a bad review, and
 * because a product about honesty that hides its own limits has already lost the argument.
 *
 * It sits before the three steps, where the approved design puts its card grid: a reader
 * learns what is out of scope before learning what setting it up involves.
 */
function exclusions(): Html {
  return html`<section class="section band">
    <div class="wrap stack-lg">
      <div class="section-head">
        <div class="section-head__text">
          <p class="eyebrow">Read this before you buy</p>
          <h2>What this does not do</h2>
        </div>
      </div>
      <!-- Ruled rows in the evidence margin, not a grid of cards.
           Five items in a three-across grid leaves an orphan row of two, and a row of
           equal cards is the arrangement the owner's exclusions name outright. The margin
           is this interface's own device for "here is a finding, here is what it means",
           which is exactly the shape of each of these: a boundary, and why it is there.
           It also lets a reader scan the five headings down one column without their eye
           tracking back across a grid. -->
      <div data-exclusions>
        ${HOME_WHAT_THIS_DOES_NOT_DO.map(
          (item) => html`<div class="margin-row margin-row--wide">
            <div class="margin-row__gutter"><h3>${item.heading}</h3></div>
            <p class="small muted">${item.body}</p>
          </div>`,
        )}
      </div>
    </div>
  </section>`;
}

/**
 * The closing call to action: a heading, its answer, the two controls, and the plan line.
 * The heading and answer are the FAQ entry a buyer needs before starting, which was
 * already the copy here.
 *
 * Left-aligned now, like every other section. It was centred, and a centred block of
 * prose at the foot of a left-aligned page reads as a different page's footer rather than
 * as this page's conclusion.
 */
function closing(): Html {
  const before = findFaq('what-do-i-need-before-starting');
  return html`<section class="section">
    <div class="wrap stack">
      <div class="stack-sm">
        <h2>${before.question}</h2>
        <p class="small muted measure">${before.answer}</p>
      </div>
      <div class="btn-row btn-row--stack">
        ${Button({
          label: 'See a worked example',
          href: '/demo',
          variant: 'primary',
          icon: iconArrow(),
        })}
        ${Button({ label: 'See the price', href: '/pricing', variant: 'quiet' })}
      </div>
      ${planLine()}
    </div>
  </section>`;
}

export function HomePage(): Html {
  return html`${hero()}${statuses()}${exclusions()}${howItWorks()}${closing()}`;
}
