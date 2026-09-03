import { ADMIN, API_BASE, API_TOKEN, CUSTOMER, adminHeaders } from './accounts';

/**
 * Remove the accounts the suite created.
 *
 * Best-effort on purpose: a teardown that throws turns a green run red and
 * tells you nothing about the application. A leftover account is a nuisance;
 * a false failure is a lie.
 */
export default async function globalTeardown() {
  if (!API_TOKEN) return;
  try {
    const list = await fetch(`${API_BASE}/api/admin/users`, { headers: adminHeaders() });
    if (!list.ok) return;
    const users = (await list.json()) as { id: string; email: string }[];
    for (const email of [ADMIN.email, CUSTOMER.email]) {
      const u = users.find((x) => x.email === email);
      if (!u) continue;
      await fetch(`${API_BASE}/api/admin/users/${u.id}`, {
        method: 'DELETE',
        headers: adminHeaders(),
      });
    }
  } catch {
    /* see above — never fail the run on cleanup */
  }
}
