/**
 * How it works, Pricing, Security and Support.
 *
 * Every factual sentence on these pages is an A01 content constant. Where a page needs a
 * fact A01 has not written — the owner's contact address, for one — it renders the
 * `TODO_OWNER_INPUT` placeholder visibly rather than inventing something plausible.
 */
import {
  ACTIVATION_UNAVAILABLE_REASON,
  ACTIVATION_UNAVAILABLE_WHEN,
  ActivationNotice,
  ProviderProofNotice,
  Button,
  ButtonRow,
  UnavailableAction,
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
  ONE_LINE_PROMISE,
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
/*
 * A06's approved policy, imported rather than restated.
 *
 * The founder's requirement was that the payment-recovery window is *displayed before
 * checkout, not discovered afterwards*. A06 built `preCheckoutPanel()` for exactly that and
 * A05 renders it on `/app/onboarding/review` — a page behind a session nobody can currently
 * obtain. So on the one page a prospective customer can actually read, the price, the
 * renewal terms, the cancellation terms and the tax treatment were all disclosed, and what
 * happens when a payment fails was not.
 *
 * `policy.ts` is pure: it reads no request, no clock and no binding, so importing it into a
 * public page adds nothing to a page that must stay safe to serve anonymously. Every number
 * and sentence below comes from the constant; nothing here is retyped, so a change to the
 * approved policy changes this page or fails CUST-334.
 */
import { PAYMENT_RECOVERY_POLICY } from '../../billing/policy.js';
import { FaqAll, FaqList, findFaq } from './faq.js';
import { statusCards } from './home.js';
import { TodoOwnerInput } from './todo.js';

function pageHead(eyebrow: string, title: string, lede: string): Html {
  return html`<div class="stack-sm">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="lede measure">${lede}</p>
  </div>`;
}

/* ------------------------------------------------------------------ how it works */

/**
 * One FAQ entry as a pane: the question is the heading, the answer is the body.
 *
 * The approved reference opens this screen with two panes side by side — the automation's
 * own report on the left, the independent read-back on the right. The two entries that
 * make that contrast in A01's own words are the error-alerts question (we do not watch the
 * automation; we read the providers back) and the modify-anything question (we only ever
 * read). Nothing is written here; the panes are a frame for sentences that already exist.
 */
function faqPane(id: string): Html {
  const entry = findFaq(id);
  return html`<div class="pane" id="faq-${entry.id}">
    <h3>${entry.question}</h3>
    <p>${entry.answer}</p>
  </div>`;
}

/**
 * Composition follows the approved how-it-works / demonstration screen: a framed hero
 * panel carrying the head and a two-pane split; a section head; the three steps as three
 * cards across; the four statuses as four tiles inside one panel; the exclusions as a
 * ruled reading column inside a panel; then the questions, the standing limitations and a
 * closing band with the calls to action. The reference markup's copy is NOT carried over —
 * it names competitors, a certification and a trial this business does not have. Every
 * sentence below is A01's or was already on this route.
 */
export function HowItWorksPage(): Html {
  return html`<div class="wrap section stack-lg">
    <section class="panel">
      <div class="panel__intro">
        ${pageHead(
          'How it works',
          'Three steps, and the setup work each one really needs',
          'This page is the long version. Nothing here is a summary of a feature we have not built. If a step sounds like work, it is work.',
        )}
      </div>
      <div class="split">
        ${faqPane('different-from-automation-error-alerts')}
        ${faqPane('do-you-modify-anything')}
      </div>
    </section>

    <!-- Before the steps, not after them. Step 1 and step 3 are both "we read your
         provider back"; a reader must not finish those sentences and only then learn how
         that has been proven. -->
    ${ProviderProofNotice()}

    <section class="stack">
      <div class="section-head">
        <div class="section-head__text">
          <p class="eyebrow">Three steps</p>
          <h2>What setting this up actually involves</h2>
        </div>
      </div>
      <!-- The numbered list, not three cards across.
           It was the reference's three-across arrangement, which is the generic
           three-feature-card row the owner's exclusions name. The home page carries the
           same three steps and was recomposed the same way on the same day, so a reader
           who lands on the short version and clicks through to the long one meets the
           same device twice rather than two arrangements of one idea. -->
      <ol class="steps">
        ${HOME_HOW_IT_WORKS.map(
          (step) => html`<li>
            <h3>${step.title}</h3>
            <p>${step.description}</p>
          </li>`,
        )}
      </ol>
    </section>

    <section class="stack">
      <h2>What you need before day one</h2>
      <div class="split">
        <p class="small muted">${findFaq('what-do-i-need-before-starting').answer}</p>
        <!-- The answer above used to end "see our onboarding guide for the exact steps",
             and this callout existed to contradict it. The answer itself now says there is
             no guide, so the correction only has to say where the instructions are. -->
        ${Callout({
          tone: 'limit',
          title: 'This page is the guide',
          body: html`<p>
            There is no separate step-by-step onboarding document, and we would rather say so than link
            to one that does not exist. The steps above are the full instructions as far as they go; ask
            us if a step is unclear.
          </p>`,
        })}
      </div>
    </section>

    <!-- Four tiles in one panel, four across at desktop. Counting them is how a reader
         learns there are exactly four; a 2x2 reads as two pairs. -->
    <section class="panel">
      <h2>What we report</h2>
      <div class="grid grid-4">
        ${STATUS_DEFINITIONS.map(
          (definition) => html`<div class="tile" data-status-tile="${definition.status}">
            ${StatusBadge({ status: definition.status })}
            <p class="small muted">${definition.description}</p>
          </div>`,
        )}
      </div>
    </section>

    <section class="panel">
      <h2>What this does not do</h2>
      <div class="rule-list">
        ${HOME_WHAT_THIS_DOES_NOT_DO.map(
          (item) => html`<div>
            <h3>${item.heading}</h3>
            <p>${item.body}</p>
          </div>`,
        )}
      </div>
    </section>

    <section class="stack">
      <h2>Questions people ask first</h2>
      ${FaqList([
        'run-never-started',
        'what-is-coverage-mode',
        'evidence-source-down',
        'is-this-real-time',
        'accepted-vs-delivered',
      ])}
    </section>

    ${StandingLimitations()}
    <div class="cta-band">
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
  </div>`;
}

/* ---------------------------------------------------------------------- pricing */

/**
 * What happens if a payment fails — on the page a buyer reads before deciding.
 *
 * Rendered as an ordinary section, not behind a `<details>`: a policy a customer has to
 * open to find is one they will meet for the first time when their card has already
 * failed, which is the thing the founder asked us not to do.
 *
 * Every sentence comes from `PAYMENT_RECOVERY_POLICY`. The heading is the only prose
 * written here, and it carries no number.
 */
function PaymentRecoveryDisclosure(): Html {
  const policy = PAYMENT_RECOVERY_POLICY;
  return html`<section class="stack" data-payment-recovery>
    <h2>If a payment fails</h2>
    <p class="measure">${policy.headline}</p>
    <!-- Two ruled columns, not two cards in a stretched grid.
         whatPauses has one line and whatStaysAvailable has six, so as equal-height cards
         the left one drew a box two thirds empty, which reads as a panel that failed to
         load rather than as good news. Each column is now sized by its own content under
         a rule, and the contrast between one short list and one long one becomes the
         point instead of a layout fault: very little stops.
         (No backticks in this comment. It sits inside a template literal.) -->
    <div class="grid grid-2 grid-top">
      <div class="ruled-col">
        <h3>What pauses</h3>
        <ul class="stack-sm small muted">
          ${policy.whatPauses.map((line) => html`<li>${line}</li>`)}
        </ul>
      </div>
      <div class="ruled-col">
        <h3>What keeps working</h3>
        <ul class="stack-sm small muted">
          ${policy.whatStaysAvailable.map((line) => html`<li>${line}</li>`)}
        </ul>
      </div>
    </div>
    ${Callout({
      tone: 'limit',
      title: `After ${policy.graceDays} days`,
      body: html`<p>${policy.afterWindow}</p>
        <p>${policy.dataHandling}</p>`,
    })}
  </section>`;
}

/**
 * The pricing page, composed as the approved pricing design lays it out
 * (`design/stitch/screens/batch-02/.../pricing_policy_itisyou_verify`): a left-aligned
 * page head; a main grid split seven to five, with the plan card and the payment-failure
 * policy in the wider column and the purchase summary in the narrower one; then the four
 * results as a row of cards, the questions two abreast, and the standing limitations.
 *
 * The plan card carries the price in its head, opposite the plan name, and the allowance
 * as a bar of metrics rather than a table. Every figure is the frozen contract's; the
 * design's own prices, top-ups, seat wording and trial are not here and must not be.
 */
export function PricingPage(): Html {
  const runsIncluded = PLAN_ALLOWANCE.find((line) => line.label === 'Runs included');
  return html`<div class="wrap section stack-lg">
    <!-- The head sits opposite the contract in one line, rather than alone above a third
         of a screen of empty column. The lede is held to the reading measure, which is
         why the space existed; the fix is to put something true in it rather than to
         widen prose past the width it is readable at. Bottoms align, as every other
         section head on the site does. -->
    <div class="section-head">
      ${pageHead(
        'Pricing',
        'One plan, one workflow, no overage',
        'The price is the price. If you use the whole allowance we stop accepting events rather than billing you more.',
      )}
      <p class="micro mono">
        ${PLAN_PRICE_DISPLAY} ${PLAN_BILLING_PERIOD} · ${LIMITS.PLAN_RUNS_PER_PERIOD} runs · one workflow ·
        HubSpot and Resend
      </p>
    </div>

    ${ActivationNotice()}

    <div class="grid grid-7-5">
      <div class="stack">
        ${Card({
          title: PLAN_NAME,
          headingLevel: 2,
          aside: html`<p class="price">
            <span class="price__amount">${PLAN_PRICE_DISPLAY}</span>
            <span class="price__period">${PLAN_BILLING_PERIOD}</span>
          </p>`,
          body: html`<div class="stack">
            <dl class="metrics" aria-label="What the ${PLAN_NAME} plan includes">
              ${PLAN_ALLOWANCE.map(
                (line) => html`<div>
                  <dt>${line.label}</dt>
                  <dd>${line.value}</dd>
                </div>`,
              )}
            </dl>
            ${Callout({ tone: 'limit', title: 'When you reach the allowance', body: html`<p>${PLAN_AT_ALLOWANCE}</p>` })}
            <div class="grid grid-2">
              ${Callout({ tone: 'note', title: 'Renewal', body: html`<p>${PLAN_RENEWAL_WORDING}</p>` })}
              ${Callout({ tone: 'note', title: 'Cancelling', body: html`<p>${PLAN_CANCELLATION_WORDING}</p>` })}
            </div>
          </div>`,
        })}
      </div>
      <div class="stack">
        ${Card({
          title: 'Your order',
          headingLevel: 2,
          body: html`<div class="stack">
            <dl class="summary">
              <div>
                <dt>Plan</dt>
                <dd>${PLAN_NAME}</dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>${PLAN_PRICE_DISPLAY} ${PLAN_BILLING_PERIOD}</dd>
              </div>
              ${runsIncluded === undefined
                ? null
                : html`<div>
                    <dt>${runsIncluded.label}</dt>
                    <dd>${runsIncluded.value}</dd>
                  </div>`}
            </dl>
            ${UnavailableAction({
              label: 'Start setting this up',
              reason: ACTIVATION_UNAVAILABLE_REASON,
              whenBack: ACTIVATION_UNAVAILABLE_WHEN,
            })}
            ${Callout({ tone: 'limit', title: 'Tax', body: html`<p>${PLAN_TAXES_NOTE}</p>` })}
          </div>`,
        })}
      </div>
    </div>

    <!-- Full width, below the grid, rather than stacked under the plan inside the wider
         column. The plan card and the order summary finish within a few pixels of each
         other, so the grid is balanced on its own; the payment-failure policy underneath
         it was what made the left column run half a screen past the right and leave a
         tall empty gutter beside it. Out here its two columns also get the full measure
         instead of seven twelfths of it. -->
    ${PaymentRecoveryDisclosure()}

    <section class="stack">
      <div class="section-head">
        <div class="section-head__text">
          <p class="eyebrow">Four results, never a fifth</p>
          <h2>What we report</h2>
        </div>
        <p class="small muted">${ONE_LINE_PROMISE}</p>
      </div>
      ${statusCards()}
    </section>

    <section class="stack">
      <h2>Pricing questions</h2>
      <div class="faq-grid">
        ${FaqList([
          'what-counts-as-a-run',
          'what-happens-over-allowance',
          'how-cancel',
          'invite-team',
          'tax-and-currency',
        ])}
      </div>
    </section>

    ${StandingLimitations()}
  </div>`;
}

/* --------------------------------------------------------------------- security */

/**
 * There is no Stitch screen for this route (docs/stitch-mapping.md has no row for
 * /security), so the composition borrows the how-it-works / demonstration screen's rhythm:
 * a framed hero panel whose split carries the two notices that qualify everything below
 * it; the data flow as numbered cards three across; the subprocessor table in a framed
 * results panel with a count bar; retention and access side by side; the standing
 * limitations last. Not one claim is added. The reference screens' "trust" footers name a
 * certification this business does not hold, and that is exactly why this page keeps
 * saying so in the hero rather than gaining a badge.
 */
export function SecurityPage(): Html {
  return html`<div class="wrap section stack-lg">
    <section class="panel">
      <div class="panel__intro">
        ${pageHead(
          'Security and data handling',
          'Where your data goes, and who else touches it',
          'The whole list, including the parts that are not ours. We hold no certification and do not claim one.',
        )}
      </div>
      <div class="split">
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
        ${ProviderProofNotice()}
      </div>
    </section>

    <section class="stack">
      <h2>The data flow, end to end</h2>
      <!-- The numbered list, not a card grid. Six cards across three columns is a weaker
           match for the excluded three-feature-card row than the two this page's siblings
           carried, and an independent review was right that it is the same device: a card
           grid is markup, so the token-layer fix could not reach it. It is also a genuine
           sequence, which is what .steps is for, and DATA_FLOW carries its own order. -->
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
      <div class="results">
        ${Table({
          caption:
            'Every third party that processes data on our behalf, what it does, and what it sees',
          columns: [
            { key: 'name', header: 'Subprocessor', rowHeader: true, cell: (row) => row.name },
            { key: 'role', header: 'Role', cell: (row) => row.role },
            { key: 'data', header: 'Data involved', cell: (row) => row.dataInvolved },
          ],
          rows: SUBPROCESSORS,
        })}
        <div class="results__bar">
          <p class="micro mono">${SUBPROCESSORS.length} subprocessors</p>
        </div>
      </div>
    </section>

    <div class="split">
      <section class="stack">
        <h2>Retention</h2>
        ${Callout({ tone: 'note', body: html`<p>${EVIDENCE_RETENTION_NOTE}</p>` })}
      </section>

      <section class="stack">
        <h2>Access we ask for</h2>
        ${FaqList(['store-customer-data', 'do-you-modify-anything', 'data-used-to-train', 'how-long-evidence-kept'])}
      </section>
    </div>

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
      Button({
        label: 'Send a message from your workspace',
        href: '/app/support',
        variant: 'primary',
      }),
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
