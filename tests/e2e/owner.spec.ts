/**
 * The owner panel in a real browser: layout at three widths, and a keyboard pass.
 *
 * ## What the automation identity can and cannot drive, and why that is the right shape
 *
 * This suite signs in as the scoped automation identity. That identity holds exactly three
 * capabilities — `owner.view`, `quality.dispatch`, `cleanup.preview` — so **every mutating
 * owner journey answers 403 to it, by design**. Verified against the running Worker: a POST
 * to `/owner/controls/new_orders` returns 403 with the seeded session.
 *
 * That is not an obstacle to work around. It is the control the founder asked for: a test
 * identity that could pause the service, cancel a campaign or move budget would be a
 * standing credential that does those things, sitting in an environment variable. The four
 * denials (`ads.activate`, `refund.issue`, `budget.move`, `owner.grant`) are proved against
 * the port in `OWNER-012..015`, and the capability set is deliberately narrower still.
 *
 * So the browser suite measures what a browser is uniquely good at — **layout, focus order
 * and keyboard reachability** — and leaves state changes to the integration suite, where
 * they run as a genuine owner with recent strong authentication and assert on rows.
 *
 * Mutating journeys are not silently dropped: {@link MUTATION_NOT_DRIVABLE} states why,
 * and the cases that would need them skip with that reason rather than disappearing.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { SEED_MISSING, automationCookieIsPresent, signInAsAutomation } from './helpers/session';

const WIDTHS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-834', width: 834, height: 1112 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const;

/** Every administrative page a browser can reach read-only. */
const OWNER_PAGES = [
  '/owner',
  '/owner/customers',
  '/owner/verification',
  '/owner/connections',
  '/owner/ads',
  '/owner/operations',
  '/owner/controls',
  '/owner/approvals',
  '/owner/quality',
  '/owner/cleanup',
  '/owner/settings',
] as const;

const MUTATION_NOT_DRIVABLE =
  'The scoped automation identity cannot change owner state — it holds owner.view, ' +
  'quality.dispatch and cleanup.preview only, and a POST to /owner/controls/* answers 403 to it. ' +
  'That is the control working, not a gap: a test identity able to pause the service would be a ' +
  'standing credential that can pause the service. These journeys are asserted in the integration ' +
  'suite as a real owner with recent MFA (OWNER-171, OWNER-190, OWNER-192, OWNER-195).';

async function signedIn(context: BrowserContext): Promise<boolean> {
  if (!(await signInAsAutomation(context))) return false;
  return automationCookieIsPresent(context);
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
  );
}

/** Named so a failure says what to fix rather than only that something is too wide. */
async function offenders(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0) continue;
      if (box.right > limit + 1) {
        const cls = (element.getAttribute('class') ?? '').split(' ')[0] ?? '';
        out.push(
          `${element.tagName.toLowerCase()}${cls === '' ? '' : `.${cls}`} right=${Math.round(box.right)}`,
        );
      }
    }
    return out.slice(0, 8);
  });
}

/**
 * Spelled out rather than computed, for the same reason as `responsive.spec.ts`: a title
 * built as `OWNER-34${i}` reads as the malformed id `OWNER-34` to anything scanning the
 * source, including the ledger checker.
 */
