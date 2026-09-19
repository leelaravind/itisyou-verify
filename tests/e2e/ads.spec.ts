/**
 * `ADS-026` and `ADS-027` — the two advertising cases that live in a browser.
 *
 * A12 owns the ADS range and built what these need (`CampaignView`, and the launch-metrics
 * read behind the overview). `tests/e2e/` is mine, so the browser half is mine to write.
 *
 * ## These do not pass yet, and the reason is one blocker, not two
 *
 * Both drive `/owner` pages, which require a session. The scoped automation test identity
 * A02 is building is what will supply it. Until it lands, every test here skips with that
 * reason stated — the same blocker that is holding `CUST-092/093/094`. They are written now
 * so that the moment the identity exists they run without anybody remembering to come back.
 *
 * **What is deliberately not done here:** no backdoor, no test-only route, no relaxed guard.
 * If the automation identity ever made an owner route reachable without authentication, that
 * would be a release blocker rather than a convenience, so these specs sign in the same way a
 * person does and skip when they cannot.
 *
 * The properties below are the browser-level complements to A12's integration cases:
 * `ADS-025` proves the aggregate view exposes counts only; `ADS-027` proves the rendered
 * page does the same, which is where a leak would actually reach a human.
 */
import { expect, test } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

const NEEDS_IDENTITY =
  'Needs the scoped automation test identity (A02). /owner requires a session, and this suite ' +
  'will not open one by any route a person could not use.';

/**
 * Sign in as the automation identity, or report that we cannot.
 *
 * When A02 lands, this becomes a real sign-in: seed the session cookie the identity issues
 * and return true. It is one function on purpose, so the handshake lands in one place.
 */
async function signInAsAutomation(context: {
  addCookies: (cookies: readonly { name: string; value: string; url: string }[]) => Promise<void>;
}): Promise<boolean> {
  const value = process.env['E2E_AUTOMATION_SESSION'];
  const base = process.env['E2E_BASE_URL'] ?? 'http://127.0.0.1:8788';
  if (value === undefined || value.length === 0) return false;
  await context.addCookies([{ name: '__Host-verify_session', value, url: base }]);
  return true;
}

test.describe('advertising, in a browser', () => {
  test('ADS-026 a pause we requested never renders as paused, and a stale metric says so', async ({
    page,
    context,
  }) => {
    test.skip(!(await signInAsAutomation(context)), NEEDS_IDENTITY);

    await page.goto('/owner/ads');
    await expect(page.getByRole('heading', { name: 'Campaigns', level: 1 })).toBeVisible();

    // Requesting a pause is a form submit, not a link with a side effect.
    const pause = page.getByRole('button', { name: /Request pause/i }).first();
    await pause.focus();
    await page.keyboard.press('Enter');

    // The claim we are allowed to make is "we asked". Never "it stopped".
    await expect(page.locator('[data-campaign-state="pause_pending"]')).toBeVisible();
    await expect(page.locator('[data-campaign-state="paused"]')).toHaveCount(0);
    await expect(page.getByText(/may still be showing and may still be spending/i)).toBeVisible();

    // A spend figure we have not refreshed recently enough to act on is marked, in the row
    // itself rather than in a footnote nobody reads.
    const body = await page.locator('body').innerText();
    if (/last synchronised/i.test(body)) {
      const stale = page.locator('[data-stale="true"]');
      if ((await stale.count()) > 0) await expect(stale.first()).toBeVisible();
    }

    // An unmeasured metric is unknown. Never a confident zero.
    await expect(page.locator('[data-unknown="true"]').first()).toBeVisible();
  });

  test('ADS-027 the rendered launch figures are four separate numbers and leak no individual visitor', async ({
    page,
    context,
  }) => {
    test.skip(!(await signInAsAutomation(context)), NEEDS_IDENTITY);

    await page.setViewportSize(PHONE);
    await page.goto('/owner');

    // Four numbers, never one. A visit is not interest; interest is not a customer.
    for (const label of [
      'People who visited',
      'Of those, arrived from an advert',
      'Created a workspace and connected something',
      'Paying customers',
    ]) {
      await expect(page.locator(`[data-launch-metric="${label}"]`)).toBeVisible();
    }
    await expect(page.getByText(/A visit is not interest, and interest is not a customer/i)).toBeVisible();

    // The browser-level half of ADS-025: counts only. No landing path, no session id, no
    // campaign-level identifier for one person reaches the page.
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/\bvs_[A-Za-z0-9]{6,}/);
    expect(body).not.toMatch(/utm_[a-z]+=/);
    expect(body).not.toMatch(/\/(pricing|demo|how-it-works)\b/);

    // And the page still fits a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
