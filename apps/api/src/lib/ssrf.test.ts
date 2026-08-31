import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, isPublicAddress, SsrfError } from './ssrf.js';

// The scheduler makes these requests, and it holds API_AUTH_TOKEN,
// RESEND_API_KEY and DATABASE_URL inside the control-plane network. Everything
// below is a target a webhook must never be allowed to reach.

test('the cloud metadata endpoint is not a public address', () => {
  assert.equal(isPublicAddress('169.254.169.254'), false);
});

test('private, loopback and CGNAT ranges are not public', () => {
  for (const addr of [
    '10.0.0.1',
    '172.16.5.4',
    '172.31.255.254',
    '192.168.1.1',
    '127.0.0.1',
    '0.0.0.0',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(isPublicAddress(addr), false, `${addr} must not be treated as public`);
  }
});

test('172.15 and 172.32 are public — the private block is only 172.16–31', () => {
  assert.equal(isPublicAddress('172.15.0.1'), true);
  assert.equal(isPublicAddress('172.32.0.1'), true);
});

test('ordinary public addresses pass', () => {
  for (const addr of ['1.1.1.1', '8.8.8.8', '93.184.216.34']) {
    assert.equal(isPublicAddress(addr), true, `${addr} should be public`);
  }
});

test('IPv6 loopback, link-local, unique-local and multicast are not public', () => {
  for (const addr of ['::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', 'ff02::1']) {
    assert.equal(isPublicAddress(addr), false, `${addr} must not be treated as public`);
  }
});

test('IPv4-mapped IPv6 is judged on its IPv4 part', () => {
  // ::ffff:169.254.169.254 is the metadata endpoint wearing a different hat.
  assert.equal(isPublicAddress('::ffff:169.254.169.254'), false);
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
});

test('a public IPv6 address passes', () => {
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('assertPublicUrl rejects a literal internal IP without touching DNS', async () => {
  await assert.rejects(
    () => assertPublicUrl('http://169.254.169.254/latest/meta-data/'),
    SsrfError,
  );
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:4000/api/jobs'), SsrfError);
  await assert.rejects(() => assertPublicUrl('http://[::1]:4000/'), SsrfError);
});

test('assertPublicUrl rejects non-http schemes', async () => {
  for (const url of ['file:///etc/passwd', 'gopher://x/', 'redis://localhost:6379']) {
    await assert.rejects(() => assertPublicUrl(url), SsrfError, `${url} should be refused`);
  }
});

test('assertPublicUrl rejects a malformed URL rather than throwing something else', async () => {
  await assert.rejects(() => assertPublicUrl('not a url'), SsrfError);
});

test('localhost resolves internally and is refused', async () => {
  await assert.rejects(() => assertPublicUrl('http://localhost:8080/hook'), SsrfError);
});

test('the opt-out disables the guard entirely', async () => {
  const prior = process.env.HIVE_ALLOW_INTERNAL_WEBHOOKS;
  process.env.HIVE_ALLOW_INTERNAL_WEBHOOKS = 'true';
  try {
    // Operators who genuinely webhook an internal service need this to work.
    await assertPublicUrl('http://127.0.0.1:4000/hook');
  } finally {
    if (prior === undefined) delete process.env.HIVE_ALLOW_INTERNAL_WEBHOOKS;
    else process.env.HIVE_ALLOW_INTERNAL_WEBHOOKS = prior;
  }
});

// --- IPv6 forms that survive URL normalization ------------------------------
//
// `new URL()` re-serializes [::ffff:169.254.169.254] as [::ffff:a9fe:a9fe], so
// a guard that looks for a trailing dotted quad sees none and lets the metadata
// endpoint straight through. These pin the parsed form.

test('IPv4-mapped IPv6 in hex form is still judged on its IPv4 part', () => {
  assert.equal(isPublicAddress('::ffff:a9fe:a9fe'), false, '169.254.169.254 in hex form');
  assert.equal(isPublicAddress('::ffff:7f00:1'), false, '127.0.0.1 in hex form');
  assert.equal(isPublicAddress('0:0:0:0:0:ffff:7f00:1'), false, 'fully expanded loopback');
  assert.equal(isPublicAddress('::ffff:0a00:1'), false, '10.0.0.1 in hex form');
  assert.equal(isPublicAddress('::ffff:808:808'), true, '8.8.8.8 in hex form is public');
});

test('NAT64 and 6to4 embedded IPv4 are judged on the embedded address', () => {
  assert.equal(isPublicAddress('64:ff9b::a9fe:a9fe'), false, 'NAT64-wrapped metadata endpoint');
  assert.equal(isPublicAddress('64:ff9b::808:808'), true, 'NAT64-wrapped public address');
  assert.equal(isPublicAddress('2002:7f00:1::'), false, '6to4-wrapped loopback');
});

test('documentation and discard prefixes are not public', () => {
  assert.equal(isPublicAddress('2001:db8::1'), false);
  assert.equal(isPublicAddress('100::1'), false);
});

test('an unparseable address is refused rather than assumed public', () => {
  for (const bad of ['not:an:address', ':::1', '1:2:3:4:5:6:7:8:9', 'gggg::1', '1:2:3']) {
    assert.equal(isPublicAddress(bad), false, `${bad} should not be treated as public`);
  }
});

test('assertPublicUrl blocks the bracketed IPv4-mapped metadata endpoint', async () => {
  // The exact bypass this rewrite exists to close.
  await assert.rejects(() => assertPublicUrl('http://[::ffff:169.254.169.254]/'), SsrfError);
  await assert.rejects(() => assertPublicUrl('http://[::ffff:127.0.0.1]/'), SsrfError);
  await assert.rejects(() => assertPublicUrl('http://[64:ff9b::a9fe:a9fe]/'), SsrfError);
});

test('assertPublicUrl blocks IPv4 written in octal, hex and integer form', async () => {
  // Node's URL parser normalizes all of these to 127.0.0.1 before we see them,
  // but that is a property worth pinning rather than assuming.
  for (const url of [
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://2130706433/',
    'http://127.1/',
    'http://127.0.0.1./',
  ]) {
    await assert.rejects(() => assertPublicUrl(url), SsrfError, `${url} should be refused`);
  }
});
