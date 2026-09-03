import { expect, type Page } from '@playwright/test';
import { password } from './accounts';

/**
 * Sign in through the real form rather than by injecting a cookie.
 *
 * Injecting one would be faster and would also skip the thing most likely to
 * break: the session cookie's flags, the redirect after login, and the server
 * layout that reads it. Every spec here depends on that path working, so every
 * spec exercises it.
 */
export async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password());
  await page.getByRole('button', { name: /sign in/i }).click();
  // Everyone lands on the product, admins included.
  await expect(page).toHaveURL(/\/$/);
}
