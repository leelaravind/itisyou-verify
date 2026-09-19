/**
 * How it works, Pricing, Security and Support.
 *
 * Every factual sentence on these pages is an A01 content constant. Where a page needs a
 * fact A01 has not written — the owner's contact address, for one — it renders the
 * `TODO_OWNER_INPUT` placeholder visibly rather than inventing something plausible.
 */
import {
  Button,
  ButtonRow,
  Callout,
  Card,
  StandingLimitations,
  StatusBadge,
  Table,
  html,
  type Html,
  DATA_FLOW,
  EVIDENCE_RETENTION_NOTE,
  HOME_HOW_IT_WORKS,
  HOME_WHAT_THIS_DOES_NOT_DO,
  OWNER_LEGAL_IDENTITY,
  PLAN_ALLOWANCE,
  PLAN_AT_ALLOWANCE,
  PLAN_BILLING_PERIOD,
  PLAN_CANCELLATION_WORDING,
  PLAN_NAME,
  PLAN_PRICE_DISPLAY,
  PLAN_RENEWAL_WORDING,
  PLAN_TAXES_NOTE,
  STATUS_DEFINITIONS,
  SUBPROCESSORS,
  iconArrow,
} from '@verify/ui';
import { LIMITS } from '@verify/contracts';
import { FaqAll, FaqList, findFaq } from './faq.js';
import { TodoOwnerInput } from './todo.js';

function pageHead(eyebrow: string, title: string, lede: string): Html {
  return html`<div class="stack-sm">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="lede measure">${lede}</p>
  </div>`;
}

/* ------------------------------------------------------------------ how it works */

export function HowItWorksPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'How it works',
      'Three steps, and the setup work each one really needs',
      'This page is the long version. Nothing here is a summary of a feature we have not built — if a step sounds like work, it is work.',
    )}

    <ol class="steps">
      ${HOME_HOW_IT_WORKS.map(
        (step) => html`<li>
          <h3>${step.title}</h3>
          <p>${step.description}</p>
        </li>`,
      )}
    </ol>

    <section class="stack">
      <h2>What you need before day one</h2>
      <p class="small muted measure">${findFaq('what-do-i-need-before-starting').answer}</p>
      ${Callout({
        tone: 'limit',
        title: 'There is no onboarding guide published yet',
        body: html`<p>
          The setup steps above are complete as far as they go, but the step-by-step guide the answer
          refers to has not been written. Until it is, treat this page as the full instructions and ask
          us if a step is unclear.
        </p>`,
      })}
    </section>

    <section class="stack">
      <h2>What we report</h2>
      <div class="grid grid-2">
        ${STATUS_DEFINITIONS.map(
          (definition) => html`<div class="margin-row">
            <div class="margin-row__gutter">${StatusBadge({ status: definition.status })}</div>
            <p class="small muted">${definition.description}</p>
          </div>`,
        )}
      </div>
    </section>

    <section class="stack">
      <h2>What this does not do</h2>
      <div class="grid grid-2">
        ${HOME_WHAT_THIS_DOES_NOT_DO.map((item) =>
          Card({ title: item.heading, body: html`<p class="small muted">${item.body}</p>` }),
        )}
      </div>
    </section>

    <section class="stack">
      <h2>Questions people ask first</h2>
      ${FaqList([
        'different-from-automation-error-alerts',
        'run-never-started',
        'what-is-coverage-mode',
        'evidence-source-down',
        'is-this-real-time',
        'accepted-vs-delivered',
      ])}
    </section>

    ${StandingLimitations()}
    ${ButtonRow([
      Button({ label: 'See a worked example', href: '/demo', variant: 'primary', icon: iconArrow() }),
      Button({ label: 'See the price', href: '/pricing', variant: 'quiet' }),
    ])}
  </div>`;
}

/* ---------------------------------------------------------------------- pricing */

export function PricingPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'Pricing',
      'One plan, one workflow, no overage',
      'The price is the price. If you use the whole allowance we stop accepting events rather than billing you more.',
    )}

    <div class="grid grid-2">
      ${Card({
        title: PLAN_NAME,
        headingLevel: 2,
        body: html`<div class="stack">
          <p class="price">
            <span class="price__amount">${PLAN_PRICE_DISPLAY}</span>
            <span class="price__period">${PLAN_BILLING_PERIOD}</span>
          </p>
          ${Table({
            caption: `What the ${PLAN_NAME} plan includes`,
            captionHidden: true,
            columns: [
              { key: 'label', header: 'Included', rowHeader: true, cell: (line) => line.label },
              { key: 'value', header: 'Amount', numeric: true, cell: (line) => line.value },
            ],
            rows: PLAN_ALLOWANCE,
          })}
          ${ButtonRow([Button({ label: 'Start setting this up', href: '/app', variant: 'primary' })])}
        </div>`,
      })}
      <div class="stack">
        ${Callout({ tone: 'limit', title: 'When you reach the allowance', body: html`<p>${PLAN_AT_ALLOWANCE}</p>` })}
        ${Callout({ tone: 'note', title: 'Renewal', body: html`<p>${PLAN_RENEWAL_WORDING}</p>` })}
        ${Callout({ tone: 'note', title: 'Cancelling', body: html`<p>${PLAN_CANCELLATION_WORDING}</p>` })}
        ${Callout({ tone: 'limit', title: 'Tax', body: html`<p>${PLAN_TAXES_NOTE}</p>` })}
      </div>
    </div>

    <section class="stack">
      <h2>Pricing questions</h2>
      ${FaqList([
        'what-counts-as-a-run',
        'what-happens-over-allowance',
        'how-cancel',
        'invite-team',
        'tax-and-currency',
      ])}
    </section>

    ${StandingLimitations()}
  </div>`;
}

