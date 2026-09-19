/**
 * Visit identity and classification.
 *
 * The properties: no durable identifier survives a day, no raw address is ever stored, our
 * own traffic never counts, and a crawler never counts.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  type VisitRequestInput,
  buildVisitSession,
  classifyVisit,
  parseUtm,
  utcDateKey,
  visitSessionId,
} from '@app/growth/analytics';

const SALT = 'a-test-analytics-salt-of-sufficient-length';
const DAY_ONE = new Date('2026-10-06T23:59:00.000Z');
const DAY_TWO = new Date('2026-10-07T00:01:00.000Z');

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const VISIT: VisitRequestInput = {
  ip: '81.2.69.142',
  user_agent: CHROME,
  accept_language: 'en-GB',
  path: '/',
  query: '?utm_source=reddit&utm_medium=cpc&utm_campaign=verify_first_test',
  internal_test_marker: false,
  method: 'GET',
};

describe('visit classification', () => {
  it('ADS-009 a visit from a known bot user agent is classified bot_suspected', async () => {
    for (const ua of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'python-requests/2.32.3',
      'curl/8.9.1',
      'Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/141.0 Safari/537.36',
      'ClaudeBot/1.0',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0)',
    ]) {
      const built = await buildVisitSession({ ...VISIT, user_agent: ua }, SALT, DAY_ONE);
      expect(built.classification, ua).toBe('bot_suspected');
    }
    // And a plain browser is not swept up by the exclusion list.
    expect((await buildVisitSession(VISIT, SALT, DAY_ONE)).classification).toBe('external');
  });

  it('ADS-010 a visit carrying the internal test marker is classified internal_test', async () => {
    const marked = await buildVisitSession({ ...VISIT, internal_test_marker: true }, SALT, DAY_ONE);
    expect(marked.classification).toBe('internal_test');

    // The owner's own declared session id is excluded too, even with a perfect user agent.
    const id = await visitSessionId(VISIT, SALT, DAY_ONE);
    expect(classifyVisit({ ...VISIT, owner_session_ids: [id] }, id)).toBe('internal_test');
  });

  it('ADS-011 a visit session id is a salted daily hash and no raw IP is stored', async () => {
    const dayOne = await visitSessionId(VISIT, SALT, DAY_ONE);
    const dayTwo = await visitSessionId(VISIT, SALT, DAY_TWO);

    expect(dayOne).toMatch(/^[0-9a-f]{64}$/);
    expect(utcDateKey(DAY_ONE)).not.toBe(utcDateKey(DAY_TWO));
    expect(dayOne).not.toBe(dayTwo);

    const stored = await buildVisitSession(VISIT, SALT, DAY_ONE);
    const serialised = JSON.stringify(stored);
    expect(serialised).not.toContain(VISIT.ip);
    expect(serialised).not.toContain(CHROME);
    expect(Object.keys(stored)).not.toContain('ip');
    expect(Object.keys(stored)).not.toContain('user_agent');
  });

  it('ADS-012 UTM parameters are bounded in length and sanitised before storage', async () => {
    expect(
      parseUtm('?utm_source=<script>alert(1)</script>&utm_campaign=verify_first_test'),
    ).toEqual({
      source: null,
      medium: null,
      campaign: 'verify_first_test',
    });
    const long = 'a'.repeat(200);
    // Truncated to 64 characters, and the truncated value is still checked before storage.
    expect(parseUtm(`utm_source=${long}`).source).toHaveLength(64);
    const stored = await buildVisitSession(
      { ...VISIT, query: `?utm_campaign=${long}` },
      SALT,
      DAY_ONE,
    );
    expect(stored.utm_campaign).toHaveLength(64);
    expect(parseUtm('utm_source=reddit').source).toBe('reddit');
  });

  it('ADS-064 the same visitor twice in one day hashes identically, so a visit can be deduplicated', async () => {
    const morning = await visitSessionId(VISIT, SALT, new Date('2026-10-07T08:00:00.000Z'));
    const evening = await visitSessionId(VISIT, SALT, new Date('2026-10-07T19:30:00.000Z'));
    expect(morning).toBe(evening);
  });

  it('ADS-065 a different salt produces a different id, so the salt is doing work', async () => {
    const a = await visitSessionId(VISIT, SALT, DAY_ONE);
    const b = await visitSessionId(VISIT, `${SALT}-rotated`, DAY_ONE);
    expect(a).not.toBe(b);
  });

  it('ADS-066 a short or missing salt is refused rather than silently producing a reversible hash', async () => {
    await expect(visitSessionId(VISIT, 'short', DAY_ONE)).rejects.toThrow(/ANALYTICS_SALT/);
    await expect(visitSessionId(VISIT, '', DAY_ONE)).rejects.toThrow(/ANALYTICS_SALT/);
  });

  it('ADS-067 an empty user agent is unknown — not external, and not asserted to be a bot', async () => {
    const built = await buildVisitSession({ ...VISIT, user_agent: '   ' }, SALT, DAY_ONE);
    expect(built.classification).toBe('unknown');
  });

  it('ADS-068 a non-GET request is not counted as a visit', () => {
    expect(classifyVisit({ ...VISIT, method: 'HEAD' }, 'sid')).toBe('bot_suspected');
    expect(classifyVisit({ ...VISIT, method: 'POST' }, 'sid')).toBe('bot_suspected');
  });

  it('ADS-113 no growth or ads source file embeds a raw control character', () => {
    // A single raw NUL in analytics.ts once made the whole file register as binary, so
    // `grep` printed "Binary file ... matches" and no lines — a search for a constant in
    // that file silently found nothing while the constant sat there. The compiler, the
    // tests and the linter were all happy. A control character used as a delimiter must be
    // written as an escape sequence, never pasted in literally. This test is the guard.
    const roots = [
      new URL('../../../apps/app/src/growth/', import.meta.url),
      new URL('../../../packages/connectors/src/ads/', import.meta.url),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      const dir = fileURLToPath(root);
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts')) continue;
        const bytes = readFileSync(join(dir, name));
        for (const [index, byte] of bytes.entries()) {
          // Tab, line feed and carriage return are the only control bytes source may hold.
          if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
            offenders.push(
              `${name}: byte 0x${byte.toString(16).padStart(2, '0')} at offset ${index}`,
            );
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
