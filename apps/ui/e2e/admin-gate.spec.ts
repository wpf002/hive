import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, stateFor } from './accounts';

/**
 * The boundary between the product and the machinery.
 *
 * The product is the swarm console. Everything under the operator console —
 * bots, jobs, schedules, workers, trading — is admin-only, and a customer
 * following one of those links should land on the product rather than on an
 * error or, far worse, on the machinery.
 *
 * This is the specific thing a mocked test would not have caught: the gate is
 * in a server layout, so it only exists when something really renders.
 */
test.describe('operator console is admin-only — as a customer', () => {
  test.use({ storageState: stateFor(CUSTOMER.email) });

  test('a customer following an operator link lands on the product', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/$/);
  });

  test('every operator route redirects a customer, not just the first', async ({ page }) => {
    for (const route of ['/bots', '/jobs', '/workers', '/schedules', '/templates', '/trading']) {
      await page.goto(route);
      await expect(page, `${route} should not be reachable by a customer`).toHaveURL(/\/$/);
    }
  });

  test('a customer can still reach their own settings', async ({ page }) => {
    // The gate's obvious failure mode: locking customers out of the account
    // pages that used to live inside the operator shell.
    await page.goto('/account/password');
    await expect(page).toHaveURL(/\/account\/password/);
    await expect(page.getByRole('link', { name: /back to swarm/i })).toBeVisible();
  });

  test('a customer is not offered the operator console', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /account/i }).click();
    await expect(page.getByRole('menuitem', { name: /change password/i })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /operator console/i })).toHaveCount(0);
  });

});

test.describe('operator console is admin-only — as an admin', () => {
  test.use({ storageState: stateFor(ADMIN.email) });

  test('an admin reaches the operator console and is offered it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /account/i }).click();
    await expect(page.getByRole('menuitem', { name: /operator console/i })).toBeVisible();
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
