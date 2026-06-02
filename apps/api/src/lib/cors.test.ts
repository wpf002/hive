import '../test-helpers/unit-env.js'; // MUST be first — sets env before cors.ts → env.ts evaluate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOriginAllowed, allowedOrigins } from './cors.js';

// unit-env sets: NODE_ENV=production, HIVE_PUBLIC_APP_URL=https://hive.example.com,
// HIVE_CORS_ORIGINS=https://admin.example.com

test('allows the configured public app URL', () => {
  assert.equal(isOriginAllowed('https://hive.example.com'), true);
});

test('allows extra origins from HIVE_CORS_ORIGINS', () => {
  assert.equal(isOriginAllowed('https://admin.example.com'), true);
});

test('normalizes a trailing slash on the incoming origin', () => {
  assert.equal(isOriginAllowed('https://hive.example.com/'), true);
});

test('rejects an arbitrary/evil origin (no reflection)', () => {
  assert.equal(isOriginAllowed('https://evil.example.com'), false);
  assert.equal(isOriginAllowed('http://hive.example.com'), false); // scheme matters
  assert.equal(isOriginAllowed('https://hive.example.com.evil.com'), false);
});

test('does NOT auto-allow localhost in production', () => {
  assert.equal(isOriginAllowed('http://localhost:3001'), false);
});

test('allows a missing origin (same-origin / server-to-server / curl)', () => {
  assert.equal(isOriginAllowed(undefined), true);
  assert.equal(isOriginAllowed(''), true);
});

test('allowlist contains exactly the configured origins (prod, no localhost)', () => {
  const set = allowedOrigins();
  assert.ok(set.includes('https://hive.example.com'));
  assert.ok(set.includes('https://admin.example.com'));
  assert.ok(!set.some((o) => o.includes('localhost')));
});
