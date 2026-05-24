const BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:4000';
const TOKEN = process.env.NEXT_PUBLIC_API_TOKEN ?? '';

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
    Authorization: `Bearer ${TOKEN}`,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
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
  token: TOKEN,
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

export function streamUrl(jobId: string): string {
  // Token passed as query for SSE (browser EventSource alternative); fetch+ReadableStream uses Bearer header.
  return `${BASE}/api/jobs/${jobId}/stream`;
}
