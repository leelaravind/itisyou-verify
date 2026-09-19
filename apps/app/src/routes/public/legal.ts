/**
 * Terms, Privacy, Cancellation and refunds, and Service status.
 *
 * These pages are a factual skeleton, not finished legal text, and they say so at the top
 * rather than in a footnote. Every `TODO_OWNER_INPUT` field is rendered as a visible gap.
 */
import {
  Callout,
  StandingLimitations,
  Table,
  html,
  type Html,
  DATA_FLOW,
  EVIDENCE_RETENTION_NOTE,
  OWNER_LEGAL_IDENTITY,
  PLAN_ALLOWANCE,
  PLAN_CANCELLATION_WORDING,
  PLAN_NAME,
  PLAN_PRICE_DISPLAY,
  PLAN_RENEWAL_WORDING,
  PLAN_TAXES_NOTE,
  REFUND_POLICY_SUMMARY,
  SUBPROCESSORS,
  TERMS_SKELETON_NOTE,
} from '@verify/ui';
import { LIMITS } from '@verify/contracts';
import { FaqList } from './faq.js';
import { OwnerIdentityList, TodoOwnerInput } from './todo.js';

const OWNER_FIELDS: readonly (readonly [string, string, string])[] = [
  [
    'Registered business name',
    'registeredBusinessName',
    OWNER_LEGAL_IDENTITY.registeredBusinessName,
  ],
  ['Registered address', 'registeredAddress', OWNER_LEGAL_IDENTITY.registeredAddress],
  [
    'Company registration number',
    'companyRegistrationNumber',
    OWNER_LEGAL_IDENTITY.companyRegistrationNumber,
  ],
  ['VAT number', 'vatNumber', OWNER_LEGAL_IDENTITY.vatNumber],
  ['Legal structure', 'legalStructure', OWNER_LEGAL_IDENTITY.legalStructure],
  [
    'Contact for legal notices',
    'contactEmailForLegalNotices',
    OWNER_LEGAL_IDENTITY.contactEmailForLegalNotices,
  ],
];

function skeletonNotice(): Html {
  return Callout({
    tone: 'todo',
    title: 'This page is incomplete, on purpose',
    body: html`<p>${TERMS_SKELETON_NOTE}</p>`,
  });
}

function pageHead(eyebrow: string, title: string, lede: string): Html {
  return html`<div class="stack-sm">
    <p class="eyebrow">${eyebrow}</p>
    <h1>${title}</h1>
    <p class="lede measure">${lede}</p>
  </div>`;
}

