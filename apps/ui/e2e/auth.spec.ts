import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, password } from './accounts';
import { signIn } from './sign-in';

test.describe('authentication', () => {
  test('a signed-out visitor is sent to the login page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
  });

  test('a wrong password is refused and says so', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(CUSTOMER.email);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    // Still on /login, with something visible explaining why.
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/invalid|incorrect|credential/i).first()).toBeVisible();
  });

  test('an unknown email is refused the same way a wrong password is', async ({ page }) => {
    // Identical treatment on purpose — a different message here would let
    // anyone enumerate which email addresses have accounts.
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody-at-all@hive.test');
    await page.getByLabel('Password').fill(password());
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(/invalid|incorrect|credential/i).first()).toBeVisible();
  });

  test('a correct password lands on the swarm console', async ({ page }) => {
    await signIn(page, CUSTOMER.email);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: /account/i })).toBeVisible();
  });

  test('signing out ends the session, not just the page', async ({ page }) => {
    await signIn(page, ADMIN.email);
    await page.getByRole('button', { name: /account/i }).click();
    await page.getByRole('menuitem', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    // The real assertion: going back to the product does not get you in.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
