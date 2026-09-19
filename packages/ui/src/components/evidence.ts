/**
 * The components that render A03's plain-language layer.
 *
 * These deliberately take *structural* shapes rather than importing `@verify/domain`, so
 * the design system stays a leaf package. Every interface here is satisfied by the domain
 * type it mirrors, so the compiler still catches a drift: pass an `AssertionExplanation`
 * straight in and it type-checks.
 *
 * The rules these components exist to make unbreakable:
 *   - `next_step: null` renders *nothing*. Not "No action needed", not an empty box.
 *   - `verified_percentage: null` renders a headline, never a bar. "No runs received yet"
 *     must never be drawn as 0% and must never be drawn as 100%.
 *   - `describeCoverage().limitation` renders visibly, in the flow, never inside a
 *     `<details>` or a tooltip.
 *   - Inactivity sits *beside* the pass rate, never inside it.
 */
import { attrs, html, type Html } from '../html.js';
import { STANDING_LIMITATIONS_PARAGRAPH } from '../content/site.js';
import { Callout } from './card.js';
import { AssertionBadge, StatusBadge } from './statusBadge.js';
import type { AssertionKey, StatusKey } from '../tokens.js';

/** Structurally satisfied by `explainRunStatus()` and `explainAssertion()`. */
export interface ExplanationLike {
  readonly headline: string;
  readonly sentence: string;
  readonly next_step: string | null;
}

/** Structurally satisfied by `explainAssertion()`. */
export interface AssertionExplanationLike extends ExplanationLike {
  readonly rule_id: string;
  readonly detail: string | null;
}

/**
 * The next step, or nothing at all.
 *
 * A03 returns `null` whenever no genuine action exists, and the only honest rendering of
 * that is silence. Filler text here ("nothing to do") would train the customer to skip the
 * line on the runs where it does matter.
 */
export function NextStep(nextStep: string | null): Html | null {
  if (nextStep === null || nextStep.trim().length === 0) return null;
  return html`<p class="small"><strong>Next step.</strong> ${nextStep}</p>`;
}

/** One check that could not be completed, and why — the shape of a hole in a verdict. */
export interface VerdictGap {
  /** The check's customer-facing label. */
  readonly label: string;
  /** The plain sentence for what blocked it. Never a reason code. */
  readonly reason: string;
}

export interface RunVerdictOptions {
  readonly status: StatusKey;
  readonly explanation: ExplanationLike;
  /**
   * What could not be checked, for an UNVERIFIED verdict. Ignored for the other three.
   *
   * VERIFIED and FAILED are complete statements. UNVERIFIED is not a statement at all
   * until it names what is missing, so an UNVERIFIED verdict always renders a follow-up
   * line: one per gap given here, or — if the caller has none — a line saying so, because
   * a verdict with a hole in it must show the shape of the hole and silence would hide it.
   */
  readonly gaps?: readonly VerdictGap[];
}

/**
 * The follow-up lines under an UNVERIFIED verdict. In the flow, at body size, never inside
 * a `<details>` or a `title` attribute: the reader who does not open a disclosure is exactly
 * the reader who will treat amber as a soft failure.
 */
function verdictGaps(gaps: readonly VerdictGap[] | undefined): Html {
  if (gaps === undefined || gaps.length === 0) {
    return html`<p class="verdict-gap" data-verdict-gap>
      Which check could not be completed was not recorded for this run, so we cannot name it here.
    </p>`;
  }
  return html`${gaps.map(
    (gap) => html`<p class="verdict-gap" data-verdict-gap>
      Could not check <strong>${gap.label}</strong>: ${gap.reason}
    </p>`,
  )}`;
}

/**
 * Pick the gaps out of a run's assertion results: every check that reached neither a
 * confirmation nor a contradiction. Callers supply the plain sentence for each, because
 * this package is a leaf and does not import the domain's explanations.
 */
export function gapsFrom<Row extends { readonly status: AssertionKey; readonly label: string }>(
  results: readonly Row[],
  sentenceFor: (row: Row) => string,
): readonly VerdictGap[] {
  return results
    .filter((row) => row.status === 'UNKNOWN' || row.status === 'PENDING')
    .map((row) => ({ label: row.label, reason: sentenceFor(row) }));
}

/** A run's headline verdict: badge, one honest sentence, and a next step only if real. */
export function RunVerdict(options: RunVerdictOptions): Html {
  return html`<div class="stack-sm" data-run-verdict="${options.status}">
    <div class="row">${StatusBadge({ status: options.status, large: true })}</div>
    <h2>${options.explanation.headline}</h2>
    <p class="lede">${options.explanation.sentence}</p>
    ${options.status === 'UNVERIFIED' ? verdictGaps(options.gaps) : null}
    ${NextStep(options.explanation.next_step)}
  </div>`;
}

