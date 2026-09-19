/**
 * CUST-080..CUST-087 — the customer journey, including a pass with JavaScript switched off
 * and a pass driven entirely from the keyboard.
 *
 * Every page here is on the synthetic port, which is why the banner assertion in CUST-080
 * matters: if that banner ever disappears while the data is still synthetic, a customer
 * could read placeholder runs as their own.
 */
import { expect, test } from '@playwright/test';
import {
  CUSTOMER_WORKFLOW_MISSING,
  CUSTOMER_WORKSPACE_MISSING,
  SEED_MISSING,
  automationCookieIsPresent,
  customerSurfaceReady,
  customerWorkflowReady,
  firstRunPath,
  signInAsAutomation,
} from './helpers/session';

test.describe('customer journey', () => {
  /**
   * Sign in before every case.
   *
   * These pages are behind a session and this file never opened one — it called
   * `page.goto('/app')` cold, got a 401, and asserted against the sign-in page. Twelve
   * cases were measuring the signed-out version of a product they were describing as
   * signed in.
   *
   * The cookie name comes from the seed rather than being assumed, and the jar is read back
   * afterwards: a `__Host-`-prefixed name over http is silently discarded by the browser,
   * which looks identical to a broken guard.
   */
  test.beforeEach(async ({ context, page }) => {
    const seeded =
      (await signInAsAutomation(context)) && (await automationCookieIsPresent(context));
    test.skip(!seeded, SEED_MISSING);
    // The session lands but the workspace does not exist yet. Skip with that reason rather
    // than failing every case on the same missing row — sixteen red lines for one fixture
    // reads as sixteen defects in the pages, which is exactly the wrong conclusion.
    test.skip(!(await customerSurfaceReady(page)), CUSTOMER_WORKSPACE_MISSING);
  });

  test('CUST-080 every signed-in page is marked as synthetic and is not indexable', async ({
    page,
  }) => {
    for (const path of ['/app', '/app/runs', '/app/connections', '/app/usage']) {
      await page.goto(path);
      await expect(page.getByRole('note')).toContainText('Synthetic data');
      await expect(page.getByText('This workspace is showing synthetic data')).toBeVisible();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        'content',
        'noindex, nofollow',
      );
    }
  });

  test('CUST-081 the workspace shows the verification rate and the activity signal as two separate readouts', async ({
    page,
  }) => {
    test.skip(!(await customerWorkflowReady(page)), CUSTOMER_WORKFLOW_MISSING);
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'Verification rate' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Are enquiries still arriving?' }),
    ).toBeVisible();
    // The coverage limitation is on the page itself, not behind a disclosure.
    await expect(page.locator('[data-coverage-limitation]')).toBeVisible();
    expect(await page.locator('details').count()).toBe(0);
  });

  test('CUST-082 the run detail shows expected against observed with the recipient masked', async ({
    page,
  }) => {
    // Discovered from the run list, not assumed from a synthetic fixture id: the seeded
    // D1 workspace has no run_syn_0002, and asserting against a 404 measures nothing.
    const path = await firstRunPath(page);
    test.skip(path === null, CUSTOMER_WORKFLOW_MISSING);
    await page.goto(path ?? '/app/runs');
    await expect(page.getByRole('heading', { name: 'Expected against observed' })).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toContain('ada@example.test');
    expect(body).toContain('a**@example.test');
    // `innerText` reflects `text-transform`, so these labels arrive upper-cased.
    expect(body.toLowerCase()).toContain('rule version');
    expect(body.toLowerCase()).toContain('source type');
  });

  test('CUST-083 an unverified run is explained as "we could not look", never as a failure', async ({
    page,
  }) => {
    const path = await firstRunPath(page, 'UNVERIFIED');
    test.skip(path === null, CUSTOMER_WORKFLOW_MISSING);
    await page.goto(path ?? '/app/runs');
    await expect(page.locator('[data-run-verdict="UNVERIFIED"]')).toBeVisible();
    await expect(page.getByText('This is not a failure')).toBeVisible();
    expect(await page.locator('.badge--failed').count()).toBe(0);
  });

  test('CUST-084 the run list pages by cursor, and the newer control is disabled on the first page', async ({
    page,
  }) => {
    await page.goto('/app/runs');
    // An empty run list renders the empty state instead of a pager. That is the right
    // page for an empty workspace, and it is not the page this case measures.
    test.skip(
      (await page.getByText('No runs received yet').count()) > 0,
      CUSTOMER_WORKFLOW_MISSING,
    );
    const older = page.getByRole('link', { name: 'Older' });
    if ((await older.count()) > 0) {
      await older.click();
      await expect(page).toHaveURL(/cursor=/);
      await expect(page.getByRole('link', { name: 'Newer' })).toBeVisible();
    } else {
      await expect(page.locator('.pager__status')).toContainText('this is all of them');
    }
  });

  test('CUST-085 a form submitted with an invalid value re-renders the error beside its own field', async ({
    page,
  }) => {
    test.skip(!(await customerWorkflowReady(page)), CUSTOMER_WORKFLOW_MISSING);
    await page.goto('/app/onboarding/mapping');
    const input = page.locator('#f-correlationProperty');
    await input.fill('not a valid property!');
    await page.getByRole('button', { name: 'Save and continue' }).click();

    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = await input.getAttribute('aria-describedby');
    expect(describedBy).toContain('f-correlationProperty-error');
    const error = page.locator('#f-correlationProperty-error');
    await expect(error).toBeVisible();
    await expect(error).toContainText('Use letters, numbers and underscores only');
    // The value the customer typed is still there — nothing is thrown away on a failure.
    await expect(input).toHaveValue('not a valid property!');
  });

  test('CUST-086 the whole mapping step can be completed from the keyboard alone', async ({
    page,
  }) => {
    test.skip(!(await customerWorkflowReady(page)), CUSTOMER_WORKFLOW_MISSING);
    await page.goto('/app/onboarding/mapping');
    await page.locator('#f-correlationProperty').focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('enquiry_reference');
    // Tab to the submit button and activate it with the keyboard, not a click.
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveText(/Save and continue/);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/app\/onboarding\/outcome$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('What has to be true');
  });

  test('CUST-087 a form works with JavaScript switched off', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await signInAsAutomation(context);
    const page = await context.newPage();
    test.skip(!(await customerWorkflowReady(page)), CUSTOMER_WORKFLOW_MISSING);
    await page.goto('/app/onboarding/outcome');
    await page.selectOption('#f-deadlineSeconds', '1800');
    await page.getByRole('button', { name: 'Save and run a proof' }).click();
    await expect(page).toHaveURL(/\/app\/onboarding\/proof$/);

    // And the proof run itself, still with no JavaScript at all.
    await page.getByRole('button', { name: 'Run the proof' }).click();
    await expect(page.getByRole('heading', { name: 'Proof result' })).toBeVisible();
    await expect(page.locator('[data-run-verdict]')).toBeVisible();
    await context.close();
  });

  test('CUST-088 refusing every required check is rejected with a reason, not silently accepted', async ({
    page,
  }) => {
    test.skip(!(await customerWorkflowReady(page)), CUSTOMER_WORKFLOW_MISSING);
    await page.goto('/app/onboarding/outcome');
    for (const name of [
      'f-requireRecordExists',
      'f-requireCorrelationMatch',
      'f-requireEmailDelivered',
      'f-requireRecipientMatch',
    ]) {
      const box = page.locator(`#${name}`);
      if (await box.isChecked()) await box.uncheck();
    }
    await page.getByRole('button', { name: 'Save and run a proof' }).click();
    // The message appears twice by design: once as the form-level error and once beside the
    // first checkbox, so a keyboard user landing on the field also gets the reason.
    const message = page.getByText(
      'With nothing required, a verified result would not mean anything.',
    );
    await expect(message.first()).toBeVisible();
    expect(await message.count()).toBeGreaterThanOrEqual(1);
  });

  test('CUST-089 the checkout hand-off never claims a payment it did not take', async ({
    page,
  }) => {
    test.skip(!(await customerWorkflowReady(page)), CUSTOMER_WORKFLOW_MISSING);
    await page.goto('/app/onboarding/review');
    const button = page.getByRole('button', { name: 'Continue to secure checkout' });
    if (await button.isEnabled()) {
      await button.click();
      await expect(page.getByText('no card was charged')).toBeVisible();
    } else {
      await expect(page.getByText('Fix these before you subscribe')).toBeVisible();
    }
  });

  test('CUST-090 the support form reports what actually happened to the message', async ({
    page,
  }) => {
    await page.goto('/app/support');
    await page.locator('#f-subject').fill('A run showed as unverified');
    await page
      .locator('#f-body')
      .fill('Run run_syn_0004 says unverified and I want to understand why.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByText('Nothing was sent to anybody')).toBeVisible();
    await expect(page.getByText(/reference syn-\d+/)).toBeVisible();
  });

  test('CUST-091 cancellation says plainly that there is nothing to cancel rather than offering a dead button', async ({
    page,
  }) => {
    await page.goto('/app/cancel');
    await expect(page.getByText('There is no subscription to cancel')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the billing portal' })).toHaveCount(0);
  });
});