/* --------------------------------------------------------------------- security */

export function SecurityPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'Security and data handling',
      'Where your data goes, and who else touches it',
      'The whole list, including the parts that are not ours. We hold no certification and do not claim one.',
    )}

    ${Callout({
      tone: 'limit',
      title: 'Certifications',
      body: html`<p>
        ${TodoOwnerInput({
          field: 'certifications',
          value: OWNER_LEGAL_IDENTITY.certifications,
          explanation:
            'We make no accuracy, security or uptime certification. Any certification claimed here must be one the owner actually holds and can evidence.',
        })}
      </p>`,
    })}

    <section class="stack">
      <h2>The data flow, end to end</h2>
      <ol class="steps">
        ${DATA_FLOW.map(
          (stage) => html`<li>
            <h3>${stage.stage}</h3>
            <p>${stage.description}</p>
          </li>`,
        )}
      </ol>
    </section>

    <section class="stack">
      <h2>Subprocessors</h2>
      ${Table({
        caption: 'Every third party that processes data on our behalf, what it does, and what it sees',
        columns: [
          { key: 'name', header: 'Subprocessor', rowHeader: true, cell: (row) => row.name },
          { key: 'role', header: 'Role', cell: (row) => row.role },
          { key: 'data', header: 'Data involved', cell: (row) => row.dataInvolved },
        ],
        rows: SUBPROCESSORS,
      })}
    </section>

    <section class="stack">
      <h2>Retention</h2>
      ${Callout({ tone: 'note', body: html`<p>${EVIDENCE_RETENTION_NOTE}</p>` })}
    </section>

    <section class="stack">
      <h2>Access we ask for</h2>
      ${FaqList(['store-customer-data', 'do-you-modify-anything', 'data-used-to-train', 'how-long-evidence-kept'])}
    </section>

    ${StandingLimitations()}
  </div>`;
}

/* ---------------------------------------------------------------------- support */

export function SupportPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'Support',
      'Answers first, then a person',
      'Most questions here are about what this product deliberately does not do, so the answers are worth reading before you write to us.',
    )}

    ${Callout({
      tone: 'todo',
      title: 'How to reach us',
      body: html`<p>
        ${TodoOwnerInput({
          field: 'contactEmailForLegalNotices',
          value: OWNER_LEGAL_IDENTITY.contactEmailForLegalNotices,
          explanation:
            'The support address has not been published yet. If you already have an account you can send us a message from inside your workspace, which reaches the same place.',
        })}
      </p>`,
    })}

    ${ButtonRow([
      Button({ label: 'Send a message from your workspace', href: '/app/support', variant: 'primary' }),
    ])}

    <section class="stack">
      <h2>Frequently asked questions</h2>
      <p class="small muted measure">
        ${LIMITS.PLAN_RUNS_PER_PERIOD} runs a month, one workflow, HubSpot and Resend. Everything below
        describes what that actually covers.
      </p>
      ${FaqAll()}
    </section>

    ${StandingLimitations()}
  </div>`;
}
