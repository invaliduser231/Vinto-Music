import { getAuthSession } from '@/lib/auth-server';
import { fetchUserGuilds } from '@/lib/fluxer-oauth';
import { readOAuthConfig } from '@/lib/oauth-config';

export async function GET() {
  const config = readOAuthConfig();
  const session = await getAuthSession();
  if (!config || !session) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const guilds = await fetchUserGuilds(config, session.accessToken);
    return Response.json({ guilds });
  } catch {
    return Response.json({ error: 'guilds unavailable' }, { status: 502 });
  }
}
