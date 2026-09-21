/**
 * CUST-067..CUST-076 — the public journey, in a real browser, against a real Worker.
 */
import { expect, test } from '@playwright/test';
import { DARK, LIGHT } from '@verify/ui';

/**
 * A token's hex as the browser reports it.
 *
 * Three cases in this file hard-coded colours as `rgb(...)` literals. When the
 * owner-approved palette replaced those values they began failing in CI and stayed failing
 * for hours, because the release gate never read the browser report — so the literals were
 * wrong AND nothing said so. Deriving them here means a palette change updates the
 * expectation and a palette REGRESSION still fails, which a pasted literal cannot do.
 */
function rgbOf(hex: string): string {
  const value = hex.replace('#', '');
  const n = Number.parseInt(value, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test.describe('public journey', () => {
  test('CUST-067 the home page says what the product does and what it does not, without scrolling past the fold for the first', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'Know whether your automation actually did the job.',
    );
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
      await page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: label, exact: true })
        .click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole('heading', { level: 1 })).toContainText(heading);
      await page.goto('/');
    }
  });

  test('CUST-069 the demo shows one run of each of the four statuses, each with a text label', async ({
    page,
  }) => {
    await page.goto('/demo');
    for (const label of ['Verified', 'Failed', 'Unverified', 'Pending']) {
      await expect(page.locator(`[data-status="${label.toUpperCase()}"]`).first()).toBeVisible();
      await expect(page.locator(`[data-status="${label.toUpperCase()}"]`).first()).toContainText(
        label,
      );
    }
    await expect(page.locator('.synthetic__tag')).toHaveText('Synthetic workspace');
    await expect(page.getByRole('note')).toContainText('Synthetic data');
  });

  test('CUST-070 the demo accepts no input at all', async ({ page }) => {
    await page.goto('/demo');
    expect(await page.locator('form').count()).toBe(0);
    expect(await page.locator('input, textarea, select, button').count()).toBe(0);
  });

  test('CUST-071 the demo shows the coverage limitation and the standing limitations as visible text', async ({
    page,
  }) => {
    await page.goto('/demo');
    const limitation = page.locator('[data-coverage-limitation]');
    await expect(limitation).toBeVisible();
    await expect(limitation).toContainText('nothing is not the same as everything passing');
    await expect(page.locator('[data-standing-limitations]')).toBeVisible();
    expect(await page.locator('details').count()).toBe(0);
  });

  test('CUST-072 the legal pages show the real, owner-confirmed identity, not a placeholder gap', async ({
    page,
  }) => {
    for (const path of ['/terms', '/privacy']) {
      await page.goto(path);
      await expect(
        page.getByText('Lytchett House, 13 Freeland Park, Wareham Road, Poole, Dorset, BH16 6FA, United Kingdom'),
      ).toBeVisible();
      await expect(page.getByText('Not VAT-registered')).toBeVisible();
      await expect(page.getByText('Not applicable (sole trader)')).toBeVisible();
      await expect(page.locator('[data-todo-owner-input]')).toHaveCount(0);
    }
  });

  test('CUST-073 the status page publishes no uptime figure and no green tick', async ({
    page,
  }) => {
    await page.goto('/status');
    await expect(
      page.getByText('We publish no uptime figure and no incident history'),
    ).toBeVisible();
    await expect(page.getByText(/all systems operational/i)).toHaveCount(0);
  });

  test('CUST-074 the development story either renders real content or says plainly that it is not published', async ({
    page,
  }) => {
    await page.goto('/development-story');

    // The story is published by copying `docs/development-story.md` into the Worker's
    // static assets. Both outcomes are correct, and the page must be honest about which
    // one the reader is looking at — what must never happen is an empty page, or a
    // heading with nothing underneath it, implying the story exists when it does not.
    const notPublished = page.getByText('Not yet published');
    const isUnpublished = (await notPublished.count()) > 0;

    if (isUnpublished) {
      await expect(notPublished).toBeVisible();
      await expect(page.getByText('We would rather show an empty page')).toBeVisible();
      return;
    }

    // Published: assert it is the real narrative, not a stub. The page supplies its own
    // h1; what matters is that the body carries the sections recording what went WRONG.
    // A story that lists only successes is marketing, and this page is not that.
    await expect(page.getByRole('heading', { level: 1 })).toContainText('How this was built');
    await expect(
      page.getByText('The allowance reservation that silently did nothing'),
    ).toBeVisible();
    await expect(page.getByText('33% that displayed as 100%')).toBeVisible();
    const bodyLength = (await page.locator('main').innerText()).length;
    expect(bodyLength).toBeGreaterThan(2000);
  });

  test('CUST-075 an unknown address renders a real 404 page, not a bare string', async ({
    page,
  }) => {
    const response = await page.goto('/this-does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('That page does not exist');
    await expect(page.getByRole('link', { name: 'Back to the home page' })).toBeVisible();
  });

  test('CUST-076 the skip link is the first thing a keyboard reaches and moves focus into main', async ({
    page,
  }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused).toHaveText('Skip to main content');
    await expect(focused).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('CUST-077 the approved palette is served whatever the operating system prefers, with no JavaScript', async ({
    browser,
  }) => {
    // Rewritten 20 September 2026, and the rename is the point.
    //
    // This case asserted that the dark palette FOLLOWED the operating system preference.
    // Commit 51f39f7 deliberately ended that: honouring the preference meant most machines
    // — which are set light — saw the page unchanged, so an owner-approved redesign had
    // been deployed where almost nobody would see it. Dark is now unconditional.
    //
    // The case had also hard-coded `rgb(13, 18, 23)`, the PREVIOUS dark paper. The approved
    // palette replaced it in 48c5287 and this literal has been failing in CI ever since,
    // invisibly, because the release gate did not read the browser report.
    //
    // So it now asserts the property rather than a literal: the SAME colour is served under
    // a light preference and a dark one, it is the value the token module actually defines,
    // and no JavaScript is involved in either.
    const read = async (colorScheme: 'dark' | 'light'): Promise<string> => {
      const context = await browser.newContext({ colorScheme, javaScriptEnabled: false });
      const page = await context.newPage();
      await page.goto('/');
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await context.close();
      return background;
    };

    const underDark = await read('dark');
    const underLight = await read('light');

    expect(underDark, 'the preference changed what was served').toBe(underLight);
    expect(underDark).toBe(rgbOf(DARK.paper));
  });

  test('CUST-078 the explicit override reaches both palettes, so neither becomes unreachable', async ({
    browser,
  }) => {
    // The light palette is not deleted — it stays complete and stays measured by the
    // contrast suite — and the explicit toggle is now the ONLY way to it. That makes this
    // case the thing standing between "we kept light reachable" and a palette nobody can
    // get to. Values come from the token module for the same reason as CUST-077: both
    // literals here were the pre-Stitch colours and had been failing since 48c5287.
    const context = await browser.newContext({ colorScheme: 'dark' });
    const page = await context.newPage();
    await page.goto('/');

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      rgbOf(LIGHT.paper),
    );

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      rgbOf(DARK.paper),
    );

    await context.close();
  });

  test('CUST-079 every interactive element shows a visible focus ring', async ({ page }) => {
    // Was the pricing page's sign-up call to action, which has been taken down while the
    // activation path is closed. Uses a link that is not tied to that state.
    await page.goto('/');
    const link = page.getByRole('link', { name: 'See a worked example' }).first();
    await link.focus();
    const outline = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor };
    });
    expect(outline.style).toBe('solid');
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
    // Read from the token module, not written down. The literal here was the pre-Stitch
    // focus blue and had been failing since the approved palette landed.
    expect(outline.color).toBe(rgbOf(DARK.focus));
  });
});
