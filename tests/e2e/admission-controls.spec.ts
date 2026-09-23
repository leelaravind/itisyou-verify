/**
 * The admission controls, photographed at the widths a customer actually uses.
 *
 * Window resizing through the browser extension reported success and left `innerWidth` at
 * 1920, so the mobile claim could not be made honestly from that route. Playwright sets the
 * viewport for real, which is why this exists rather than a second attempt at the same
 * trick.
 */
import { test, expect } from '@playwright/test';

const WIDTHS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const;

for (const viewport of WIDTHS) {
  test(`CUST-969 the workspace controls are usable at ${String(viewport.width)}px`, async ({
    page,
    context,
  }) => {
    // A local-only admin session, seeded into the local dev database. The shared e2e
    // identity is deliberately a read-only viewer with no workflow and must stay that way;
    // photographing admin controls needs an admin, and inventing one in a throwaway local
    // database is the honest way to get it.
    const token = process.env['LOCAL_ADMIN_SESSION'];
    test.skip(token === undefined || token === '', 'LOCAL_ADMIN_SESSION is not set');
    await context.addCookies([
      { name: 'verify_session', value: token!, url: 'http://127.0.0.1:8788' },
    ]);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/app');

    // The primary action a reader looks for, and the controls this scope added.
    await expect(page.getByRole('link', { name: 'Run verification' })).toBeVisible();
    await expect(page.locator('[data-automation-panel]')).toBeVisible();
    await expect(page.locator('[data-allowance="remaining"]')).toBeVisible();

    // Nothing sticks out sideways: a control pushed off a 390px screen is not a control.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `the page overflows by ${String(overflow)}px`).toBeLessThanOrEqual(1);

    await page.screenshot({
      path: `reports/screenshots/admission-controls-${viewport.name}.png`,
      fullPage: true,
    });
  });
}
