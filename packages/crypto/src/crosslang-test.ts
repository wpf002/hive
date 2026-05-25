/**
 * Cross-language ciphertext compatibility test.
 *
 *   $ HIVE_SECRETS_KEY=$(openssl rand -hex 32) tsx packages/crypto/src/crosslang-test.ts
 *
 * 1. Encrypts a known string in TS.
 * 2. Shells out to Python (hive_base.crypto) and asks it to decrypt.
 * 3. Asks Python to encrypt a different string.
 * 4. Decrypts the Python ciphertext here in TS.
 * 5. Asserts both round-trips produce the original plaintext.
 *
 * Skips (exits 0 with a notice) when no Python venv is wired up — that way
 * `pnpm verify` doesn't fail on a fresh clone where workers haven't been
 * installed yet. Pass --strict to fail-hard instead.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { encrypt, decrypt } from './index.js';

const STRICT = process.argv.includes('--strict');
const TS_PLAIN = 'cross-lang: TS→PY — secret🐝 ' + Math.random().toString(36).slice(2);
const PY_PLAIN = 'cross-lang: PY→TS — secret🐝 ' + Math.random().toString(36).slice(2);

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

const tsCipher = encrypt(TS_PLAIN);

// Hand the script to Python via stdin so we don't have to escape shell args.
const pyScript = `
import sys
sys.path.insert(0, '${REPO_ROOT}/workers/base')
from hive_base.crypto import encrypt, decrypt
data = sys.stdin.read()
ts_cipher, py_plain = data.split('\\n', 1)
ts_decrypted = decrypt(ts_cipher)
py_cipher = encrypt(py_plain)
sys.stdout.write(ts_decrypted + '\\n' + py_cipher)
`;

const out = execFileSync(PYTHON, ['-c', pyScript], {
  input: tsCipher + '\n' + PY_PLAIN,
  encoding: 'utf8',
  env: { ...process.env },
});

const [pyDecryptedFromTs, pyCipher] = out.split('\n');

if (pyDecryptedFromTs !== TS_PLAIN) {
  console.error('[crosslang-test] FAIL: Python could not decrypt TS ciphertext');
  console.error(`  expected: ${TS_PLAIN}`);
  console.error(`  got:      ${pyDecryptedFromTs}`);
  process.exit(1);
}

const tsDecryptedFromPy = decrypt(pyCipher);
if (tsDecryptedFromPy !== PY_PLAIN) {
  console.error('[crosslang-test] FAIL: TS could not decrypt Python ciphertext');
  console.error(`  expected: ${PY_PLAIN}`);
  console.error(`  got:      ${tsDecryptedFromPy}`);
  process.exit(1);
}

console.log('[crosslang-test] OK — TS↔Python ciphertext interop verified.');
