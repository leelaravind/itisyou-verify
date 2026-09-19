/**
 * The visit counter as mounted middleware.
 *
 * The acceptance criteria the lead set, exercised here against the real middleware and a
 * faithful port, then again against the deployed origin by `scripts/` (see the handoff):
 * one request writes exactly one row, a second request in the same session does not write
 * a second, a crawler is `bot_suspected`, and our own marker is excluded from the external
 * count.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createVisitCounter,
  isCountablePath,
  isInternalTraffic,
  visitFromRequest,
  type VisitContext,
} from '@app/growth/visits';
import { createMemoryGrowthPort } from '@app/growth/memory';
import { VISIT_RETENTION_DAYS } from '@app/growth/analytics';

const SALT = 'a-staging-analytics-salt-long-enough';
const NOW = new Date('2026-10-07T10:00:00.000Z');

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

const INTERNAL = { headerValue: 'staging-internal-token-abc123' } as const;

function contextFor(
  url: string,
  headers: Record<string, string>,
  method = 'GET',
): VisitContext & { waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    req: { method, url, raw: { headers: new Headers(headers) } },
    executionCtx: {
      waitUntil(promise: Promise<unknown>) {
        waited.push(promise);
      },
    },
  };
}

// NOTE: `salt` is deliberately NOT a default parameter. `f(undefined)` restores a
// default, which silently turned the "no salt configured" case back into the salted one
// and made ADS-124 pass for the wrong reason until it was written to assert the row count.
function counterOver(port: ReturnType<typeof createMemoryGrowthPort>, salt: string | undefined) {
  return createVisitCounter({
    port: () => port,
    salt: () => salt,
    internal: INTERNAL,
    now: () => NOW,
  });
}

const VISITOR = {
  'cf-connecting-ip': '81.2.69.142',
  'user-agent': CHROME,
  'accept-language': 'en-GB',
};

describe('visit counter middleware', () => {
  it('ADS-114 one request to the landing page writes exactly one visit row', async () => {
    const port = createMemoryGrowthPort();
    const c = contextFor('https://verify.itisyou.app/', VISITOR);
    await counterOver(port, SALT)(c, async () => undefined);
    await Promise.all(c.waited);

    expect(port.rows.size).toBe(1);
    const row = [...port.rows.values()][0];
    expect(row?.classification).toBe('external');
    expect(row?.landing_path).toBe('/');
    expect(row?.page_views).toBe(1);
  });

  it('ADS-115 a second request from the same visitor the same day does not create a second row', async () => {
    const port = createMemoryGrowthPort();
    const counter = counterOver(port, SALT);

    const first = contextFor('https://verify.itisyou.app/', VISITOR);
    await counter(first, async () => undefined);
    await Promise.all(first.waited);

    const second = contextFor('https://verify.itisyou.app/how-it-works', VISITOR);
    await counter(second, async () => undefined);
    await Promise.all(second.waited);

    expect(port.rows.size).toBe(1);
    expect([...port.rows.values()][0]?.page_views).toBe(2);
  });

  it('ADS-116 a crawler user-agent is recorded as bot_suspected and never as external', async () => {
    const port = createMemoryGrowthPort();
    const c = contextFor('https://verify.itisyou.app/', {
      ...VISITOR,
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    });
    await counterOver(port, SALT)(c, async () => undefined);
    await Promise.all(c.waited);

    expect([...port.rows.values()][0]?.classification).toBe('bot_suspected');
    const counts = await port.countVisits({
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-11-01T00:00:00.000Z',
    });
    expect(counts?.external).toBe(0);
    expect(counts?.botSuspected).toBe(1);
  });

  it('ADS-117 our internal-test marker excludes the request from the external count', async () => {
    const port = createMemoryGrowthPort();
    const counter = counterOver(port, SALT);

    const smoke = contextFor('https://verify.itisyou.app/', {
      ...VISITOR,
      'cf-connecting-ip': '203.0.113.9',
      'x-verify-internal': INTERNAL.headerValue,
    });
    await counter(smoke, async () => undefined);
    await Promise.all(smoke.waited);

    const stranger = contextFor('https://verify.itisyou.app/', VISITOR);
    await counter(stranger, async () => undefined);
    await Promise.all(stranger.waited);

    const counts = await port.countVisits({
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-11-01T00:00:00.000Z',
    });
    expect(counts?.external).toBe(1);
    expect(counts?.internalTest).toBe(1);
  });

  it('ADS-118 the owner’s internal cookie and our own tooling user-agents are also excluded', () => {
    const cookie = new Headers({ cookie: 'theme=dark; verify_internal=1', 'user-agent': CHROME });
    expect(isInternalTraffic(cookie, INTERNAL)).toBe(true);

    const tooling = new Headers({ 'user-agent': 'itisyou-verify-smoke/1.0' });
    expect(isInternalTraffic(tooling, INTERNAL)).toBe(true);

    expect(isInternalTraffic(new Headers({ 'user-agent': CHROME }), INTERNAL)).toBe(false);
  });

  it('ADS-119 a wrong or absent internal header does not exclude, and an unset token disables the header route', () => {
    const wrong = new Headers({ 'x-verify-internal': 'not-the-token', 'user-agent': CHROME });
    expect(isInternalTraffic(wrong, INTERNAL)).toBe(false);

    // With no token configured, presenting any value must not let a stranger exclude
    // themselves — or, worse, let someone exclude everyone.
    const unset = { headerValue: null } as const;
    expect(isInternalTraffic(new Headers({ 'x-verify-internal': 'anything' }), unset)).toBe(false);
  });

  it('ADS-120 health checks, assets and the owner panel are never counted as visits', () => {
    for (const path of [
      '/health',
      '/robots.txt',
      '/favicon.ico',
      '/assets/app.css',
      '/api/v1/events',
      '/owner',
      '/owner/ads',
      '/admin/login',
      '/app/dashboard',
      '/.well-known/security.txt',
      '/demo/screenshot.png',
    ]) {
      expect(isCountablePath(path), path).toBe(false);
    }
    for (const path of ['/', '/demo', '/how-it-works', '/pricing', '/development-story']) {
      expect(isCountablePath(path), path).toBe(true);
    }
  });

  it('ADS-121 an uptime probe hitting /health a thousand times records nothing', async () => {
    const port = createMemoryGrowthPort();
    const counter = counterOver(port, SALT);
    for (let i = 0; i < 25; i += 1) {
      const c = contextFor('https://verify.itisyou.app/health', VISITOR);
      await counter(c, async () => undefined);
      await Promise.all(c.waited);
    }
    expect(port.rows.size).toBe(0);
  });

  it('ADS-122 a non-GET request is never counted', async () => {
    const port = createMemoryGrowthPort();
    const c = contextFor('https://verify.itisyou.app/', VISITOR, 'POST');
    await counterOver(port, SALT)(c, async () => undefined);
    await Promise.all(c.waited);
    expect(port.rows.size).toBe(0);
  });

  it('ADS-123 the counter fails open: a write that throws still renders the page', async () => {
    const port = createMemoryGrowthPort({ failWrites: true });
    const errors: unknown[] = [];
    const counter = createVisitCounter({
      port: () => port,
      salt: () => SALT,
      internal: INTERNAL,
      now: () => NOW,
      onError: (e) => errors.push(e),
    });
    const c = contextFor('https://verify.itisyou.app/', VISITOR);
    const next = vi.fn(async () => undefined);

    await expect(counter(c, next)).resolves.toBeUndefined();
    await Promise.all(c.waited);

    expect(next).toHaveBeenCalledOnce();
    expect(errors.length).toBe(1);
    expect(port.rows.size).toBe(0);
  });

  it('ADS-124 with no salt configured nothing is counted, rather than an unsalted hash being stored', async () => {
    const port = createMemoryGrowthPort();
    const c = contextFor('https://verify.itisyou.app/', VISITOR);
    await counterOver(port, undefined)(c, async () => undefined);
    await Promise.all(c.waited);
    expect(port.rows.size).toBe(0);
    expect(c.waited.length).toBe(0);
  });

  it('ADS-125 with no port wired nothing is counted and the page still renders', async () => {
    const counter = createVisitCounter({
      port: () => null,
      salt: () => SALT,
      internal: INTERNAL,
      now: () => NOW,
    });
    const c = contextFor('https://verify.itisyou.app/', VISITOR);
    const next = vi.fn(async () => undefined);
    await counter(c, next);
    expect(next).toHaveBeenCalledOnce();
    expect(c.waited.length).toBe(0);
  });

  it('ADS-126 nothing expensive runs before the response is produced', async () => {
    const port = createMemoryGrowthPort();
    const order: string[] = [];
    const counter = createVisitCounter({
      port: () => ({
        ...port,
        async recordVisit(session, seenAt) {
          order.push('write');
          return port.recordVisit(session, seenAt);
        },
      }),
      salt: () => SALT,
      internal: INTERNAL,
      now: () => NOW,
    });
    const c = contextFor('https://verify.itisyou.app/', VISITOR);
    await counter(c, async () => {
      order.push('render');
    });
    // The render has happened and the write has not even been started yet.
    expect(order).toEqual(['render']);
    await Promise.all(c.waited);
    expect(order).toEqual(['render', 'write']);
  });

  it('ADS-127 no raw address reaches the stored row or the port', async () => {
    const port = createMemoryGrowthPort();
    const c = contextFor(
      'https://verify.itisyou.app/?utm_campaign=organic_launch_2026_09',
      VISITOR,
    );
    await counterOver(port, SALT)(c, async () => undefined);
    await Promise.all(c.waited);

    const serialised = JSON.stringify([...port.rows.values()]);
    expect(serialised).not.toContain('81.2.69.142');
    expect(serialised).not.toContain(CHROME);
    expect([...port.rows.values()][0]?.utm_campaign).toBe('organic_launch_2026_09');
  });

  it('ADS-024 a stored visit expires after the retention period A09 sweeps on', async () => {
    const session = await visitFromRequest(
      { method: 'GET', url: 'https://verify.itisyou.app/', headers: new Headers(VISITOR) },
      SALT,
      INTERNAL,
      NOW,
    );
    // The expiry my middleware writes must be exactly A09's policy, because their sweep
    // reads the column and not the policy number.
    expect(VISIT_RETENTION_DAYS).toBe(14);
    expect(session.expires_at).toBe(new Date(NOW.getTime() + 14 * 86_400_000).toISOString());

    const port = createMemoryGrowthPort();
    await port.recordVisit(session, NOW.toISOString());

    // One day before expiry the sweep must not take it; one day after, it must.
    const before = new Date(NOW.getTime() + 13 * 86_400_000).toISOString();
    const after = new Date(NOW.getTime() + 15 * 86_400_000).toISOString();
    expect(await port.countExpiredVisits(before)).toBe(0);
    expect(await port.countExpiredVisits(after)).toBe(1);

    expect(port.purgeExpired(before)).toBe(0);
    expect(port.rows.size).toBe(1);
    expect(port.purgeExpired(after)).toBe(1);
    expect(port.rows.size).toBe(0);
  });
});
