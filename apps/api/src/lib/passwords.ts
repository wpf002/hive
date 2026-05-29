import bcrypt from 'bcryptjs';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  if (!plain || plain.length < 8) {
    throw new Error('password must be at least 8 characters');
  }
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!plain || !hash) return false;
  return bcrypt.compare(plain, hash);
}

// Precomputed hash of a random throwaway value. Used to spend the same bcrypt
// time on a login attempt for a non-existent user as for a real one, so an
// attacker can't enumerate valid emails by measuring response latency.
const DUMMY_HASH = bcrypt.hashSync('hive-nonexistent-user-timing-equalizer', COST);

/**
 * Run a bcrypt comparison against a dummy hash and always return false. Call
 * this on the no-such-user branch of login so timing matches the real path.
 */
export async function verifyPasswordDummy(plain: string): Promise<false> {
  await bcrypt.compare(plain || 'x', DUMMY_HASH);
  return false;
}