export function TermsPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'Terms',
      'Terms of service',
      'A factual skeleton describing what the service does, what it costs, and what it does not promise.',
    )}
    ${skeletonNotice()}

    <section class="stack">
      <h2>Who you are contracting with</h2>
      ${OwnerIdentityList(OWNER_FIELDS)}
    </section>

    <section class="stack">
      <h2>What the service does</h2>
      <p class="measure">
        ${PLAN_NAME} verifies one workflow shape: an enquiry that should create the correct HubSpot record
        and trigger an acknowledgement email through Resend. It reads that evidence back from the connected
        providers itself and reports one of four results. It never modifies your CRM, never sends a
        replacement email, and never repairs your automation.
      </p>
      ${StandingLimitations()}
    </section>

    <section class="stack">
      <h2>What you get, and what it costs</h2>
      ${Table({
        caption: `The ${PLAN_NAME} plan at ${PLAN_PRICE_DISPLAY} per month`,
        columns: [
          { key: 'label', header: 'Included', rowHeader: true, cell: (line) => line.label },
          { key: 'value', header: 'Amount', numeric: true, cell: (line) => line.value },
        ],
        rows: PLAN_ALLOWANCE,
      })}
      <p class="small muted">${PLAN_RENEWAL_WORDING}</p>
      <p class="small muted">${PLAN_TAXES_NOTE}</p>
    </section>

    <section class="stack">
      <h2>Cancelling</h2>
      <p class="measure small muted">${PLAN_CANCELLATION_WORDING}</p>
    </section>

    <section class="stack">
      {/* claim-scan:allow a heading that denies holding a certification or offering a guarantee */}
      <h2>No certification, and no guarantee of a result</h2>
      <p class="measure small muted">
        ${TodoOwnerInput({
          field: 'certifications',
          value: OWNER_LEGAL_IDENTITY.certifications,
        })}
      </p>
    </section>
  </div>`;
}

export function PrivacyPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'Privacy',
      'What we hold, where it goes, and for how long',
      'Six places your data can reach, listed in order, including the one that only exists if you switch it on.',
    )}
    ${skeletonNotice()}

    <section class="stack">
      <h2>Who is responsible for this data</h2>
      ${OwnerIdentityList(OWNER_FIELDS)}
    </section>

    <section class="stack">
      <h2>Where your data goes</h2>
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
        caption: 'Every third party that processes data on our behalf',
        columns: [
          { key: 'name', header: 'Subprocessor', rowHeader: true, cell: (row) => row.name },
          { key: 'role', header: 'Role', cell: (row) => row.role },
          { key: 'data', header: 'Data involved', cell: (row) => row.dataInvolved },
        ],
        rows: SUBPROCESSORS,
      })}
    </section>

    <section class="stack">
      <h2>How long we keep evidence</h2>
      ${Callout({ tone: 'note', body: html`<p>${EVIDENCE_RETENTION_NOTE}</p>` })}
      <p class="small muted">
        ${LIMITS.EVIDENCE_RETENTION_DAYS} days is a fixed system limit, not a per-customer setting.
      </p>
    </section>

    <section class="stack">
      <h2>Questions about your data</h2>
      ${FaqList(['store-customer-data', 'data-used-to-train', 'how-long-evidence-kept', 'ai-decide-pass-fail'])}
    </section>
  </div>`;
}

export function RefundsPage(): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'Cancellation and refunds',
      'How to stop paying, and what happens next',
      'Cancelling is one action in the billing portal, and it never needs to go through us.',
    )}
    ${skeletonNotice()}

    <section class="stack">
      <h2>Cancelling</h2>
      <p class="measure">${PLAN_CANCELLATION_WORDING}</p>
    </section>

    <section class="stack">
      <h2>Refunds</h2>
      ${Callout({ tone: 'todo', title: 'Refund policy', body: html`<p>${REFUND_POLICY_SUMMARY}</p>` })}
    </section>

    <section class="stack">
      <h2>Related answers</h2>
      ${FaqList(['how-cancel', 'what-happens-over-allowance', 'tax-and-currency'])}
    </section>
  </div>`;
}

export interface StatusPageOptions {
  readonly environment: string;
  readonly checkedAt: string;
}

/**
 * Service status.
 *
 * We publish no uptime figure because we do not measure one, and a status page that says
 * "All systems operational" without a monitor behind it is a fabricated success — exactly
 * the failure mode this product exists to catch in other people's software.
 */
export function StatusPage(options: StatusPageOptions): Html {
  return html`<div class="wrap section stack-lg">
    ${pageHead(
      'Service status',
      'What we can honestly tell you about availability',
      'This page carries no automatic uptime measurement, so it does not display one.',
    )}

    ${Callout({
      tone: 'limit',
      title: 'We publish no uptime figure and no incident history',
      body: html`<p>
          There is no monitoring system behind this page yet. Rather than show a green tick that nothing
          checks, we are telling you that the tick would mean nothing.
        </p>
        <p>
          The live machine-readable health check is at <a href="/health">/health</a>. It reports whether
          this Worker can reach its own database at the moment you ask, and nothing more.
        </p>`,
    })}

    <section class="stack">
      <h2>What this deployment is</h2>
      <dl class="kv">
        <dt>Environment</dt>
        <dd>${options.environment}</dd>
        <dt>Page generated</dt>
        <dd>${options.checkedAt}</dd>
        <dt>Uptime commitment</dt>
        <dd>none published</dd>
      </dl>
    </section>

    <section class="stack">
      <h2>What "still checking" means when a run is slow</h2>
      ${FaqList(['is-this-real-time', 'evidence-source-down', 'connection-expires'])}
    </section>

    ${StandingLimitations()}
  </div>`;
}
