/**
 * CUST-092..CUST-095 — layout at the three widths that matter, and the screenshot pass.
 *
 * The assertion is the one that actually catches broken responsive layout: the document
 * must never scroll horizontally. A wide table is allowed to scroll — inside its own
 * container — and that is checked separately, because a table that cannot scroll at all is
 * just as broken as a page body that can.
 */
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const WIDTHS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'tablet-834', width: 834, height: 1112 },
  { name: 'desktop-1440', width: 1440, height: 900 },
] as const;

/** The pages a customer must be able to complete a primary task on. */
const PRIMARY_TASKS = [
  { path: '/', slug: 'home' },
  { path: '/demo', slug: 'demo' },
  { path: '/pricing', slug: 'pricing' },
  { path: '/how-it-works', slug: 'how-it-works' },
  { path: '/app', slug: 'app-workspace' },
  { path: '/app/runs', slug: 'app-runs' },
  { path: '/app/runs/run_syn_0002', slug: 'app-run-detail' },
  { path: '/app/onboarding/outcome', slug: 'app-onboarding-outcome' },
  { path: '/terms', slug: 'terms' },
] as const;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = document.documentElement;
    return Math.max(0, root.scrollWidth - root.clientWidth);
  });
}

/** Any element sticking out past the viewport, named so a failure says what to fix. */
async function offendingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const names: string[] = [];
    for (const element of Array.from(document.querySelectorAll('body *'))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0) continue;
      if (box.right > limit + 1) {
        const tag = element.tagName.toLowerCase();
        const cls = (element.getAttribute('class') ?? '').split(' ')[0] ?? '';
        names.push(`${tag}${cls === '' ? '' : `.${cls}`} right=${Math.round(box.right)}`);
      }
    }
    return names.slice(0, 8);
  });
}

for (const viewport of WIDTHS) {
  test(`CUST-09${WIDTHS.indexOf(viewport) + 2} no page body scrolls horizontally at ${viewport.width}px on any primary task`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const task of PRIMARY_TASKS) {
      await page.goto(task.path);
      const overflow = await horizontalOverflow(page);
      expect(overflow, `${task.path} at ${viewport.width}px overflows by ${overflow}px: ${(await offendingElements(page)).join(', ')}`).toBeLessThanOrEqual(1);
    }
  });
}

test('CUST-095 a wide table scrolls inside its own container rather than pushing the page sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/app/runs');
  const wrapper = page.locator('.tablewrap').first();
  await expect(wrapper).toBeVisible();
  const scrollable = await wrapper.evaluate((element) => ({
    overflowX: getComputedStyle(element).overflowX,
    canScroll: element.scrollWidth > element.clientWidth,
    focusable: element.getAttribute('tabindex'),
    named: element.getAttribute('aria-label') !== null,
  }));
  expect(scrollable.overflowX).toBe('auto');
  expect(scrollable.canScroll).toBe(true);
  expect(scrollable.focusable).toBe('0');
  expect(scrollable.named).toBe(true);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
});

/**
 * Not a test of behaviour — it captures the screenshots that get looked at. It asserts
 * nothing beyond the page having loaded, so it does not count as a case in the ledger.
 */
test('capture screenshots at three widths', async ({ page }) => {
  await mkdir('docs/screenshots', { recursive: true });
  for (const viewport of WIDTHS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const task of PRIMARY_TASKS) {
      await page.goto(task.path);
      await page.screenshot({
        path: `docs/screenshots/${task.slug}--${viewport.name}.png`,
        fullPage: viewport.name !== 'mobile-390',
      });
    }
  }
  expect(true).toBe(true);
});
