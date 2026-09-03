import { test, expect } from '@playwright/test';
import { CUSTOMER, stateFor } from './accounts';

// Reuses the session global setup established, rather than signing in again.
// The login route is rate limited, correctly, and a suite that logs in once
// per test exhausts that limit and fails on its own noise.
test.use({ storageState: stateFor(CUSTOMER.email) });

test.describe('swarm console', () => {
  test('a new account is asked what to watch, not shown a dashboard', async ({ page }) => {
    await page.goto('/');
    // The whole product in one line: describe it, and it runs.
    await expect(
      page.getByPlaceholder(/watch/i).or(page.getByRole('button', { name: /watch something/i })),
    ).toBeVisible();
  });

  test('the account menu can be dismissed without choosing from it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /account/i }).click();
    await expect(page.getByRole('menuitem', { name: /change password/i })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menuitem', { name: /change password/i })).toHaveCount(0);
  });

  test('an account with nothing running is told what to do, not shown an empty field', async ({
    page,
  }) => {
    await page.goto('/');
    // No mission means no field, deliberately: an empty canvas would be
    // indistinguishable from a broken one. The empty state explains the
    // product instead.
    await expect(page.getByText(/describe what you want watched/i)).toBeVisible();
    await expect(page.getByLabel(/swarm field/i)).toHaveCount(0);
  });
});
