/**
 * What each advertising platform's own documentation says about budget ceilings.
 *
 * Everything here was read on 2026-09-19. Each entry carries the URL it came from and a
 * `primary_source` flag: `false` means the figure is from a secondary write-up because the
 * platform's own help centre would not serve to a non-logged-in reader. A `false` here is
 * a thing the owner must confirm on screen before submitting anything.
 *
 * The narrative, the arithmetic and the recommendation are in `docs/advertising.md`.
 */
import type { PlatformCapFacts } from './types';

const CHECKED = '2026-09-19';

/**
 * Google Ads: no total budget for Search. The documented guarantee is per calendar month.
 * Prepay — the one payment setting that would be a real ceiling — is not available in the
 * United Kingdom, so a UK account is postpay and Google decides when to charge the card.
 */
export const GOOGLE_ADS_FACTS: PlatformCapFacts = {
  platform: 'google_ads',
  cap_enforcement: 'monthly_only',
  cap_behaviour:
    'On a given day, your campaign might spend up to twice your average daily budget. At the end of the month, you will have spent no more than 30.4 times your average daily budget.',
  minimum_daily_minor: null,
  minimum_lifetime_minor: null,
  minimum_monthly_minor: null,
  currency: 'GBP',
  source_url: 'https://support.google.com/google-ads/answer/1704443?hl=en',
  checked_on: CHECKED,
  primary_source: true,
  // Google documents no minimum average daily budget for Search anywhere public.
  minimums_provenance: 'not_published',
  minimums_source_url: null,
};

/**
 * Microsoft Advertising: lifetime budgets exist only for Audience campaigns, not Search.
 * For a daily budget the service computes `daily x days in month` and pauses the campaign
 * when that is depleted — a stronger written commitment than Google's, but still monthly,
 * and daily overspend is described as "usually ... less than 100% above your daily limit".
 */
export const MICROSOFT_ADS_FACTS: PlatformCapFacts = {
  platform: 'microsoft_ads',
  cap_enforcement: 'monthly_only',
  cap_behaviour:
    'The service calculates the monthly budget limit by multiplying the daily budget by the number of days in the month. If the daily budget amount or calculated monthly budget amount is depleted, the campaign is paused automatically. Microsoft Advertising usually keeps overspend to less than 100% above your daily limit.',
  // Verified 2026-09-19 from Microsoft's own currency table, UKPound row:
  // minimum bid GBP 0.05, minimum daily budget GBP 0.05, minimum MONTHLY budget GBP 5.00.
  // That floor is well inside the advertising allocation, in sterling, with no FX exposure.
  minimum_daily_minor: 5,
  minimum_lifetime_minor: null,
  minimum_monthly_minor: 500,
  currency: 'GBP',
  source_url: 'https://learn.microsoft.com/en-us/advertising/guides/budget-bid-strategies?view=bingads-13',
  checked_on: CHECKED,
  primary_source: true,
  minimums_provenance: 'primary',
  minimums_source_url: 'https://learn.microsoft.com/en-us/advertising/guides/currencies?view=bingads-13',
};

/**
 * LinkedIn: a lifetime budget is a genuine ceiling, but the floor is far above £15.
 * $10/day minimum and $100 minimum lifetime for a new campaign. At UK B2B costs per click
 * this budget buys one or two clicks. Ruled out on the figure, not on preference.
 */
export const LINKEDIN_FACTS: PlatformCapFacts = {
  platform: 'linkedin',
  cap_enforcement: 'total_budget',
  cap_behaviour: 'Your total spend will never exceed the lifetime budget of your campaign or ad set.',
  minimum_daily_minor: 1_000,
  minimum_lifetime_minor: 10_000,
  minimum_monthly_minor: null,
  currency: 'USD_ONLY',
  source_url: 'https://www.linkedin.com/help/lms/answer/a422101',
  checked_on: CHECKED,
  primary_source: true,
  minimums_provenance: 'primary',
  minimums_source_url: 'https://www.linkedin.com/help/lms/answer/a422101',
};

/**
 * Meta: an ad-set lifetime budget is a real ceiling and the daily floor is $1 for
 * impression-billed delivery. The problem is not the cap, it is that Meta cannot target
 * "builds automations for clients" with any intent signal.
 *
 * `primary_source: false` — Meta's business help centre would not serve the minimum-budget
 * article to an unauthenticated fetch; these figures are from secondary write-ups.
 */
export const META_FACTS: PlatformCapFacts = {
  platform: 'meta',
  cap_enforcement: 'total_budget',
  cap_behaviour:
    'A lifetime budget is spent over the ad set schedule and is not exceeded; a daily budget is an average and may be exceeded by up to 75% on a given day.',
  minimum_daily_minor: 100,
  minimum_lifetime_minor: null,
  minimum_monthly_minor: null,
  currency: 'USD_ONLY',
  source_url: 'https://www.stackmatix.com/blog/meta-ads-minimum-daily-budget-2026',
  checked_on: CHECKED,
  primary_source: false,
  // Meta's Marketing API reference documents `spend_cap` but NOT a minimum daily or
  // lifetime budget. Verified 2026-09-19: spend_cap is "defined as integer value of
  // subunit in your currency with a minimum value of $100 USD (or approximate local
  // equivalent)" — so the account-level spend cap is FAR above our allocation and cannot
  // be used as a GBP 15 ceiling. On Meta the only usable ceiling is the ad-set lifetime
  // budget. The $1/day floor remains secondary.
  minimums_provenance: 'secondary',
  minimums_source_url: 'https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/',
};

