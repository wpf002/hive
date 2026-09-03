import { test, expect } from '@playwright/test';
import { CUSTOMER, stateFor } from './accounts';

/**
 * The obligations a product takes on when it holds someone's data: they can
 * read what it says about that, take a copy, and leave.
 */
test.describe('legal pages are public', () => {
  test('someone deciding whether to sign up can read them without an account', async ({
    browser,
  }) => {
    // A fresh context with no session — the whole point is that these are
    // reachable before you have one.
    const page = await browser.newPage();
    for (const path of ['/legal/privacy', '/legal/terms']) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(path));
      await expect(page.getByRole('heading').first()).toBeVisible();
    }
    await page.close();
  });

  test('the login page links to them', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    await expect(page.getByRole('link', { name: /privacy/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /terms/i })).toBeVisible();
    await page.close();
  });
});

test.describe('your data', () => {
  test.use({ storageState: stateFor(CUSTOMER.email) });

  test('is reachable from the console and offers both export and deletion', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /account/i }).click();
    await page.getByRole('menuitem', { name: /your data/i }).click();
    await expect(page).toHaveURL(/\/account\/data/);
    await expect(page.getByRole('button', { name: /download export/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /delete my account/i })).toBeVisible();
  });

  test('deletion needs the confirmation typed AND the password', async ({ page }) => {
    // Guarding against the version of this that ships as one button.
    await page.goto('/account/data');
    const del = page.getByRole('button', { name: /delete my account/i });
    await expect(del).toBeDisabled();
    await page.getByLabel(/type delete/i).fill('DELETE');
    await expect(del, 'the typed confirmation alone must not arm it').toBeDisabled();
    await page.getByLabel(/your password/i).fill('something');
    await expect(del).toBeEnabled();
  });
});

test.describe('email verification', () => {
  test('a bad link explains itself rather than failing silently', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/verify-email?token=definitely-not-a-real-token');
    await expect(page.getByText(/did not work/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /sign in/i })).toBeVisible();
    await page.close();
  });
});
