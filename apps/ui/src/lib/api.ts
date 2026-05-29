// Browser base URL. Default '' = same-origin, so requests hit the UI's own
// origin and are proxied to the API by next.config.js rewrites (keeps the
// session cookie first-party). Set NEXT_PUBLIC_API_BASE only to talk to a
// cross-origin API directly (not needed with the proxy).
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

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
  // Auth is carried entirely by the first-party session cookie (sent via
  // credentials: 'include'). We never embed a bearer token in the browser
  // bundle — a NEXT_PUBLIC_* token would be readable by anyone loading the app.
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
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export function streamUrl(jobId: string): string {
  // SSE is authenticated by the same first-party session cookie (the fetch in
  // LiveLogStream sends credentials: 'include'); no token in the URL or bundle.
  return `${BASE}/api/jobs/${jobId}/stream`;
}
