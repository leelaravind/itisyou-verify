/**
 * CUST-092..CUST-095 — layout at the three widths that matter, and the screenshot pass.
 *
 * The assertion is the one that actually catches broken responsive layout: the document
 * must never scroll horizontally. A wide table is allowed to scroll — inside its own
 * container — and that is checked separately, because a table that cannot scroll at all is
 * just as broken as a page body that can.
 */
import { mkdir } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  CUSTOMER_WORKSPACE_MISSING,
  SEED_MISSING,
  automationCookieIsPresent,
  customerSurfaceReady,
  firstRunPath,
  signInAsAutomation,
} from './helpers/session';

// `caseId` is written out rather than computed from the index. A title built as
// `CUST-09${i + 2}` produces a correct id at run time and an unreadable one to anything
// scanning the source -- the ledger checker sees the literal `CUST-09`, which is not a
// well-formed id and is not a case that exists. A case id is a name, so it is spelled.
const WIDTHS = [
  { caseId: 'CUST-092', name: 'mobile-390', width: 390, height: 844 },
  { caseId: 'CUST-093', name: 'tablet-834', width: 834, height: 1112 },
  { caseId: 'CUST-094', name: 'desktop-1440', width: 1440, height: 900 },
] as const;

/** The pages a customer must be able to complete a primary task on. */
const PRIMARY_TASKS = [
  { path: '/', slug: 'home' },
  { path: '/demo', slug: 'demo' },
  { path: '/pricing', slug: 'pricing' },
  { path: '/how-it-works', slug: 'how-it-works' },
  { path: '/app', slug: 'app-workspace' },
  { path: '/app/runs', slug: 'app-runs' },
  // Resolved at run time from the seeded workspace's own run list; see `resolveTask`.
  { path: 'RUN_DETAIL', slug: 'app-run-detail' },
  { path: '/app/onboarding/outcome', slug: 'app-onboarding-outcome' },
  { path: '/terms', slug: 'terms' },
] as const;

/**
 * A run detail has no stable path: the seeded D1 workspace does not contain the synthetic
 * port's `run_syn_0002`, and measuring a 404 measures nothing. So the run-detail task is
 * resolved from the run list on the page under test, and recorded as unmeasured — as an
 * annotation, not a silent pass — when the workspace has no run to open.
 */
async function resolveTask(
  page: Page,
  task: (typeof PRIMARY_TASKS)[number],
): Promise<string | null> {
  if (task.path !== 'RUN_DETAIL') return task.path;
  const path = await firstRunPath(page);
  if (path === null) {
    test.info().annotations.push({
      type: 'unmeasured',
      description:
        'app-run-detail: the seeded workspace has no run to open, so its layout was not measured',
    });
  }
  return path;
}

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

/**
 * Four of the nine primary tasks are behind a session. Without one they answer 401, the
 * status assertion fails, and nothing is measured — which is honest, but it means the
 * largest unmeasured surface in the product stays unmeasured. So sign in first, and skip
 * with a stated reason when there is no identity to sign in as.
 */
/**
 * Written out one per width rather than generated in a loop.
 *
 * A generated title -- `${viewport.caseId} …` or `CUST-09${i + 2} …` -- produces the right
 * name at run time and no name at all in the source, and the case ledger reads the source.
 * A case id that only exists at run time is a case nothing can reconcile against, so the
 * three titles are spelled and share one body.
 */
async function assertNoHorizontalOverflow(
  page: Page,
  context: BrowserContext,
  viewport: (typeof WIDTHS)[number],
): Promise<void> {
  const seeded = (await signInAsAutomation(context)) && (await automationCookieIsPresent(context));
  test.skip(!seeded, SEED_MISSING);
  test.skip(!(await customerSurfaceReady(page)), CUSTOMER_WORKSPACE_MISSING);
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  for (const task of PRIMARY_TASKS) {
    const path = await resolveTask(page, task);
    if (path === null) continue;
    const response = await page.goto(path);
    // The status check is not incidental. An error page has almost no content and so never
    // overflows, which means a broken route would make this case pass without measuring
    // anything. Assert the page actually rendered before believing its layout.
    expect(response?.status(), `${path} did not render; its layout was not measured`).toBe(200);
    const overflow = await horizontalOverflow(page);
    expect(
      overflow,
      `${path} at ${viewport.width}px overflows by ${overflow}px: ${(await offendingElements(page)).join(', ')}`,
    ).toBeLessThanOrEqual(1);
  }
}

test('CUST-092 no page body scrolls horizontally at 390px on any primary task', async ({
  page,
  context,
}) => assertNoHorizontalOverflow(page, context, WIDTHS[0]));

test('CUST-093 no page body scrolls horizontally at 834px on any primary task', async ({
  page,
  context,
}) => assertNoHorizontalOverflow(page, context, WIDTHS[1]));

test('CUST-094 no page body scrolls horizontally at 1440px on any primary task', async ({
  page,
  context,
}) => assertNoHorizontalOverflow(page, context, WIDTHS[2]));

test('CUST-095 a wide table scrolls inside its own container rather than pushing the page sideways', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The demo's run table, not the workspace's: identical component and identical property,
  // on a page that needs no session and no database, so this case measures the layout rather
  // than the availability of the data layer.
  await page.goto('/demo');
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
test('capture screenshots at three widths', async ({ page, context }) => {
  // Best effort: the public pages shoot either way, and the authenticated ones are skipped
  // by the status check below rather than saved as pictures of a sign-in page.
  await signInAsAutomation(context);

  // Where the pictures go. Locally that is the tracked directory, because updating the
  // committed screenshots is the point of running this.
  //
  // In CI it must NOT be, and this is not a stylistic preference. Writing into a tracked
  // path leaves the working tree dirty, and `build-gate-artefact.mjs` then refuses to
  // produce a release number -- correctly, because a number computed from a modified tree
  // does not belong to any commit. That is what took the gate down from 19 September 2026,
  // the day the browser suite was brought into CI: every run since had regenerated these
  // PNGs and then failed on the dirtiness it had just created. The screenshots were never
  // the problem and neither was the refusal; they simply could not both be right.
  const outDir = process.env['SCREENSHOT_DIR'] ?? 'docs/screenshots';
  await mkdir(outDir, { recursive: true });
  for (const viewport of WIDTHS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const task of PRIMARY_TASKS) {
      const path = await resolveTask(page, task);
      if (path === null) continue;
      const response = await page.goto(path);
      // Never save a screenshot of an error page into docs/ — a picture of a 500 filed as
      // evidence that a layout works is worse than no picture at all.
      if (response?.status() !== 200) continue;
      await page.screenshot({
        path: `${outDir}/${task.slug}--${viewport.name}.png`,
        fullPage: viewport.name !== 'mobile-390',
      });
    }
  }
  expect(true).toBe(true);
});
