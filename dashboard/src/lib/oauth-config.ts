export type OAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  apiBase: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  cookieSecret: string;
};

export function readOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.FLUXER_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.FLUXER_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.FLUXER_OAUTH_REDIRECT_URI?.trim();
  const cookieSecret = process.env.AUTH_COOKIE_SECRET?.trim();
  if (!clientId || !clientSecret || !redirectUri || !cookieSecret || cookieSecret.length < 32) {
    return null;
  }

  const apiBase = (process.env.FLUXER_API_BASE?.trim() || 'https://api.fluxer.app/v1').replace(/\/+$/, '');
  const oauthApiBase = apiBase.replace(/\/v1$/i, '');

  return {
    clientId,
    clientSecret,
    redirectUri,
    apiBase,
    authorizeUrl: process.env.FLUXER_OAUTH_AUTHORIZE_URL?.trim() || 'https://web.fluxer.app/oauth2/authorize',
    tokenUrl: process.env.FLUXER_OAUTH_TOKEN_URL?.trim() || `${oauthApiBase}/oauth2/token`,
    scope: process.env.FLUXER_OAUTH_SCOPE?.trim() || 'identify guilds',
    cookieSecret,
  };
}
