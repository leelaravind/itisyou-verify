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
import { expect, test, type BrowserContext } from '@playwright/test';
import { SEED_MISSING, automationCookieIsPresent, signInAsAutomation } from './helpers/session';

const PHONE = { width: 390, height: 844 };

const NEEDS_IDENTITY = SEED_MISSING;

/**
 * Sign in, and prove the cookie actually landed.
 *
 * This helper previously hard-coded `__Host-verify_session`, which the browser rejects over
 * http because the prefix requires `Secure` — so nothing was stored and every page was
 * measured signed out. The name now comes from the seed, and `automationCookieIsPresent`
 * checks the jar rather than trusting that `addCookies` meant anything.
 */
async function signedIn(context: BrowserContext): Promise<boolean> {
  if (!(await signInAsAutomation(context))) return false;
  return automationCookieIsPresent(context);
}

const NO_CAMPAIGNS =
  'The live owner port returns no campaigns, so there is no rendered campaign state to measure. That is the ' +
  'third-category gap already reported: D1OwnerDataPort.campaigns() is not wired. This case asserts the moment ' +
  'one exists.';

test.describe('advertising, in a browser', () => {
  test.beforeEach(async ({ context }) => {
    test.skip(!(await signedIn(context)), NEEDS_IDENTITY);
  });

  test('ADS-026 a campaign never renders as paused on our own say-so, and a stale metric says so', async ({
    page,
  }) => {
    await page.goto('/owner/ads');
    const states = page.locator('[data-campaign-state]');
    const count = await states.count();
    test.skip(count === 0, NO_CAMPAIGNS);

    // The property: `paused` is a claim about the platform, and we may only make it from a
    // provider read. Anything we merely requested reads `pause_pending`.
    for (let i = 0; i < count; i += 1) {
      const state = await states.nth(i).getAttribute('data-campaign-state');
      if (state === 'paused') {
        await expect(
          page.getByText(/reports this campaign is paused|you confirmed you saw this paused/i),
        ).toBeVisible();
      }
    }
    // A figure we have not refreshed recently enough to act on is marked in the row itself.
    const stale = page.locator('[data-stale="true"]');
    if ((await stale.count()) > 0) await expect(stale.first()).toBeVisible();

    // Driving the pause itself is deliberately not possible here: `ads.pause` is outside the
    // automation identity's capability set. OWNER-195 asserts that journey as a real owner.
  });

  test('ADS-027 the rendered launch figures are four separate numbers and leak no individual visitor', async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    const response = await page.goto('/owner');
    expect(response?.status(), '/owner did not render; its figures were not measured').toBe(200);

    for (const label of [
      'People who visited',
      'Of those, arrived from an advert',
      'Created a workspace and connected something',
      'Paying customers',
    ]) {
      await expect(page.locator(`[data-launch-metric="${label}"]`)).toBeVisible();
    }

    const body = await page.locator('body').innerText();
    // Whitespace-tolerant: the sentence wraps in the rendered HTML, so a literal match
    // would fail on formatting rather than on meaning.
    expect(body.replace(/\s+/g, ' ')).toMatch(
      /A visit is not interest, and interest is not a customer/i,
    );
    expect(body.replace(/\s+/g, ' ')).toMatch(/only one of the four that is income/i);

    // The browser-level half of ADS-025: counts only. No landing path, no session id, no
    // per-visitor identifier reaches the page.
    expect(body).not.toMatch(/vs_[A-Za-z0-9]{6,}/);
    expect(body).not.toMatch(/utm_[a-z]+=/);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