export interface AssertionRowOptions {
  readonly status: AssertionKey;
  readonly explanation: AssertionExplanationLike;
  /** Where the evidence came from — `provider_readback`, `provider_webhook`, `customer_claim`. */
  readonly origin?: string;
  /** Whether the check has to pass for the run to be verified. */
  readonly mandatory?: boolean;
  /** The provider event's own timestamp. */
  readonly observedAt?: string | null;
  /** The machine reason code, shown small, after the plain sentence — never instead of it. */
  readonly reasonCode?: string;
}

/**
 * One check, in the evidence margin: verdict glyph and origin in the gutter, plain language
 * in the column. The reason code appears only as a small trailing note, because a customer
 * should never have to decode `STATUS_NOT_REACHED` to understand their own result.
 */
export function AssertionRow(options: AssertionRowOptions): Html {
  const explanation = options.explanation;
  return html`<div class="margin-row" data-rule-id="${explanation.rule_id}">
    <div class="margin-row__gutter">
      ${AssertionBadge({ status: options.status })}
      ${options.origin === undefined ? null : html`<span class="margin-row__origin">${options.origin}</span>`}
      ${options.mandatory === false ? html`<span class="margin-row__origin">optional</span>` : null}
    </div>
    <div class="stack-sm">
      <h3>${explanation.headline}</h3>
      <p class="small muted">${explanation.sentence}</p>
      ${explanation.detail === null ? null : html`<p class="small mono">${explanation.detail}</p>`}
      ${NextStep(explanation.next_step)}
      ${
        options.reasonCode === undefined && options.observedAt === undefined
          ? null
          : html`<p class="micro mono">
            ${options.reasonCode === undefined ? null : html`reason ${options.reasonCode}`}
            ${
              options.observedAt === undefined || options.observedAt === null
                ? null
                : html` · observed ${options.observedAt}`
            }
          </p>`
      }
    </div>
  </div>`;
}

/**
 * The bar's width, as a class rather than an inline `style` attribute.
 *
 * This exists because of a bug the lead caught by looking at the deployed page: the
 * Content-Security-Policy blocks `style` attributes, a blocked `width` falls back to the
 * element's natural full width, and a 33% verification rate rendered as a full green bar.
 * On this product that is not a cosmetic bug — it silently turns a partial result into a
 * perfect one, which is the exact lie the whole service exists to catch.
 *
 * Granularity is 5%, and it rounds *down*, never to nearest. The exact figure is stated in
 * text directly above the bar and repeated in the bar's accessible name, so the bar's job is
 * only to give a shape — and on this product a shape that errs generous is worse than one
 * that errs mean. 33% draws as 30, 99% draws as 95, and only a true 100% fills the bar.
 */
export function meterFillClass(percentage: number | null): string {
  if (percentage === null) return 'meter__fill meter__fill--0';
  const clamped = Math.min(100, Math.max(0, percentage));
  return `meter__fill meter__fill--${String(Math.floor(clamped / 5) * 5)}`;
}

/**
 * A proportion as a whole-number percentage that **never rounds up**.
 *
 * `meterFillClass` fixed the bar and left the arithmetic alone, which turned out to be half
 * the defect. Every caller still reached for `Math.round`, so 499 of 500 runs used — 99.8% —
 * became the integer 100, and 100 selects `meter__fill--100`: a bar drawn completely full
 * for an allowance that is not spent, with an accessible name saying "100 per cent" to
 * anyone listening rather than looking. Same lie as the original bug, one layer up.
 *
 * Use this anywhere a ratio becomes a figure a customer reads. It floors, so the number and
 * the bar agree and both err mean; 100 is returned only when the ratio genuinely reaches
 * one, so rounding down never becomes "the bar can never finish". A zero or negative
 * denominator is 0, not a division by zero and not a fabricated 100.
 */
export function percentFloor(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return 0;
  if (denominator <= 0) return 0;
  const raw = (numerator / denominator) * 100;
  if (raw >= 100) return 100;
  if (raw <= 0) return 0;
  return Math.floor(raw);
}

/** Structurally satisfied by `summariseWorkflowHealth()`. */
export interface WorkflowHealthLike {
  readonly state: string;
  readonly total_runs: number;
  readonly decided_runs: number;
  readonly verified_percentage: number | null;
  readonly headline: string;
  readonly detail: string;
}

/**
 * The health readout.
 *
 * When `verified_percentage` is null there is no number and no bar — only the headline and
 * the detail sentence. That is the whole point of A03 returning null: a workspace that has
 * received nothing must not be able to look like a workspace that has passed everything.
 */
