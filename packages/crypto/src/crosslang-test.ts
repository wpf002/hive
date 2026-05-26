/**
 * Cross-language ciphertext compatibility test.
 *
 *   $ HIVE_SECRETS_KEY=$(openssl rand -hex 32) tsx packages/crypto/src/crosslang-test.ts
 *
 * Covers both wire formats:
 *   v1 (legacy)      — direct XChaCha20 under HIVE_SECRETS_KEY
 *   v2 (envelope)    — KMS-wrapped DEK + XChaCha20 under the DEK
 *
 * Each format is round-tripped in both directions:
 *   1. encrypt(TS) → decrypt(Python)
 *   2. encrypt(Python) → decrypt(TS)
 *
 * Skips (exits 0 with a notice) when no Python venv is wired up — that way
 * `pnpm verify` doesn't fail on a fresh clone where workers haven't been
 * installed yet. Pass --strict to fail-hard instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { encrypt as encryptV1, decrypt as decryptV1 } from './index.js';

const STRICT = process.argv.includes('--strict');
const TS_PLAIN_V1 = 'cross-lang v1: TS→PY — secret🐝 ' + Math.random().toString(36).slice(2);
const PY_PLAIN_V1 = 'cross-lang v1: PY→TS — secret🐝 ' + Math.random().toString(36).slice(2);
const TS_PLAIN_V2 = 'cross-lang v2: TS→PY — secret🐝 ' + Math.random().toString(36).slice(2);
const PY_PLAIN_V2 = 'cross-lang v2: PY→TS — secret🐝 ' + Math.random().toString(36).slice(2);

const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '');
const PYTHON = `${REPO_ROOT}/workers/base/.venv/bin/python`;

if (!existsSync(PYTHON)) {
  const msg = `[crosslang-test] skipped — Python venv not found at ${PYTHON}. Run \`pnpm workers:install\` then re-run.`;
  if (STRICT) {
    console.error(msg);
    process.exit(1);
  }
  console.log(msg);
  process.exit(0);
}

if (!process.env.HIVE_SECRETS_KEY) {
  console.error('[crosslang-test] HIVE_SECRETS_KEY must be set');
  process.exit(1);
}

// Build v2 in TS via the envelope module under apps/api. We import dynamically
// because @hive/crypto can't depend on apps/api. We resolve the path manually.
const { encryptValue: encryptV2, decryptValue: decryptV2 } = await import(
  `${REPO_ROOT}/apps/api/src/lib/envelope.ts`
);

const tsCipherV1 = encryptV1(TS_PLAIN_V1);
const tsCipherV2 = await encryptV2(TS_PLAIN_V2);

// Hand the script to Python via stdin so we don't have to escape shell args.
const pyScript = `
import sys
sys.path.insert(0, '${REPO_ROOT}/workers/base')
from hive_base.crypto import decrypt as decrypt_v1, encrypt as encrypt_v1
from hive_base.envelope import decrypt_value, encrypt_value
data = sys.stdin.read()
ts_v1, ts_v2, py_v1_plain, py_v2_plain = data.split('\\x1e')
out = [
    decrypt_v1(ts_v1),           # PY decrypts TS v1
    decrypt_value(ts_v2),        # PY decrypts TS v2
    encrypt_v1(py_v1_plain),     # PY emits v1 ciphertext
    encrypt_value(py_v2_plain),  # PY emits v2 ciphertext
]
sys.stdout.write('\\x1e'.join(out))
`;

const input = [tsCipherV1, tsCipherV2, PY_PLAIN_V1, PY_PLAIN_V2].join('\x1e');
const out = execFileSync(PYTHON, ['-c', pyScript], {
  input,
  encoding: 'utf8',
  env: { ...process.env },
});

const [pyV1Decrypted, pyV2Decrypted, pyV1Cipher, pyV2Cipher] = out.split('\x1e');

function assertEq(label: string, got: string, expected: string): void {
  if (got !== expected) {
    console.error(`[crosslang-test] FAIL: ${label}`);
    console.error(`  expected: ${expected}`);
    console.error(`  got:      ${got}`);
    process.exit(1);
  }
}

assertEq('v1: PY decrypts TS', pyV1Decrypted, TS_PLAIN_V1);
assertEq('v2: PY decrypts TS', pyV2Decrypted, TS_PLAIN_V2);
assertEq('v1: TS decrypts PY', decryptV1(pyV1Cipher), PY_PLAIN_V1);
assertEq('v2: TS decrypts PY', await decryptV2(pyV2Cipher), PY_PLAIN_V2);

console.log('[crosslang-test] OK — TS↔Python interop verified for v1 and v2 envelopes.');
