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
