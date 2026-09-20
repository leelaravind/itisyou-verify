/**
 * The visit counter writes to a database.
 *
 * ## Why this file exists
 *
 * `growth/visits.ts` is a complete visit counter. `growth/port.ts` states its contract in
 * six numbered rules. `growth/memory.ts` implements that contract and the suite has always
 * run against it. `index.ts` mounts the middleware on every request.
 *
 * And the mount passed `port: () => null`. After a full day of real requests to production,
 * `visit_sessions` held **zero rows** — verified by querying the live database, not by
 * reading the code, where every part looked correct. The launch objective this whole
 * project is measured by is ten genuine external visits, and the figure could not have
 * moved off zero however much traffic arrived.
 *
 * So these cases drive `D1GrowthPort` against a real SQLite database with the real
 * migrations, and assert the contract rules that actually cost something: a repeat visit is
 * an UPDATE and never a second row, a failed read is `null` rather than `0`, and a failed
 * sync writes no figures.
 *
 * Case ids `BUDGET-540..BUDGET-548`.
 *
 * `BUDGET-546..548` were added after the counter went live and immediately recorded two of
 * this project's own browser checks as external visitors. They pin contract rule 7: a
 * session may be corrected into an excluded class and may never leave one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { D1GrowthPort } from '@app/db/growthPort';
import { createMemoryGrowthPort, excludedFirst } from '@app/growth/memory';
import type { VisitClassification, VisitSession } from '@app/growth/analytics';
import { createTestDb, type TestDb } from '../db/harness';

const DAY = '2026-09-20';
const T = (hhmm: string): string => `${DAY}T${hhmm}:00.000Z`;

function session(overrides: Partial<VisitSession> = {}): VisitSession {
  return {
    id: 'hash_visitor_one',
    first_seen_at: T('09:00'),
    last_seen_at: T('09:00'),
    landing_path: '/demo',
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    classification: 'external',
    page_views: 1,
    expires_at: '2026-10-20T09:00:00.000Z',
    ...overrides,
  };
}

let h: TestDb;
let port: D1GrowthPort;

beforeEach(() => {
  h = createTestDb();
  port = new D1GrowthPort(h.db);
});
afterEach(() => {
  h.close();
});

const rows = (): number =>
  (h.raw.prepare('SELECT COUNT(*) AS n FROM visit_sessions').get() as { n: number }).n;

describe('the visit counter reaches a database', () => {
  it('BUDGET-540 a first visit is written, and can be read back', async () => {
    // The assertion whose absence let the counter run for a day writing nothing.
    const result = await port.recordVisit(session(), T('09:00'));

    expect(result.inserted, 'the first sighting should be an insert').toBe(true);
    expect(result.pageViews).toBe(1);
    expect(rows(), 'no row reached the database').toBe(1);
  });

  it('BUDGET-541 a repeat visit on the same day updates the row and never adds a second', async () => {
    await port.recordVisit(session(), T('09:00'));
    const second = await port.recordVisit(session(), T('14:30'));

    // Contract rule 1. This is what makes a visit a person-day rather than a page load.
    expect(second.inserted).toBe(false);
    expect(second.pageViews).toBe(2);
    expect(rows(), 'a repeat visit created a second row').toBe(1);

    const stored = h.raw.prepare('SELECT * FROM visit_sessions').get() as Record<string, unknown>;
    expect(stored['last_seen_at']).toBe(T('14:30'));
    // And the beginning of the session is NOT rewritten by a later page view.
    expect(stored['first_seen_at']).toBe(T('09:00'));
    expect(stored['landing_path']).toBe('/demo');
  });

  it('BUDGET-542 counts are grouped by classification, so automated traffic is not a visitor', async () => {
    await port.recordVisit(session({ id: 'a', classification: 'external' }), T('09:00'));
    await port.recordVisit(session({ id: 'b', classification: 'external' }), T('09:05'));
    await port.recordVisit(session({ id: 'c', classification: 'bot_suspected' }), T('09:10'));
    await port.recordVisit(session({ id: 'd', classification: 'internal_test' }), T('09:15'));

    const counts = await port.countVisits({ since: T('00:00'), until: T('23:59') });

    // The distinction the launch figure depends on: our own automated requests and the
    // crawlers must never be reportable as external visitors.
    expect(counts?.external).toBe(2);
    expect(counts?.botSuspected).toBe(1);
    expect(counts?.internalTest).toBe(1);
  });

  it('BUDGET-543 ad attribution counts only external sessions carrying the campaign tag', async () => {
    await port.recordVisit(
      session({ id: 'paid', classification: 'external', utm_campaign: 'verify-sept' }),
      T('09:00'),
    );
    await port.recordVisit(
      // A bot on the ad link is still a bot. Counting it would be the campaign marking
      // its own homework.
      session({ id: 'botad', classification: 'bot_suspected', utm_campaign: 'verify-sept' }),
      T('09:05'),
    );
    await port.recordVisit(session({ id: 'organic', classification: 'external' }), T('09:10'));

    const counts = await port.countVisits({
      since: T('00:00'),
      until: T('23:59'),
      campaignUtm: 'verify-sept',
    });

    expect(counts?.external).toBe(2);
    expect(counts?.adAttributed).toBe(1);
  });

  it('BUDGET-544 a failed read is null, not zero', async () => {
    // Contract rule 3. Dropping the table is the bluntest way to make the read fail, and
    // it is exactly the shape of failure that matters: the query cannot run.
    h.raw.prepare('DROP TABLE visit_sessions').run();

    const counts = await port.countVisits({ since: T('00:00'), until: T('23:59') });
    const expired = await port.countExpiredVisits(T('23:59'));

    // Returning 0 here would turn a broken database into the confident business fact
    // "nobody visited today" — the precise failure this product exists to complain about.
    expect(counts, 'a failed read was reported as a real count').toBeNull();
    expect(expired, 'a failed read was reported as a real count').toBeNull();
  });

  it('BUDGET-546 a session learnt to be internal is corrected, even though rule 1 refuses to revise how it began', async () => {
    // A browser cannot send the internal header, so the operator is only recognisable once
    // the exclusion cookie is set — which is AFTER their first page view. Production
    // recorded two of this project's own checks as external visitors for exactly that
    // reason, on the figure the whole launch objective is measured by.
    await port.recordVisit(session({ id: 'operator', classification: 'external' }), T('09:00'));
    await port.recordVisit(
      session({ id: 'operator', classification: 'internal_test' }),
      T('09:02'),
    );

    const stored = h.raw.prepare('SELECT * FROM visit_sessions').get() as Record<string, unknown>;
    expect(stored['classification']).toBe('internal_test');
    // Still one row, and how the session BEGAN is still not rewritten.
    expect(rows()).toBe(1);
    expect(stored['first_seen_at']).toBe(T('09:00'));
    expect(stored['landing_path']).toBe('/demo');

    const counts = await port.countVisits({ since: T('00:00'), until: T('23:59') });
    expect(counts?.external, 'the operator was still counted as a visitor').toBe(0);
    expect(counts?.internalTest).toBe(1);
  });

  it('BUDGET-547 an excluded session can never be re-counted as a visitor', async () => {
    // The direction is the safety property. If this ever reversed, a crawler that later
    // sent a browser-shaped user agent would be promoted into the launch figure, and the
    // number this project reports would be one nobody could stand behind.
    await port.recordVisit(session({ id: 'bot', classification: 'bot_suspected' }), T('09:00'));
    await port.recordVisit(session({ id: 'bot', classification: 'external' }), T('09:05'));
    await port.recordVisit(session({ id: 'ours', classification: 'internal_test' }), T('09:10'));
    await port.recordVisit(session({ id: 'ours', classification: 'external' }), T('09:15'));

    const counts = await port.countVisits({ since: T('00:00'), until: T('23:59') });

    expect(counts?.external, 'an excluded session was promoted back to external').toBe(0);
    expect(counts?.botSuspected).toBe(1);
    expect(counts?.internalTest).toBe(1);
  });

  it('BUDGET-548 the two ports agree on rule 7, so the suite cannot pass against one and fail in production', async () => {
    // `excludedFirst` is the rule written once. The SQL says the same thing in CASE form,
    // and these are the four transitions that decide whether a figure can be inflated.
    const memory = createMemoryGrowthPort();
    const cases: readonly [VisitClassification, VisitClassification, VisitClassification][] = [
      ['external', 'internal_test', 'internal_test'],
      ['external', 'bot_suspected', 'bot_suspected'],
      ['bot_suspected', 'external', 'bot_suspected'],
      ['internal_test', 'external', 'internal_test'],
      // `unknown` stays unknown. This row was written expecting 'external' and both ports
      // said 'unknown', which is the stronger answer and the one kept: promoting a session
      // into `external` on a later request would INFLATE the launch figure, and rule 7
      // exists precisely so nothing can do that. Unknown is not a visitor.
      ['unknown', 'external', 'unknown'],
      ['unknown', 'bot_suspected', 'bot_suspected'],
    ];

    for (const [stored, incoming, expected] of cases) {
      expect(excludedFirst(stored, incoming), `${stored} + ${incoming}`).toBe(expected);

      const id = `pair_${stored}_${incoming}`;
      await port.recordVisit(session({ id, classification: stored }), T('09:00'));
      await port.recordVisit(session({ id, classification: incoming }), T('09:01'));
      const row = h.raw
        .prepare('SELECT classification FROM visit_sessions WHERE id = ?')
        .get(id) as { classification: string };
      expect(
        row.classification,
        `SQL disagreed with excludedFirst on ${stored} + ${incoming}`,
      ).toBe(expected);

      await memory.recordVisit(session({ id, classification: stored }), T('09:00'));
      await memory.recordVisit(session({ id, classification: incoming }), T('09:01'));
      expect(memory.rows.get(id)?.classification, `memory port disagreed on ${id}`).toBe(expected);
    }
  });

  it('BUDGET-545 a window excludes what falls outside it, at both ends', async () => {
    await port.recordVisit(session({ id: 'before', first_seen_at: T('08:59') }), T('08:59'));
    await port.recordVisit(session({ id: 'inside', first_seen_at: T('09:00') }), T('09:00'));
    await port.recordVisit(session({ id: 'after', first_seen_at: T('10:00') }), T('10:00'));

    // Inclusive since, exclusive until, exactly as VisitCountQuery documents.
    const counts = await port.countVisits({ since: T('09:00'), until: T('10:00') });

    expect(counts?.external).toBe(1);
  });
});
