import { cookies } from 'next/headers';
import { AUTH_SESSION_COOKIE } from '@/lib/auth-cookie';

export async function POST() {
  const store = await cookies();
  store.delete(AUTH_SESSION_COOKIE);
  return Response.json({ ok: true });
}
