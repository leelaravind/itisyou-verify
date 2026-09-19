/**
 * API-3xx — the retention policy table, and its agreement with the published document.
 *
 * A retention promise that lives only in prose is a statement of intent. These tests make
 * `docs/privacy-retention.md` and `apps/app/src/privacy/retention.ts` fail together or
 * not at all.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '@verify/contracts';
import {
  RETENTION_POLICY,
  SWEPT_TARGETS,
  discardRawPayload,
  eligibilityCutoff,
  ruleFor,
} from '@app/privacy/retention';

const DOC = readFileSync(join(process.cwd(), 'docs', 'privacy-retention.md'), 'utf8');

/** Table rows with the cell padding collapsed, so a formatter cannot break these tests. */
const DOC_ROWS = DOC.split('\n').map((line) => line.replace(/\s*\|\s*/g, '|').trim());

describe('retention policy', () => {
  it('API-330 the published document states the same period as the code, for every rule', () => {
    for (const rule of RETENTION_POLICY) {
      const row = DOC_ROWS.find((line) => line.startsWith(`|${rule.label}|`));
      expect(row, `docs/privacy-retention.md has no row for "${rule.label}"`).toBeDefined();
      if (row === undefined) continue;
      if (rule.retentionDays === null) continue;
      expect(row, rule.label).toContain(`${String(rule.retentionDays)} day`);
    }
  });

  it('API-331 the evidence period is read from LIMITS rather than retyped', () => {
    const evidence = ruleFor('evidence');
    expect(evidence?.retentionDays).toBe(LIMITS.EVIDENCE_RETENTION_DAYS);
    // And A01's published claim of thirty days is the same number.
    expect(LIMITS.EVIDENCE_RETENTION_DAYS).toBe(30);
  });

  it('API-332 every swept target declares an expiry column and how to read it', () => {
    expect(SWEPT_TARGETS.length).toBeGreaterThan(5);
    for (const target of SWEPT_TARGETS) {
      const rule = ruleFor(target);
      expect(rule, target).toBeDefined();
      expect(rule?.expiryColumn, target).toBeTruthy();
      expect(rule?.columnKind, target).toBeTruthy();
      expect(rule?.retentionDays, target).not.toBeNull();
    }
  });

  it('API-333 an absolute expiry column is not treated as an age — the classic doubling bug', () => {
    const now = new Date('2026-09-19T00:00:00.000Z');
    const evidence = ruleFor('evidence');
    const sourceEvents = ruleFor('source_events');
    expect(evidence).toBeDefined();
    expect(sourceEvents).toBeDefined();
    if (evidence === undefined || sourceEvents === undefined) return;

    // `evidence.expires_at` already holds the deadline, so the cut-off is now.
    expect(eligibilityCutoff(evidence, now)).toBe('2026-09-19T00:00:00.000Z');
    // `source_events.received_at` holds a creation time, so the cut-off is 90 days back.
    expect(eligibilityCutoff(sourceEvents, now)).toBe('2026-06-21T00:00:00.000Z');
  });

  it('API-334 every policy row carries a reason, and none of them is a placeholder', () => {
    for (const rule of RETENTION_POLICY) {
      expect(rule.reason.length, rule.label).toBeGreaterThan(60);
      expect(rule.reason, rule.label).not.toMatch(/TODO|TBD|lorem/i);
      expect(rule.contents.length, rule.label).toBeGreaterThan(20);
    }
  });

  it('API-335 the analytics window is the shortest of the customer-facing swept periods', () => {
    const analytics = ruleFor('visit_sessions')?.retentionDays ?? Number.POSITIVE_INFINITY;
    const customerFacing = ['evidence', 'source_events', 'support_cases'] as const;
    for (const target of customerFacing) {
      expect(analytics, target).toBeLessThan(ruleFor(target)?.retentionDays ?? 0);
    }
  });

  it('API-336 raw payload discarding keeps only allowlisted scalar fields', () => {
    const raw = {
      event_id: 'evt_1',
      occurred_at: '2026-09-19T00:00:00.000Z',
      signature: 'sha256=deadbeef',
      nested: { secret: 'value' },
      list: [1, 2, 3],
      count: 3,
    };
    const kept = discardRawPayload(raw, ['event_id', 'occurred_at', 'count', 'nested', 'list']);
    expect(kept).toEqual({
      event_id: 'evt_1',
      occurred_at: '2026-09-19T00:00:00.000Z',
      count: 3,
    });
    // A field nobody allowlisted never appears, whatever it is called.
    expect('signature' in kept).toBe(false);
    expect(discardRawPayload('not an object', ['a'])).toEqual({});
  });

  it('API-337 the document leaves the owner’s details as TODO_OWNER_INPUT and invents nothing', () => {
    expect(DOC).toContain('TODO_OWNER_INPUT');
    // No invented registration, address or certification.
    expect(DOC).not.toMatch(/company (registration )?(number|no\.?) *[:|] *\d/i);
    expect(DOC).not.toMatch(/\bISO ?27001\b/);
    expect(DOC).not.toMatch(/\bSOC ?2\b/);
    expect(DOC).toMatch(/We hold no security certification and claim none/i);
  });

  it('API-338 every legal requirement cited in the document carries a source URL and a verification date', () => {
    const citations =
      DOC.match(/Source: <https:\/\/[^>]+>,\s*\n?\s*verified \d{4}-\d{2}-\d{2}/g) ?? [];
    expect(citations.length).toBeGreaterThanOrEqual(2);
    expect(DOC).toContain('https://www.gov.uk/self-employed-records/how-long-to-keep-your-records');
    expect(DOC).toContain('https://www.gov.uk/charge-reclaim-record-vat/keeping-vat-records');
  });
});
