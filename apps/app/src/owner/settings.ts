/**
 * The settings the owner can change without a deploy.
 *
 * Every one of these is a `settings` row read through A02's `settings.getJson(db, key,
 * fallback)`, which means a corrupted or absent row falls back rather than taking the site
 * down. The fallbacks below are therefore the real defaults of the product, not
 * placeholders — they are what runs when the settings table is empty.
 *
 * ## `TODO_OWNER_INPUT`
 *
 * The business details are legally required on the public pages and **must not be
 * invented**. Nobody on this team knows the founder's trading name or address, and a
 * plausible-looking guess on a terms page is worse than an admission. They ship as the
 * literal string `TODO_OWNER_INPUT`, `@verify/ui`'s `todo` callout renders them visibly as
 * missing, and this page is where the owner fills them in. {@link isOwnerInputPending}
 * is the one check everything else uses.
 */
import type { AccessMode, Currency } from '@verify/contracts';

/** The marker for a value only the founder can supply. Never replaced by a guess. */
export const TODO_OWNER_INPUT = 'TODO_OWNER_INPUT';

export function isOwnerInputPending(value: string | null | undefined): boolean {
  return (
    value === undefined || value === null || value.trim().length === 0 || value === TODO_OWNER_INPUT
  );
}

/** Every settings key this panel reads or writes, in one place. */
export const SETTINGS_KEY = {
  business: 'owner.business',
  pricing: 'owner.pricing',
  notifications: 'owner.notifications',
  retention: 'owner.retention',
  budgetLimits: 'owner.budget_limits',
  accessMode: 'owner.access_mode',
  overviewRefresh: 'owner.overview_refreshed_at',
} as const;

// ---------------------------------------------------------------------------
// Business details
// ---------------------------------------------------------------------------

/**
 * The founder trades as a **UK sole trader**. That is a fact about the business, not a
 * setting, so `legalForm` is fixed here rather than offered as a dropdown — a sole trader
 * who accidentally selects "limited company" has published something untrue about their
 * own liability.
 */
export interface BusinessDetails {
  readonly legalForm: 'uk_sole_trader';
  /** The name the business trades under. `TODO_OWNER_INPUT` until the owner supplies it. */
  readonly tradingName: string;
  /** The person legally responsible. A sole trader must publish this. */
  readonly proprietorName: string;
  /** A correspondence address. Required on the terms page under UK consumer law. */
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly postcode: string;
  readonly country: string;
  /** Where a customer can actually reach the business. */
  readonly contactEmail: string;
  /** Only if the owner is VAT registered. Empty means "not registered", which is normal. */
  readonly vatNumber: string;
}

export const DEFAULT_BUSINESS: BusinessDetails = {
  legalForm: 'uk_sole_trader',
  tradingName: TODO_OWNER_INPUT,
  proprietorName: TODO_OWNER_INPUT,
  addressLine1: TODO_OWNER_INPUT,
  addressLine2: '',
  city: TODO_OWNER_INPUT,
  postcode: TODO_OWNER_INPUT,
  country: 'United Kingdom',
  contactEmail: TODO_OWNER_INPUT,
  vatNumber: '',
};

/** Fields that must be filled before the public legal pages are honest. */
export const REQUIRED_BUSINESS_FIELDS: readonly (keyof BusinessDetails)[] = [
  'tradingName',
  'proprietorName',
  'addressLine1',
  'city',
  'postcode',
  'contactEmail',
];