/**
 * Reddit: an ad group can carry a *total* (lifetime) budget and the platform turns the ad
 * off when it is reached. The $5/day floor is quoted from Reddit's own help centre via
 * search indexing; the $25 total-budget floor is secondary and UNCONFIRMED — it is the
 * single figure the owner must check on screen before anything else, because $25 is more
 * than £15 at any plausible rate.
 */
export const REDDIT_FACTS: PlatformCapFacts = {
  platform: 'reddit',
  cap_enforcement: 'total_budget',
  cap_behaviour:
    'Your ad group will try to deliver your average daily spend each day until you hit your total budget. After that, your ad will turn off.',
  minimum_daily_minor: 500,
  minimum_lifetime_minor: 2_500,
  minimum_monthly_minor: null,
  currency: 'USD_ONLY',
  source_url: 'https://business.reddithelp.com/helpcenter/s/article/How-much-do-Reddit-Ads-cost',
  checked_on: CHECKED,
  primary_source: false,
  // Established 2026-09-19 after exhausting the public routes: Reddit's help centre is a
  // fully client-rendered Salesforce site that serves no content to an unauthenticated
  // fetch, and business.reddit.com, www.reddit.com, old.reddit.com and ads-api.reddit.com
  // are all unreachable. These figures CANNOT be confirmed without signing in to an
  // advertising account. That is a step for the owner, not a gap in the research.
  minimums_provenance: 'requires_account',
  minimums_source_url: null,
};

export const PLATFORM_FACTS = {
  google_ads: GOOGLE_ADS_FACTS,
  microsoft_ads: MICROSOFT_ADS_FACTS,
  linkedin: LINKEDIN_FACTS,
  meta: META_FACTS,
  reddit: REDDIT_FACTS,
} as const;

/**
 * The cap test, as arithmetic rather than prose.
 *
 * `allocation_minor` is what the owner has authorised. For a platform whose only
 * documented guarantee is monthly, the largest *average daily budget* that keeps the
 * documented monthly ceiling within the allocation is `floor(allocation / 31)` — we use
 * the longest month, in integers, so the answer is never optimistic. Google's own figure
 * is 30.4; using 31 costs a rounding of pennies and removes a class of argument.
 */
export const LONGEST_MONTH_DAYS = 31;

export interface CapVerdict {
  readonly platform: PlatformCapFacts['platform'];
  /** True only when the platform documents a ceiling we can set at or below the allocation. */
  readonly enforceable: boolean;
  /** For monthly-only platforms: the largest average daily budget, in minor units. */
  readonly max_average_daily_minor: number | null;
  /** Why it is or is not enforceable, in one line. */
  readonly reason: string;
}

export function capVerdict(facts: PlatformCapFacts, allocationMinor: number): CapVerdict {
  if (!Number.isSafeInteger(allocationMinor) || allocationMinor <= 0) {
    return {
      platform: facts.platform,
      enforceable: false,
      max_average_daily_minor: null,
      reason: 'allocation must be a positive integer number of minor units',
    };
  }
  if (facts.cap_enforcement === 'total_budget') {
    const floor = facts.minimum_lifetime_minor ?? facts.minimum_daily_minor;
    if (floor !== null && floor > allocationMinor) {
      return {
        platform: facts.platform,
        enforceable: false,
        max_average_daily_minor: null,
        reason: `platform enforces a total budget, but its minimum of ${floor} minor units is above the ${allocationMinor} allocated`,
      };
    }
    return {
      platform: facts.platform,
      enforceable: true,
      max_average_daily_minor: null,
      reason: 'platform documents a total budget above which delivery stops',
    };
  }
  if (facts.cap_enforcement === 'monthly_only') {
    // Integer division. A float here would be a bug against the cap.
    const perDay = Math.floor(allocationMinor / LONGEST_MONTH_DAYS);
    if (perDay <= 0) {
      return {
        platform: facts.platform,
        enforceable: false,
        max_average_daily_minor: 0,
        reason: 'the allocation divided across a month rounds to zero minor units a day',
      };
    }
    // On a monthly-only platform the real floor is the minimum MONTHLY budget, not the
    // daily one: the daily figure is multiplied up before it is enforced.
    const monthlyFloor = facts.minimum_monthly_minor;
    if (monthlyFloor !== null && monthlyFloor > allocationMinor) {
      return {
        platform: facts.platform,
        enforceable: false,
        max_average_daily_minor: perDay,
        reason: `the platform's minimum monthly budget of ${monthlyFloor} minor units is above the ${allocationMinor} allocated`,
      };
    }
    return {
      platform: facts.platform,
      enforceable: false,
      max_average_daily_minor: perDay,
      reason: `no total ceiling exists; the only documented guarantee is per calendar month, which bounds spend at ${perDay} minor units a day (${perDay * LONGEST_MONTH_DAYS} across a 31-day month) and only if the campaign never crosses a month boundary`,
    };
  }
  return {
    platform: facts.platform,
    enforceable: false,
    max_average_daily_minor: null,
    reason: 'cap behaviour not established from the platform’s own documentation',
  };
}