export function HealthReadout(health: WorkflowHealthLike): Html {
  const hasScore = health.verified_percentage !== null;
  return html`<div ${attrs({ class: 'stack-sm', 'data-health-state': health.state })}>
    ${
      hasScore
        ? html`<p class="score" data-score="${String(health.verified_percentage)}">
            ${String(health.verified_percentage)}<span class="faint">%</span>
          </p>
          <div class="meter" role="img" aria-label="${String(health.verified_percentage)}% of ${health.decided_runs} decided runs were verified">
            <div class="${meterFillClass(health.verified_percentage)}"></div>
          </div>`
        : html`<p class="score score--none" data-score="none">${health.headline}</p>`
    }
    ${hasScore ? html`<p class="small"><strong>${health.headline}</strong></p>` : null}
    <p class="small muted">${health.detail}</p>
    <p class="micro mono">${health.total_runs} runs received · ${health.decided_runs} decided</p>
  </div>`;
}

/** Structurally satisfied by `detectInactivity()`. */
export interface InactivityLike {
  readonly inactive: boolean;
  readonly severity: string;
  readonly headline: string;
  readonly detail: string;
}

/**
 * The activity signal, rendered as its own block beside the rate — never folded into it.
 * Silence is a distinct finding: a workflow that has stopped receiving events cannot show
 * that as a falling percentage, because the missing runs were never counted.
 */
export function InactivityNotice(report: InactivityLike): Html {
  return Callout({
    tone: report.inactive ? 'warn' : 'note',
    title: report.headline,
    body: html`<p>${report.detail}</p>`,
  });
}

/** Structurally satisfied by `describeCoverage()`. */
export interface CoverageLike {
  readonly mode: string;
  readonly can_detect_missing_runs: boolean;
  readonly headline: string;
  readonly detail: string;
  readonly limitation: string | null;
}

/**
 * Coverage mode, always beside the results.
 *
 * The limitation is rendered as body text inside a visible callout. It is never behind a
 * `<details>`, a tooltip, or a "learn more" — a customer who does not open the accordion
 * is exactly the customer who will be surprised later.
 */
export function CoverageNotice(coverage: CoverageLike): Html {
  return html`<div ${attrs({ class: 'stack-sm', 'data-coverage-mode': coverage.mode })}>
    <p class="eyebrow">Coverage — ${coverage.mode.replace(/_/g, ' ')}</p>
    <p class="small"><strong>${coverage.headline}</strong></p>
    <p class="small muted">${coverage.detail}</p>
    ${
      coverage.limitation === null
        ? null
        : Callout({
            tone: 'limit',
            title: 'What this cannot see',
            body: html`<p data-coverage-limitation>${coverage.limitation}</p>`,
          })
    }
  </div>`;
}

/**
 * The standing limitations paragraph, verbatim from A01's content module.
 *
 * The brief requires this beside every result screen, not once in a footer, so it is a
 * component rather than a copy-paste.
 */
export function StandingLimitations(): Html {
  return Callout({
    tone: 'limit',
    title: 'What this check does and does not cover',
    body: html`<p data-standing-limitations>${STANDING_LIMITATIONS_PARAGRAPH}</p>`,
  });
}

export interface ClaimRuleOptions {
  /** What the customer's automation told us to expect. */
  readonly claim: string;
  /** What we retrieved ourselves. `null` renders "no value retrieved", not an empty line. */
  readonly observed: string | null;
  readonly status: StatusKey;
  readonly claimLabel?: string;
  readonly observedLabel?: string;
  /** What is being compared, stated once above the rule instead of inside both halves. */
  readonly caption?: string;
}

/**
 * The claim rule — this product's argument as a single device.
 *
 * Above the line: what was claimed, in muted mono. On the line: the verdict. Below the
 * line: what we actually retrieved. It appears in the hero, on the demo, and on every run
 * detail, so a reader meets the same shape everywhere and learns to read a result in one
 * glance.
 */
export function ClaimRule(options: ClaimRuleOptions): Html {
  return html`<div class="claimrule" data-claim-rule="${options.status}">
    ${options.caption === undefined ? null : html`<p class="claimrule__caption">${options.caption}</p>`}
    <p class="claimrule__label">${options.claimLabel ?? 'Your automation expected'}</p>
    <p class="claimrule__value claimrule__claim">${options.claim}</p>
    <p class="claimrule__split"><span class="claimrule__verdict">${StatusBadge({ status: options.status })}</span></p>
    <p class="claimrule__label">${options.observedLabel ?? 'We retrieved'}</p>
    <p class="claimrule__value">${options.observed ?? 'no value retrieved'}</p>
  </div>`;
}