export function pendingBusinessFields(details: BusinessDetails): readonly string[] {
  return REQUIRED_BUSINESS_FIELDS.filter((field) => isOwnerInputPending(details[field])).map(
    String,
  );
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Pricing applies to **future purchases only**.
 *
 * Changing this never re-prices an existing subscription: the price a customer agreed to is
 * held by Stripe against their subscription, and nothing in this panel reaches in and
 * changes it. The page says so, and `appliesTo` exists so that promise is in the data
 * rather than only in the copy.
 */
export interface PricingSettings {
  readonly appliesTo: 'future_purchases_only';
  readonly monthlyAmountMinor: number;
  readonly currency: Currency;
  readonly runsIncluded: number;
  /** A Stripe price id. Empty until commerce is configured. Never a price typed by hand. */
  readonly stripePriceId: string;
}

export const DEFAULT_PRICING: PricingSettings = {
  appliesTo: 'future_purchases_only',
  monthlyAmountMinor: 4900,
  currency: 'GBP',
  runsIncluded: 500,
  stripePriceId: '',
};

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationSettings {
  /** Where owner alerts go. Empty means alerts are recorded but not sent anywhere. */
  readonly ownerEmail: string;
  readonly onVerificationFailure: boolean;
  readonly onConnectionBroken: boolean;
  readonly onPaymentFailure: boolean;
  readonly onSupportCase: boolean;
  readonly onBudgetThreshold: boolean;
  /** Group notifications rather than sending one per event. */
  readonly digestMinutes: number;
}

export const DEFAULT_NOTIFICATIONS: NotificationSettings = {
  ownerEmail: TODO_OWNER_INPUT,
  onVerificationFailure: false,
  onConnectionBroken: true,
  onPaymentFailure: true,
  onSupportCase: true,
  onBudgetThreshold: true,
  digestMinutes: 60,
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * How long we keep things. Shortening one of these is a promise we can keep immediately;
 * lengthening it applies only to data collected afterwards, because we already told
 * customers the shorter figure. `lengtheningAppliesFrom` records that honestly.
 */
export interface RetentionSettings {
  readonly evidenceDays: number;
  readonly runDays: number;
  readonly auditDays: number;
  readonly visitDays: number;
  readonly supportCaseDays: number;
}

export const DEFAULT_RETENTION: RetentionSettings = {
  evidenceDays: 30,
  runDays: 90,
  auditDays: 365,
  visitDays: 30,
  supportCaseDays: 365,
};

export const RETENTION_BOUNDS: Readonly<
  Record<keyof RetentionSettings, { readonly min: number; readonly max: number }>
> = {
  evidenceDays: { min: 1, max: 90 },
  runDays: { min: 7, max: 365 },
  auditDays: { min: 30, max: 2555 },
  visitDays: { min: 1, max: 90 },
  supportCaseDays: { min: 30, max: 2555 },
};

export type RetentionChangeDirection = 'shortened' | 'lengthened' | 'unchanged';

export function classifyRetentionChange(from: number, to: number): RetentionChangeDirection {
  if (to < from) return 'shortened';
  if (to > from) return 'lengthened';
  return 'unchanged';
}

// ---------------------------------------------------------------------------
// Budget limits
// ---------------------------------------------------------------------------

/**
 * The approved spending ceilings, per budget account scope. Integer minor units.
 *
 * Raising one of these is a consequential action bound to an approval — it is the single
 * setting on this page that can cost money, so it does not share the ordinary settings
 * save path.
 */
export interface BudgetLimitSettings {
  readonly currency: Currency;
  readonly limits: Readonly<Record<string, number>>;
  readonly safetyBufferMinor: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimitSettings = {
  currency: 'GBP',
  limits: {
    'platform:infrastructure': 2000,
    'platform:model_api': 1000,
    'platform:email_ops': 500,
    'platform:advertising': 1500,
  },
  safetyBufferMinor: 200,
};

// ---------------------------------------------------------------------------
// Access mode
// ---------------------------------------------------------------------------

export interface AccessModeSettings {
  readonly mode: AccessMode;
}

export const DEFAULT_ACCESS_MODE: AccessModeSettings = { mode: 'PUBLIC_LOGIN' };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface FieldErrors {
  readonly [field: string]: string;
}

/** Trim, collapse whitespace, and cap — the same treatment every free-text field gets. */
export function cleanText(value: string | undefined, maxLength = 200): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function validateBusiness(input: Partial<Record<keyof BusinessDetails, string>>): {
  readonly values: BusinessDetails;
  readonly errors: FieldErrors;
} {
  const values: BusinessDetails = {
    legalForm: 'uk_sole_trader',
    tradingName: cleanText(input.tradingName),
    proprietorName: cleanText(input.proprietorName),
    addressLine1: cleanText(input.addressLine1),
    addressLine2: cleanText(input.addressLine2),
    city: cleanText(input.city, 80),
    postcode: cleanText(input.postcode, 12).toUpperCase(),
    country: cleanText(input.country, 80) || 'United Kingdom',
    contactEmail: cleanText(input.contactEmail, 254).toLowerCase(),
    vatNumber: cleanText(input.vatNumber, 20).toUpperCase(),
  };

  const errors: Record<string, string> = {};
  for (const field of REQUIRED_BUSINESS_FIELDS) {
    if (isOwnerInputPending(values[field])) {
      errors[field] = 'This has to be filled in before the public pages are accurate.';
    }
  }
  if (values.contactEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.contactEmail)) {
    errors['contactEmail'] = 'That does not look like an email address.';
  }
  return { values, errors };
}

export function validateRetention(input: Partial<Record<keyof RetentionSettings, string>>): {
  readonly values: RetentionSettings;
  readonly errors: FieldErrors;
} {
  const errors: Record<string, string> = {};
  const read = (key: keyof RetentionSettings): number => {
    const raw = (input[key] ?? '').trim();
    const parsed = Number.parseInt(raw, 10);
    const bounds = RETENTION_BOUNDS[key];
    if (!Number.isSafeInteger(parsed)) {
      errors[key] = 'Enter a whole number of days.';
      return DEFAULT_RETENTION[key];
    }
    if (parsed < bounds.min || parsed > bounds.max) {
      errors[key] = `Between ${bounds.min} and ${bounds.max} days.`;
      return DEFAULT_RETENTION[key];
    }
    return parsed;
  };
  return {
    values: {
      evidenceDays: read('evidenceDays'),
      runDays: read('runDays'),
      auditDays: read('auditDays'),
      visitDays: read('visitDays'),
      supportCaseDays: read('supportCaseDays'),
    },
    errors,
  };
}

/** Pence, from a `£12.34` or `12.34` string. Rejects anything with more than two decimals. */
export function parseMinorUnits(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/^[£$€]/, '')
    .replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  const pence =
    Number.parseInt(whole, 10) * 100 + Number.parseInt(fraction.padEnd(2, '0') || '0', 10);
  return Number.isSafeInteger(pence) ? pence : null;
}

export function validatePricing(input: {
  readonly monthlyAmount?: string;
  readonly runsIncluded?: string;
  readonly stripePriceId?: string;
  readonly currency?: string;
}): { readonly values: PricingSettings; readonly errors: FieldErrors } {
  const errors: Record<string, string> = {};

  const amount = parseMinorUnits(input.monthlyAmount ?? '');
  if (amount === null) errors['monthlyAmount'] = 'Enter an amount like 49.00.';
  else if (amount <= 0) errors['monthlyAmount'] = 'The price has to be more than nothing.';

  const runs = Number.parseInt((input.runsIncluded ?? '').trim(), 10);
  if (!Number.isSafeInteger(runs) || runs <= 0)
    errors['runsIncluded'] = 'Enter a whole number of runs.';

  const currency: Currency =
    input.currency === 'USD' ? 'USD' : input.currency === 'EUR' ? 'EUR' : 'GBP';

  const priceId = cleanText(input.stripePriceId, 80);
  if (priceId.length > 0 && !/^price_[A-Za-z0-9]+$/.test(priceId)) {
    errors['stripePriceId'] =
      'A Stripe price id looks like price_ followed by letters and numbers.';
  }

  return {
    values: {
      appliesTo: 'future_purchases_only',
      monthlyAmountMinor: amount ?? DEFAULT_PRICING.monthlyAmountMinor,
      currency,
      runsIncluded: Number.isSafeInteger(runs) && runs > 0 ? runs : DEFAULT_PRICING.runsIncluded,
      stripePriceId: priceId,
    },
    errors,
  };
}
