import { api } from './api';

export interface AuthedUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  static?: boolean;
}

export async function fetchMe(): Promise<AuthedUser | null> {
  try {
    return await api.get<AuthedUser>('/api/auth/me');
  } catch {
    return null;
  }
}
