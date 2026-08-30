import type { OAuthConfig } from './oauth-config';
import { resolveUserAvatarUrl } from './fluxer-cdn';

export type OAuthTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
};

export type OAuthUser = {
  id: string;
  username: string;
  avatarUrl: string;
};

export type OAuthGuild = {
  id: string;
  name: string;
  icon: string | null;
};

export function buildAuthorizeUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    state,
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

async function postToken(config: OAuthConfig, body: Record<string, string>): Promise<OAuthTokenResponse> {
  const params = new URLSearchParams(body);
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: ${response.status}`);
  }
  return await response.json() as OAuthTokenResponse;
}

export async function exchangeAuthorizationCode(config: OAuthConfig, code: string): Promise<OAuthTokenResponse> {
  return postToken(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
}

export async function refreshAccessToken(config: OAuthConfig, refreshToken: string): Promise<OAuthTokenResponse> {
  return postToken(config, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
}

export async function fetchOAuthUser(config: OAuthConfig, accessToken: string): Promise<OAuthUser> {
  const meResponse = await fetch(`${config.apiBase}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (meResponse.ok) {
    const payload = await meResponse.json() as {
      id?: string;
      username?: string;
      global_name?: string;
      display_name?: string;
      avatar?: string | null;
    };
    const id = String(payload.id ?? '').trim();
    if (!id) throw new Error('users/@me missing id');
    const username = String(
      payload.global_name
      ?? payload.display_name
      ?? payload.username
      ?? id,
    ).trim() || id;
    const avatarHash = payload.avatar == null || payload.avatar === ''
      ? null
      : String(payload.avatar).trim() || null;
    return {
      id,
      username,
      avatarUrl: resolveUserAvatarUrl(id, avatarHash),
    };
  }

  const response = await fetch(`${config.apiBase}/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`user profile failed: ${meResponse.status}/${response.status}`);
  }
  const payload = await response.json() as {
    id?: string;
    sub?: string;
    username?: string;
    global_name?: string;
    avatar?: string | null;
    picture?: string | null;
  };
  const id = String(payload.id ?? payload.sub ?? '').trim();
  if (!id) throw new Error('userinfo missing id');
  const username = String(payload.username ?? payload.global_name ?? id).trim() || id;
  const picture = String(payload.picture ?? '').trim();
  const avatarHash = payload.avatar == null || payload.avatar === ''
    ? null
    : String(payload.avatar).trim() || null;
  const avatarUrl = picture || resolveUserAvatarUrl(id, avatarHash);
  return { id, username, avatarUrl };
}

export async function fetchUserGuilds(config: OAuthConfig, accessToken: string): Promise<OAuthGuild[]> {
  const guilds: OAuthGuild[] = [];
  let after: string | undefined;

  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: '200' });
    if (after) query.set('after', after);

    const response = await fetch(`${config.apiBase}/users/@me/guilds?${query.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`guilds failed: ${response.status}`);
    }

    const payload = await response.json() as Array<{ id?: string; name?: string; icon?: string | null }>;
    if (!Array.isArray(payload) || payload.length === 0) break;

    for (const entry of payload) {
      const iconRaw = entry.icon;
      const icon = iconRaw == null || iconRaw === ''
        ? null
        : String(iconRaw).trim() || null;
      const id = String(entry.id ?? '').trim();
      if (!id) continue;
      guilds.push({
        id,
        name: String(entry.name ?? '').trim() || id,
        icon,
      });
    }

    if (payload.length < 200) break;
    const lastId = String(payload[payload.length - 1]?.id ?? '').trim();
    if (!lastId) break;
    after = lastId;
  }

  return guilds;
}
