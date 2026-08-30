import { getAuthSession } from '@/lib/auth-server';
import { readOAuthConfig } from '@/lib/oauth-config';
import { fetchOAuthUser } from '@/lib/fluxer-oauth';
import { resolveUserAvatarUrl } from '@/lib/fluxer-cdn';

export async function GET() {
  const session = await getAuthSession();
  if (!session) {
    return Response.json({ user: null });
  }

  let avatarUrl = session.avatarUrl ?? resolveUserAvatarUrl(session.userId, null);
  const config = readOAuthConfig();
  if (config && !session.avatarUrl) {
    const user = await fetchOAuthUser(config, session.accessToken).catch(() => null);
    if (user) avatarUrl = user.avatarUrl;
  }

  return Response.json({
    user: {
      id: session.userId,
      username: session.username,
      avatarUrl,
    },
  });
}
