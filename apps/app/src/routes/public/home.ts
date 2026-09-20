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
 * The section order, column counts and hero structure follow the approved landing design
 * (`design/stitch/screens/batch-02/.../itisyou_verify_ground_truth_automation_verification_for_agencies`):
 * a centred single-column hero with the evidence card full width beneath the calls to
 * action; the four statuses as a row of four cards inside a band; a card grid of the
 * exclusions; the three steps as a row of three cards with the qualifying notice as a
 * banner beneath; and a centred closing call to action. What was NOT taken from that
 * file is any of its copy: it carries prices, a trial, a certification and named
 * competitors that are not ours. Layout only. `scripts/scan-claims.mjs` is the gate.
 */
import {
  Button,
  ButtonRow,
  Card,
  ActivationNotice,
  ProviderProofNotice,
  ClaimRule,
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
 * One centred column, as drawn: eyebrow, headline, subhead, the two calls to action, the
 * plan line, and then the evidence card at full width. The card and the notice keep
 * left-aligned text inside a centred section.
 */
function hero(): Html {
  return html`<section class="section">
    <div class="wrap stack center">
      <!-- Before the first call to action, deliberately. A visitor must not read the
           headline, form an intention, and only then learn we cannot serve them. -->
      <div class="hero-card">${ActivationNotice()}</div>
      <div class="stack hero-copy">
        <p class="eyebrow">Independent verification of one automation</p>
        <!-- The accent falls on the clause that is the product's argument, which is a
             decision made in the content module rather than by where a span sits here. -->
        <h1 class="display">
          ${HOME_HEADLINE_LEAD} <span class="accent">${HOME_HEADLINE_ACCENT}</span>
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
      <div class="hero-card stack-sm">
        ${ClaimRule({
          status: 'FAILED',
          claim:
            'enquiry enq_0000000000000001 → contact created, acknowledgement sent to a**@example.test',
          observed:
            'contact crm-rec-1 created 30s after the enquiry; acknowledgement to a**@example.test status "bounced"',
        })}
        <p class="micro">
          A synthetic example. The same record, read back from HubSpot and Resend, is what decides the
          verdict — not the automation's own report.
        </p>
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
      <div class="stack-sm center">
        <p class="eyebrow">Three steps</p>
        <h2>What setting this up actually involves</h2>
      </div>
      <!-- Three cards in a row at desktop width, one under another below it. Still an
           ordered list: the number on each card is the counter, not decoration. The same
           card row the how-it-works screen uses, so a step looks the same on both. -->
      <ol class="step-cards grid grid-3">
        ${HOME_HOW_IT_WORKS.map(
          (step) => html`<li class="card step-card">
            <h3>${step.title}</h3>
            <p>${step.description}</p>
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
      <div class="grid grid-3">
        ${HOME_WHAT_THIS_DOES_NOT_DO.map((item) =>
          Card({
            title: item.heading,
            headingLevel: 3,
            body: html`<p class="small muted">${item.body}</p>`,
          }),
        )}
      </div>
    </div>
  </section>`;
}

/**
 * The closing call to action, centred as drawn: a heading, its answer, the two controls,
 * and the plan line. The heading and answer are the FAQ entry a buyer needs before
 * starting, which was already the copy here.
 */
function closing(): Html {
  const before = findFaq('what-do-i-need-before-starting');
  return html`<section class="section">
    <div class="wrap stack center">
      <div class="stack-sm hero-copy">
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
