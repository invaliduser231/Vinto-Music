import 'dotenv/config';

import http from 'node:http';
import crypto from 'node:crypto';

const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
const redirectUri = process.env.SPOTIFY_REDIRECT_URI?.trim() || 'http://127.0.0.1:9876/spotify/callback';
const scope = process.env.SPOTIFY_SCOPE?.trim() || 'user-read-email';
const allowMissingState = !['0', 'false', 'no', 'off'].includes(
  String(process.env.SPOTIFY_ALLOW_MISSING_STATE ?? '1').trim().toLowerCase()
);

if (!clientId || !clientSecret) {
  console.error('Missing SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET in environment.');
  process.exit(1);
}

const parsedRedirect = new URL(redirectUri);
if (parsedRedirect.protocol !== 'http:') {
  console.error('SPOTIFY_REDIRECT_URI must use http:// for the local callback helper script.');
  process.exit(1);
}

if (!parsedRedirect.hostname || !parsedRedirect.port) {
  console.error('SPOTIFY_REDIRECT_URI must include explicit host and port, e.g. http://127.0.0.1:9876/spotify/callback');
  process.exit(1);
}

const state = crypto.randomBytes(24).toString('hex');
let finished = false;

function buildAuthorizeUrl() {
  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('show_dialog', 'true');
  if (scope) {
    url.searchParams.set('scope', scope);
  }
  return url.toString();
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });

  const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const message = json?.error_description || json?.error || `HTTP ${response.status}`;
    throw new Error(`Token exchange failed: ${message}`);
  }

  return json;
}

function printHeader() {
  console.log('Spotify refresh token helper');
  console.log('');
  console.log('1) Ensure this Redirect URI is added in your Spotify app dashboard:');
  console.log(`   ${redirectUri}`);
  console.log('2) Open the URL below and complete login/consent:');
  console.log(buildAuthorizeUrl());
  console.log('');
  console.log(`Waiting for callback on ${parsedRedirect.hostname}:${parsedRedirect.port}${parsedRedirect.pathname} ...`);
  console.log(`Current OAuth state: ${state}`);
  console.log(`Allow missing state: ${allowMissingState ? 'yes' : 'no'}`);
}

function finish(code = 0) {
  if (finished) return;
  finished = true;
  process.exit(code);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', redirectUri);

    if (requestUrl.pathname !== parsedRedirect.pathname) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const error = requestUrl.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Spotify returned error: ${error}`);
      console.error(`Spotify returned error: ${error}`);
      console.error('Authorization can be retried with the same script run. Open the authorize URL again.');
      return;
    }

    const callbackState = requestUrl.searchParams.get('state');
    const code = requestUrl.searchParams.get('code');
    if (!callbackState && !code) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Callback received without OAuth parameters. Keep this script running and complete login with the latest authorize URL.');
      return;
    }

    if (callbackState && callbackState !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('State mismatch. Open the latest authorize URL from your terminal and try again.');
      console.error('State mismatch. Ignoring stale callback and waiting for a valid one.', {
        expectedState: state,
        receivedState: callbackState,
      });
      return;
    }

    if (!callbackState && !allowMissingState) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Missing OAuth state in callback. Set SPOTIFY_ALLOW_MISSING_STATE=1 to continue anyway.');
      console.error('Callback has no state and strict state check is enabled.');
      return;
    }

    if (!callbackState && allowMissingState) {
      console.warn('Callback has no state. Continuing because SPOTIFY_ALLOW_MISSING_STATE is enabled.');
    }

    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Missing authorization code.');
      console.error('Missing authorization code.');
      return;
    }

    const tokenData = await exchangeCodeForToken(code);
    const refreshToken = tokenData?.refresh_token ?? null;

    if (!refreshToken) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Login succeeded, but Spotify did not return a refresh token. Check console.');
      console.error('Spotify did not return refresh_token. Try removing app access and run again.');
      server.close(() => finish(1));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Success. You can close this tab and return to terminal.');

    console.log('');
    console.log('Success. Put these values into your .env:');
    console.log(`SPOTIFY_CLIENT_ID=${clientId}`);
    console.log(`SPOTIFY_CLIENT_SECRET=${clientSecret}`);
    console.log(`SPOTIFY_REFRESH_TOKEN=${refreshToken}`);
    console.log(`SPOTIFY_MARKET=${(process.env.SPOTIFY_MARKET || 'US').toUpperCase()}`);

    server.close(() => finish(0));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal error during token exchange.');
    console.error(message);
    server.close(() => finish(1));
  }
});

server.listen(Number(parsedRedirect.port), parsedRedirect.hostname, () => {
  printHeader();
});

setTimeout(() => {
  if (!finished) {
    console.error('Timed out waiting for Spotify callback.');
    server.close(() => finish(1));
  }
}, 10 * 60 * 1000).unref();
