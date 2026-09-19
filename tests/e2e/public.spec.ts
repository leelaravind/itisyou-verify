/**
 * CUST-067..CUST-076 — the public journey, in a real browser, against a real Worker.
 */
import { expect, test } from '@playwright/test';

test.describe('public journey', () => {
  test('CUST-067 the home page says what the product does and what it does not, without scrolling past the fold for the first', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Know whether your automation actually did the job.');
    // The exclusions are on the same page, not on a sub-page nobody visits.
    await expect(page.getByRole('heading', { name: 'What this does not do' })).toBeVisible();
    await expect(page.getByText('It does not fix anything')).toBeVisible();
    await expect(page.getByText('It is not instant')).toBeVisible();
  });

  test('CUST-068 every primary page is reachable from the header navigation', async ({ page }) => {
    await page.goto('/');
    for (const [label, path, heading] of [
      ['How it works', '/how-it-works', 'Three steps, and the setup work each one really needs'],
      ['Demo', '/demo', 'One workflow, four runs, four honest answers'],
      ['Pricing', '/pricing', 'One plan, one workflow, no overage'],
      ['Security', '/security', 'Where your data goes, and who else touches it'],
      ['Support', '/support', 'Answers first, then a person'],
    ] as const) {
      await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
      await page.goto('/');
    }
  });

  test('CUST-069 the demo shows one run of each of the four statuses, each with a text label', async ({ page }) => {
    await page.goto('/demo');
    for (const label of ['Verified', 'Failed', 'Unverified', 'Pending']) {
      await expect(page.locator(`[data-status="${label.toUpperCase()}"]`).first()).toBeVisible();
      await expect(page.locator(`[data-status="${label.toUpperCase()}"]`).first()).toContainText(label);
    }
    await expect(page.locator('.synthetic__tag')).toHaveText('Synthetic workspace');
    await expect(page.getByRole('note')).toContainText('Synthetic data');
  });

  test('CUST-070 the demo accepts no input at all', async ({ page }) => {
    await page.goto('/demo');
    expect(await page.locator('form').count()).toBe(0);
    expect(await page.locator('input, textarea, select, button').count()).toBe(0);
  });

  test('CUST-071 the demo shows the coverage limitation and the standing limitations as visible text', async ({ page }) => {
    await page.goto('/demo');
    const limitation = page.locator('[data-coverage-limitation]');
    await expect(limitation).toBeVisible();
    await expect(limitation).toContainText('nothing is not the same as everything passing');
    await expect(page.locator('[data-standing-limitations]')).toBeVisible();
    expect(await page.locator('details').count()).toBe(0);
  });

  test('CUST-072 the legal pages show every missing owner detail as a visible gap', async ({ page }) => {
    for (const path of ['/terms', '/privacy']) {
      await page.goto(path);
      await expect(page.locator('[data-todo-owner-input="registeredAddress"]')).toBeVisible();
      await expect(page.locator('[data-todo-owner-input="vatNumber"]')).toBeVisible();
      await expect(page.getByText('Not yet published — companyRegistrationNumber')).toBeVisible();
    }
  });

  test('CUST-073 the status page publishes no uptime figure and no green tick', async ({ page }) => {
    await page.goto('/status');
    await expect(page.getByText('We publish no uptime figure and no incident history')).toBeVisible();
    await expect(page.getByText(/all systems operational/i)).toHaveCount(0);
  });

  test('CUST-074 the development story says it is not published rather than rendering an empty page', async ({ page }) => {
    await page.goto('/development-story');
    await expect(page.getByText('Not yet published')).toBeVisible();
    await expect(page.getByText('We would rather show an empty page')).toBeVisible();
  });

  test('CUST-075 an unknown address renders a real 404 page, not a bare string', async ({ page }) => {
    const response = await page.goto('/this-does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('That page does not exist');
    await expect(page.getByRole('link', { name: 'Back to the home page' })).toBeVisible();
  });

  test('CUST-076 the skip link is the first thing a keyboard reaches and moves focus into main', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveText('Skip to main content');
    await expect(focused).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('CUST-077 the dark palette follows the operating system preference with no JavaScript involved', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark', javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(13, 18, 23)');
    await context.close();
  });

  test('CUST-078 an explicit data-theme override beats the system preference in both directions', async ({ browser }) => {
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto('/');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(241, 244, 246)');
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(13, 18, 23)');
    await context.close();
  });

  test('CUST-079 every interactive element shows a visible focus ring', async ({ page }) => {
    await page.goto('/pricing');
    const link = page.getByRole('link', { name: 'Start setting this up' });
    await link.focus();
    const outline = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
    });
    expect(outline.style).toBe('solid');
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
    expect(outline.color).toBe('rgb(26, 95, 208)');
  });
});
