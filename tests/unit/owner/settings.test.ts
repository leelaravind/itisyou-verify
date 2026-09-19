/**
 * Owner settings.
 *
 * The property that matters most here is a refusal to invent: the founder's trading name
 * and address ship as `TODO_OWNER_INPUT`, are reported as pending, and cannot be satisfied
 * by a plausible-looking default.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUSINESS,
  DEFAULT_PRICING,
  DEFAULT_RETENTION,
  REQUIRED_BUSINESS_FIELDS,
  RETENTION_BOUNDS,
  SETTINGS_KEY,
  TODO_OWNER_INPUT,
  classifyRetentionChange,
  cleanText,
  isOwnerInputPending,
  parseMinorUnits,
  pendingBusinessFields,
  validateBusiness,
  validatePricing,
  validateRetention,
} from '@app/owner/settings';

describe('owner settings', () => {
  it('OWNER-145 business details ship as TODO_OWNER_INPUT rather than an invented name', () => {
    expect(DEFAULT_BUSINESS.tradingName).toBe(TODO_OWNER_INPUT);
    expect(DEFAULT_BUSINESS.proprietorName).toBe(TODO_OWNER_INPUT);
    expect(DEFAULT_BUSINESS.addressLine1).toBe(TODO_OWNER_INPUT);
    expect(DEFAULT_BUSINESS.postcode).toBe(TODO_OWNER_INPUT);
    expect([...pendingBusinessFields(DEFAULT_BUSINESS)].sort()).toEqual([...REQUIRED_BUSINESS_FIELDS].sort());
  });

  it('OWNER-146 the legal form is fixed as a UK sole trader, not offered as a guess', () => {
    expect(DEFAULT_BUSINESS.legalForm).toBe('uk_sole_trader');
    const { values } = validateBusiness({ tradingName: 'Anything', legalForm: 'limited_company' } as Record<string, string>);
    expect(values.legalForm).toBe('uk_sole_trader');
  });

  it('OWNER-147 an empty or whitespace value counts as still pending', () => {
    expect(isOwnerInputPending('')).toBe(true);
    expect(isOwnerInputPending('   ')).toBe(true);
    expect(isOwnerInputPending(null)).toBe(true);
    expect(isOwnerInputPending(TODO_OWNER_INPUT)).toBe(true);
    expect(isOwnerInputPending('Real Trading Name')).toBe(false);
  });

  it('OWNER-148 saving business details validates every required field', () => {
    const { errors } = validateBusiness({ tradingName: 'Verify', contactEmail: 'nope' });
    expect(Object.keys(errors)).toContain('proprietorName');
    expect(Object.keys(errors)).toContain('addressLine1');
    expect(errors['contactEmail']).toMatch(/email address/i);
  });

  it('OWNER-149 a complete set of business details validates and normalises', () => {
    const { values, errors } = validateBusiness({
      tradingName: '  ITISYOU  Verify ',
      proprietorName: 'A Founder',
      addressLine1: '1 Example Street',
      city: 'London',
      postcode: 'sw1a 1aa',
      contactEmail: 'Hello@Example.Invalid',
    });
    expect(errors).toEqual({});
    expect(values.tradingName).toBe('ITISYOU Verify');
    expect(values.postcode).toBe('SW1A 1AA');
    expect(values.contactEmail).toBe('hello@example.invalid');
    expect(values.country).toBe('United Kingdom');
  });

  it('OWNER-150 pricing applies to future purchases only, as data and not only as copy', () => {
    expect(DEFAULT_PRICING.appliesTo).toBe('future_purchases_only');
    const { values } = validatePricing({ monthlyAmount: '59.00', runsIncluded: '500' });
    expect(values.appliesTo).toBe('future_purchases_only');
    expect(values.monthlyAmountMinor).toBe(5900);
  });

  it('OWNER-151 a price is parsed as integer pence and rejects a third decimal', () => {
    expect(parseMinorUnits('49')).toBe(4900);
    expect(parseMinorUnits('49.9')).toBe(4990);
    expect(parseMinorUnits('£1,249.50')).toBe(124_950);
    expect(parseMinorUnits('49.005')).toBeNull();
    expect(parseMinorUnits('lots')).toBeNull();
    expect(parseMinorUnits('-5.00')).toBeNull();
  });

  it('OWNER-152 a price of nothing is refused', () => {
    const { errors } = validatePricing({ monthlyAmount: '0.00', runsIncluded: '500' });
    expect(errors['monthlyAmount']).toMatch(/more than nothing/i);
  });

  it('OWNER-153 a malformed provider price id is refused rather than saved', () => {
    const { errors } = validatePricing({ monthlyAmount: '49.00', runsIncluded: '500', stripePriceId: 'not a price' });
    expect(errors['stripePriceId']).toBeDefined();
  });

  it('OWNER-154 retention values are bounded and a bad one falls back rather than saving', () => {
    const { values, errors } = validateRetention({ evidenceDays: '9000', runDays: 'soon', auditDays: '365', visitDays: '30', supportCaseDays: '365' });
    expect(errors['evidenceDays']).toMatch(new RegExp(String(RETENTION_BOUNDS.evidenceDays.max)));
    expect(errors['runDays']).toMatch(/whole number/i);
    expect(values.evidenceDays).toBe(DEFAULT_RETENTION.evidenceDays);
  });

  it('OWNER-155 a retention change is classified so lengthening can be treated differently', () => {
    expect(classifyRetentionChange(30, 14)).toBe('shortened');
    expect(classifyRetentionChange(30, 90)).toBe('lengthened');
    expect(classifyRetentionChange(30, 30)).toBe('unchanged');
  });

  it('OWNER-156 free text is trimmed, collapsed and capped', () => {
    expect(cleanText('  a   b  ')).toBe('a b');
    expect(cleanText('x'.repeat(500)).length).toBe(200);
    expect(cleanText(undefined)).toBe('');
  });

  it('OWNER-157 every settings key is namespaced under owner, so nothing collides', () => {
    for (const key of Object.values(SETTINGS_KEY)) {
      expect(key.startsWith('owner.')).toBe(true);
    }
  });
});
