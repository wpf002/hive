const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';
// Legacy fallback so SSE keeps working while sessions roll out. Once you've
// logged in once, the cookie takes precedence and this can be removed.
const LEGACY_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? '';

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init?: RequestInit,
): Promise<T> {
  const headers: Record<string, string> = {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  // Cookie auth is preferred. As a transition aid we still send the legacy
  // bearer token if NEXT_PUBLIC_API_TOKEN is set, but only as fallback — the
  // session cookie wins on the server.
  if (LEGACY_TOKEN && !headers.Authorization) {
    headers.Authorization = `Bearer ${LEGACY_TOKEN}`;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    credentials: 'include',
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const parsed = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const msg = (parsed && typeof parsed === 'object' && 'error' in parsed)
      ? ((parsed as { error: { message?: string } }).error.message ?? `${method} ${path} → ${res.status}`)
      : `${method} ${path} → ${res.status}`;
    throw new ApiError(msg, res.status, parsed);
  }
  return parsed as T;
}

export const api = {
  base: BASE,
  token: LEGACY_TOKEN,
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export function streamUrl(jobId: string): string {
  // SSE uses the legacy bearer in the Authorization header (sent via fetch+
  // ReadableStream). Once cookie-based SSE is wired everywhere we can drop
  // NEXT_PUBLIC_API_TOKEN entirely.
  return `${BASE}/api/jobs/${jobId}/stream`;
}
