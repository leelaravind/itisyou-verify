/**
 * The home page.
 *
 * Fifteen seconds is the budget. In that time a visitor has to learn what is checked, how
 * it is checked, and — the part most products hide — what is *not* checked. So the page
 * leads with the claim rule: what an automation said, against what we retrieved. Every
 * sentence below the hero comes from A01's content modules verbatim.
 */
import {
  Button,
  ButtonRow,
  Callout,
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

/**
 * The hero.
 *
 * The signature device carries the argument rather than a stock illustration: a claim in
 * muted mono, a verdict on the rule, and what we actually retrieved underneath. The values
 * shown are the same synthetic enquiry the demo page uses, so a visitor who clicks through
 * meets something they recognise.
 */
function hero(): Html {
  return html`<section class="section">
    <div class="wrap stack">
      <!-- Before the first call to action, deliberately. A visitor must not read the
           headline, form an intention, and only then learn we cannot serve them. -->
      ${ActivationNotice()}
      <div class="grid grid-2 grid-center grid-wide-gap">
        <div class="stack">
          <p class="eyebrow">Independent verification of one automation</p>
          <!-- The accent falls on the clause that is the product's argument, which is a
               decision made in the content module rather than by where a span sits here. -->
          <h1 class="display">
            ${HOME_HEADLINE_LEAD} <span class="accent">${HOME_HEADLINE_ACCENT}</span>
          </h1>
          <p class="lede measure">${HOME_SUBHEAD}</p>
          ${ButtonRow([
            Button({
              label: 'See a worked example',
              href: '/demo',
              variant: 'primary',
              icon: iconArrow(),
            }),
            Button({ label: 'How it works', href: '/how-it-works', variant: 'quiet' }),
          ])}
          <p class="micro mono">
            ${PLAN_PRICE_DISPLAY} a month · ${LIMITS.PLAN_RUNS_PER_PERIOD} runs · one workflow · HubSpot and Resend
          </p>
        </div>
        <div class="stack-sm">
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
    </div>
  </section>`;
}

/** The four statuses, in A01's words. This is the product's whole vocabulary. */
function statuses(): Html {
  return html`<section class="section-tight band">
    <div class="wrap stack">
      <div class="stack-sm">
        <p class="eyebrow">Four results, never a fifth</p>
        <h2>${ONE_LINE_PROMISE}</h2>
      </div>
      <div class="grid grid-2">
        ${STATUS_DEFINITIONS.map(
          (definition) =>
            html`<div class="margin-row">
              <div class="margin-row__gutter">${StatusBadge({ status: definition.status })}</div>
              <p class="small muted">${definition.description}</p>
            </div>`,
        )}
      </div>
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
      <ol class="steps">
        ${HOME_HOW_IT_WORKS.map(
          (step) => html`<li>
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
 */
function exclusions(): Html {
  return html`<section class="section band">
    <div class="wrap stack-lg">
      <div class="stack-sm">
        <p class="eyebrow">Read this before you buy</p>
        <h2>What this does not do</h2>
      </div>
      <div class="grid grid-2">
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

function closing(): Html {
  return html`<section class="section">
    <div class="wrap stack">
      ${Callout({
        tone: 'limit',
        title: findFaq('what-do-i-need-before-starting').question,
        body: html`<p>${findFaq('what-do-i-need-before-starting').answer}</p>`,
      })}
      ${ButtonRow([
        Button({
          label: 'See a worked example',
          href: '/demo',
          variant: 'primary',
          icon: iconArrow(),
        }),
        Button({ label: 'See the price', href: '/pricing', variant: 'quiet' }),
      ])}
    </div>
  </section>`;
}

export function HomePage(): Html {
  return html`${hero()}${statuses()}${howItWorks()}${exclusions()}${closing()}`;
}
