/**
 * The owner journey in a real browser, at phone width, from the keyboard only.
 *
 * ## Why every test here begins with a skip check
 *
 * This suite runs against `wrangler dev`, and the routers it can reach are the ones mounted
 * in `apps/app/src/index.ts` — the lead's file, not mine. Until the one line
 *
 *     app.route('/', createOwnerRoutes());
 *
 * is added there, `/owner` is a 404 and these tests would fail for a reason that has
 * nothing to do with the code they are testing. They therefore check once whether the
 * surface is mounted and skip with that reason stated, rather than failing noisily or —
 * far worse — being deleted and quietly forgotten.
 *
 * The structural half of the same properties is proved today, without a browser, in
 * `tests/integration/owner/accessibility.test.ts` (OWNER-158, OWNER-159, OWNER-169,
 * OWNER-176..OWNER-189), which does run and does pass.
 */
import { expect, test, type BrowserContext } from '@playwright/test';
import { SEED_MISSING, automationCookieIsPresent, signInAsAutomation } from './helpers/session';

/**
 * These titles deliberately carry no case id. A case counts once, and the numbered versions
 * of these properties are already counted from the integration suite that actually runs;
 * giving a skipped browser test the same id would inflate the ledger with a case nobody
 * executed. When the router is mounted and this suite runs for real, the lead should assign
 * it ids from the OWNER range the ledger reserves for browser cases.
 */

/** iPhone 12-ish. Narrow enough that a broken layout scrolls sideways. */
const PHONE = { width: 390, height: 844 };

const NOT_MOUNTED = SEED_MISSING;

/**
 * Sign in as the scoped automation identity and prove the cookie landed.
 *
 * The router is mounted now, so the old "is it mounted?" probe is gone — what gates these
 * is the seeded identity, and the jar is read back rather than assumed because a cookie the
 * browser silently discards looks exactly like a broken guard.
 */
async function signedIn(context: BrowserContext): Promise<boolean> {
  if (!(await signInAsAutomation(context))) return false;
  return automationCookieIsPresent(context);
}

test.describe('owner panel — phone, keyboard only', () => {
  test.use({ viewport: PHONE });

  test('owner phone: the sign-in page works at phone width without scrolling sideways', async ({ page, context }) => {
    test.skip(!(await signedIn(context)), NOT_MOUNTED);
    await page.goto('/admin/login');
    await expect(page.getByRole('heading', { name: 'Sign in', level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('owner phone: an incident can be opened and acknowledged with the keyboard alone', async ({ page, context }) => {
    test.skip(!(await signedIn(context)), NOT_MOUNTED);
    await page.goto('/owner/operations');
    // Tab until the acknowledge button has focus; press it with the keyboard.
    for (let i = 0; i < 80; i += 1) {
      const action = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return el?.closest('form')?.getAttribute('action') ?? null;
      });
      if (action !== null && action.includes('/acknowledge')) break;
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Enter');
    await expect(page.getByText('acknowledged')).toBeVisible();
  });

  test('owner phone: the service can be paused with the keyboard, and cancelling stays reachable', async ({ page, context }) => {
    test.skip(!(await signedIn(context)), NOT_MOUNTED);
    await page.goto('/owner/controls');
    const pause = page.getByRole('button', { name: /Pause new orders/i });
    await pause.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-control="new_orders"][data-paused="true"]')).toBeVisible();

    // The whole point of the pause switches: this must still work.
    await page.goto('/app/cancel');
    expect(page.url()).toContain('/app/cancel');
    await page.goto('/support');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('owner phone: a campaign request can be cancelled from the keyboard and reads as pause requested', async ({ page, context }) => {
    test.skip(!(await signedIn(context)), NOT_MOUNTED);
    await page.goto('/owner/ads');
    const pause = page.getByRole('button', { name: /Request pause/i }).first();
    await pause.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-campaign-state="pause_pending"]')).toBeVisible();
    await expect(page.locator('[data-campaign-state="paused"]')).toHaveCount(0);
  });
});
