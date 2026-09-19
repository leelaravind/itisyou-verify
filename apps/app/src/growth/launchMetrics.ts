/**
 * The launch-metrics read — the four numbers A07 renders on the owner panel.
 *
 * The founder was explicit: **visits, signups and paying customers are reported
 * separately, and organic reach is not promised either.** So this module is built around
 * three refusals:
 *
 *  1. **No figure is derived from another.** Total visits, ad-attributed visits, qualified
 *     signups and paying customers come from four different systems with four different
 *     definitions. Nothing here adds them, divides them, or computes a conversion rate.
 *     The gap between them is information; a ratio would destroy it.
 *  2. **Unknown is a first-class value, and it is not zero.** Every figure carries
 *     `known`. A read that failed renders as "unknown", never as 0. The founder must be
 *     able to tell "nobody visited" from "the counter is not wired", which is precisely
 *     the failure this workstream exists to close.
 *  3. **Ten visits is a target, not a forecast.** `target.statement` says so in words,
 *     and there is a test asserting the wording never turns into a projection.
 */
import { EXTERNAL_VISIT_TARGET } from './analytics';
import type { GrowthDataPort, VisitCounts } from './port';

/** How old a figure may be before the panel must call it out. One hour. */
export const LAUNCH_METRIC_STALE_SECONDS = 3_600;

export interface LaunchFigure {
  /** `null` when unknown. Never substitute 0. */
  readonly value: number | null;
  readonly known: boolean;
  /** When the underlying figure was observed, not when this object was built. */
  readonly observedAt: string | null;
  readonly stale: boolean;
  /** One line the panel can render verbatim next to the number. */
  readonly note: string;
}

export interface LaunchTarget {
  readonly target: number;
  /** `null` when we do not know the visit count — a target cannot be "not met" on no data. */
  readonly met: boolean | null;
  readonly statement: string;
}

export interface LaunchMetrics {
  /** External landing sessions. An estimate of visits, never a count of people. */
  readonly totalVisits: LaunchFigure;
  /** Of those, the ones carrying the campaign's UTM. Never inferred from clicks. */
  readonly adAttributedVisits: LaunchFigure;
  /** A workspace created with its HubSpot connection ready. Not a customer. */
  readonly qualifiedSignups: LaunchFigure;
  /** An active subscription. The only one of the four that is money. */
  readonly payingCustomers: LaunchFigure;

  /** Excluded from `totalVisits` and reported so the exclusions are visible, not hidden. */
  readonly excludedInternalTest: LaunchFigure;
  readonly excludedBotSuspected: LaunchFigure;
  readonly excludedUnknown: LaunchFigure;

  readonly target: LaunchTarget;
  /** When this object was assembled. Always rendered. */
  readonly refreshedAt: string;
  readonly caveats: readonly string[];
}

function ageSeconds(observedAt: string | null, now: Date): number | null {
  if (observedAt === null) return null;
  const parsed = Date.parse(observedAt);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
}

export function knownFigure(value: number, observedAt: string | null, now: Date, note: string): LaunchFigure {
  const age = ageSeconds(observedAt, now);
  return {
    value,
    known: true,
    observedAt,
    stale: age === null || age > LAUNCH_METRIC_STALE_SECONDS,
    note,
  };
}

export function unknownFigure(note: string): LaunchFigure {
  return { value: null, known: false, observedAt: null, stale: true, note };
}

export interface LaunchMetricsInput {
  readonly port: GrowthDataPort;
  /** Window the visit counts cover. */
  readonly since: string;
  readonly until: string;
  readonly campaignUtm?: string;
  /**
   * From the application's own records. `null` means not computed — the same rule applies
   * as everywhere else in this file: null is unknown, not zero.
   */
  readonly qualifiedSignups: number | null;
  readonly qualifiedSignupsObservedAt: string | null;
  readonly payingCustomers: number | null;
  readonly payingCustomersObservedAt: string | null;
  readonly now: Date;
}