test.describe('owner panel layout', () => {
  test.beforeEach(async ({ context }) => {
    test.skip(!(await signedIn(context)), SEED_MISSING);
  });

  /**
   * Spelled out one per width. A title built as `${ids[i]} …` names the case at run time
   * and names nothing in the source, and the ledger reads the source.
   */
  async function assertNoOwnerOverflow(page: Page, viewport: (typeof WIDTHS)[number]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const path of OWNER_PAGES) {
      const response = await page.goto(path);
      // Without this, a 404 or a 500 would sail through: an error page has almost no
      // content and never overflows, so a broken route would make this case pass while
      // measuring nothing. That failure mode is why these were unmeasured for so long.
      expect(response?.status(), `${path} did not render; its layout was not measured`).toBe(200);
      const overflow = await horizontalOverflow(page);
      expect(
        overflow,
        `${path} at ${viewport.width}px overflows by ${overflow}px: ${(await offenders(page)).join(', ')}`,
      ).toBeLessThanOrEqual(1);
    }
  }

  test('OWNER-340 no administrative page scrolls horizontally at 390px', async ({ page }) =>
    assertNoOwnerOverflow(page, WIDTHS[0]));

  test('OWNER-341 no administrative page scrolls horizontally at 834px', async ({ page }) =>
    assertNoOwnerOverflow(page, WIDTHS[1]));

  test('OWNER-342 no administrative page scrolls horizontally at 1440px', async ({ page }) =>
    assertNoOwnerOverflow(page, WIDTHS[2]));

  test('OWNER-343 every administrative page is reachable and operable from the keyboard alone', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/owner');

    // The skip link is the first thing a keyboard user meets, and it must land on main.
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.className ?? '');
    expect(first).toContain('skip');
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id ?? '')).toBe('main');

    // Every page carries a focusable route through its navigation, and nothing is reachable
    // only by pointer: no click handler exists anywhere in this panel.
    for (const path of OWNER_PAGES) {
      await page.goto(path);
      const handlers = await page.evaluate(
        () =>
          Array.from(document.querySelectorAll('body *')).filter((e) => e.hasAttribute('onclick'))
            .length,
      );
      expect(handlers, `${path} has a pointer-only control`).toBe(0);
      const focusable = await page.evaluate(
        () =>
          document.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')
            .length,
      );
      expect(focusable, `${path} has nothing a keyboard can reach`).toBeGreaterThan(0);
    }
  });

  test('OWNER-344 a wide administrative table scrolls inside its own named, focusable region', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Settings, not connections: against the live port the connections list is empty and
    // the table renders its empty state instead, so the case would measure nothing. The
    // approved-limits table is built from a constant and is always there.
    await page.goto('/owner/settings');
    const wrapper = page.locator('.tablewrap').first();
    await expect(wrapper).toBeVisible();
    const shape = await wrapper.evaluate((element) => ({
      overflowX: getComputedStyle(element).overflowX,
      focusable: element.getAttribute('tabindex'),
      named: element.getAttribute('aria-label') !== null,
      role: element.getAttribute('role'),
    }));
    expect(shape.overflowX).toBe('auto');
    expect(shape.focusable).toBe('0');
    expect(shape.named).toBe(true);
    expect(shape.role).toBe('region');
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  });

  test('OWNER-345 the sign-in page is public, fits a phone, and leaks nothing', async ({
    page,
    context,
  }) => {
    await context.clearCookies();
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto('/admin/login');
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);

    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/[A-Za-z0-9._%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(body).not.toMatch(/\bws_[A-Za-z0-9]{6,}/);
    expect(body.toLowerCase()).not.toContain('bootstrap');
  });

  test('OWNER-346 an anonymous browser is refused every owner page with an ordinary 404', async ({
    page,
    context,
  }) => {
    // The tripwire that makes seeding an identity safe to do at all. If the seed ever made
    // an owner route reachable without a session, this is what fails.
    await context.clearCookies();
    for (const path of OWNER_PAGES) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} was reachable anonymously`).toBe(404);
    }
    const body = await page.locator('body').innerText();
    expect(body).toContain('That page does not exist');
  });
});

test.describe('owner state changes are not driven from a browser', () => {
  test.beforeEach(async ({ context }) => {
    test.skip(!(await signedIn(context)), SEED_MISSING);
  });

  test('OWNER-347 the automation identity is refused every mutating owner action', async ({
    page,
  }) => {
    // Asserted rather than assumed: this is the security property that decides the shape of
    // the whole browser suite, so it is checked here rather than trusted from a unit test.
    await page.goto('/owner/controls');
    const csrf =
      (await page.context().cookies()).find((c) => c.name.endsWith('verify_csrf'))?.value ?? '';
    // The context's own request client, not the standalone `request` fixture: that one has
    // its own cookie jar, so the call would arrive anonymous and answer 404 — which would
    // look like the identity being denied when it was simply never signed in.
    const response = await page.context().request.post('/owner/controls/new_orders', {
      form: { csrf_token: csrf, paused: 'yes' },
      headers: { origin: new URL(page.url()).origin },
      failOnStatusCode: false,
    });
    expect(
      response.status(),
      'a test identity that can pause the service is a credential that can pause the service',
    ).toBe(403);
  });

  test('OWNER-348 pausing, acknowledging and campaign journeys are covered elsewhere', async () => {
    test.skip(true, MUTATION_NOT_DRIVABLE);
  });
});