const SESSIONS_NOT_PEOPLE =
  'Deduplicated sessions, which is an estimate of visits and not a count of people. The session id rotates every UTC day, so one person returning tomorrow counts twice.';

export async function readLaunchMetrics(input: LaunchMetricsInput): Promise<LaunchMetrics> {
  let counts: VisitCounts | null = null;
  try {
    counts = await input.port.countVisits({
      since: input.since,
      until: input.until,
      ...(input.campaignUtm !== undefined ? { campaignUtm: input.campaignUtm } : {}),
    });
  } catch {
    // A failed read is unknown. It is never zero, and it never throws at the panel.
    counts = null;
  }

  const caveats: string[] = [
    SESSIONS_NOT_PEOPLE,
    'These four figures come from different systems with different definitions. They are reported separately and are never combined into a single number or a conversion rate.',
    'Sessions classified internal_test or bot_suspected are excluded from the visit figure and never count toward the target.',
  ];

  if (counts === null) {
    caveats.push(
      'The visit counter could not be read. Every visit figure below is UNKNOWN, which is not the same as zero — it may mean nobody has visited, or it may mean the counter is not wired up.',
    );
  }

  const visitNote = counts === null ? 'The visit counter could not be read.' : SESSIONS_NOT_PEOPLE;

  const totalVisits =
    counts === null
      ? unknownFigure(visitNote)
      : knownFigure(counts.external, counts.countedAt, input.now, SESSIONS_NOT_PEOPLE);

  const adAttributedVisits =
    counts === null
      ? unknownFigure(visitNote)
      : input.campaignUtm === undefined
        ? unknownFigure('No campaign is running, so no visit can be attributed to one.')
        : knownFigure(
            counts.adAttributed,
            counts.countedAt,
            input.now,
            'External sessions carrying the campaign UTM. Not the platform’s click count, which is a different number from a different system.',
          );

  const qualifiedSignups =
    input.qualifiedSignups === null
      ? unknownFigure('Signups have not been counted.')
      : knownFigure(
          input.qualifiedSignups,
          input.qualifiedSignupsObservedAt,
          input.now,
          'A workspace created with its HubSpot connection ready. Not a customer, and not revenue.',
        );

  const payingCustomers =
    input.payingCustomers === null
      ? unknownFigure('Paying customers have not been counted.')
      : knownFigure(
          input.payingCustomers,
          input.payingCustomersObservedAt,
          input.now,
          'Workspaces with an active subscription. The only figure here that is money.',
        );

  const excluded = (value: number | null, label: string): LaunchFigure =>
    value === null ? unknownFigure(`${label} could not be read.`) : knownFigure(value, counts?.countedAt ?? null, input.now, label);

  const met = totalVisits.value === null ? null : totalVisits.value >= EXTERNAL_VISIT_TARGET;

  return {
    totalVisits,
    adAttributedVisits,
    qualifiedSignups,
    payingCustomers,
    excludedInternalTest: excluded(counts?.internalTest ?? null, 'Our own test traffic, excluded'),
    excludedBotSuspected: excluded(counts?.botSuspected ?? null, 'Suspected crawlers, excluded'),
    excludedUnknown: excluded(counts?.unknown ?? null, 'Sessions we could not classify, excluded'),
    target: {
      target: EXTERNAL_VISIT_TARGET,
      met,
      statement:
        met === null
          ? `${EXTERNAL_VISIT_TARGET} external visits is a target, not a forecast. We cannot currently read the visit count, so we do not know where we stand.`
          : `${totalVisits.value} of ${EXTERNAL_VISIT_TARGET} external landing sessions observed. ${EXTERNAL_VISIT_TARGET} is a target, not a forecast — nothing here promises that reach, paid or organic.`,
    },
    refreshedAt: input.now.toISOString(),
    caveats,
  };
}
