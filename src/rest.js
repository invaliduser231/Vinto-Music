import { sleep } from './utils/retry.js';

class RestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RestError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
    this.globalRateLimit = options.globalRateLimit ?? false;
    this.method = options.method ?? null;
    this.path = options.path ?? null;
    this.details = options.details ?? null;
  }
}

function isRetryFriendlyMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'].includes(method.toUpperCase());
}

function toQueryString(query) {
  if (!query || typeof query !== 'object') return '';

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    params.set(key, String(value));
  }

  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

function parseRetryAfterMs(value) {
  if (value == null) return null;

  const asNumber = Number.parseFloat(String(value));
  if (!Number.isFinite(asNumber) || asNumber < 0) return null;

  return Math.ceil(asNumber * 1000);
}

function parseRateLimitResetMs(value) {
  if (value == null) return null;

  const asNumber = Number.parseFloat(String(value));
  if (!Number.isFinite(asNumber) || asNumber < 0) return null;

  const resetAtMs = asNumber >= 1e12 ? asNumber : (asNumber * 1000);
  return Math.max(0, Math.ceil(resetAtMs - Date.now()));
}

function parseGlobalRateLimitFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'no'].includes(normalized)) return false;
  }
  return false;
}

function joinBaseAndPath(base, path, query) {
  const normalizedBase = String(base ?? '').replace(/\/+$/g, '');
  const normalizedPath = String(path ?? '').startsWith('/') ? String(path) : `/${String(path ?? '')}`;
  return `${normalizedBase}${normalizedPath}${toQueryString(query)}`;
}

function resolveRateLimitDelayMs(response, parsedBody) {
  return (
    parseRetryAfterMs(response.headers.get('retry-after'))
    ?? parseRetryAfterMs(parsedBody?.retry_after)
    ?? parseRetryAfterMs(response.headers.get('x-ratelimit-reset-after'))
    ?? parseRateLimitResetMs(response.headers.get('x-ratelimit-reset'))
  );
}

function nextDelayMs(attempt, baseDelayMs) {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * Math.max(100, baseDelayMs));
  return Math.min(15_000, exponential + jitter);
}

function extractErrorMessage(body, statusText) {
  if (body == null) return statusText || 'Unknown REST error';
  if (typeof body === 'string' && body.trim()) return body;
  if (typeof body === 'object') {
    if (typeof body.message === 'string') {
      if (body.code) return `${body.code}: ${body.message}`;
      return body.message;
    }

    try {
      return JSON.stringify(body);
    } catch {
      return statusText || 'Unknown REST error';
    }
  }

  return statusText || 'Unknown REST error';
}

function buildMessageNonce() {
  return `${Date.now()}${Math.floor(Math.random() * 100_000)}`;
}

function normalizeMessagePayload(payload) {
  if (typeof payload === 'string') {
    return { content: payload };
  }

  const body = { ...(payload ?? {}) };
  if (!body.content && !Array.isArray(body.embeds)) {
    throw new Error('Message payload must include content or embeds.');
  }

  if (!body.nonce) {
    body.nonce = buildMessageNonce();
  }

  return body;
}

function normalizeMessageEditPayload(payload) {
  if (typeof payload === 'string') {
    return { content: payload };
  }

  const body = { ...(payload ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(body, 'content') && !Array.isArray(body.embeds)) {
    throw new Error('Message edit payload must include content or embeds.');
  }
  return body;
}

export class RestClient {
  constructor(options) {
    this.base = options.base;
    this.authHeader = options.token.startsWith('Bot ') ? options.token : `Bot ${options.token}`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 300;
    this.logger = options.logger;
    this.metrics = options.metrics ?? null;
    this.globalRateLimitUntilMs = 0;
  }

  async request(method, path, options = {}) {
    const upperMethod = method.toUpperCase();
    const url = joinBaseAndPath(this.base, path, options.query);
    const retryUnsafe = options.retryUnsafe === true;

    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      await this._waitForGlobalRateLimit(upperMethod, path);
      try {
        return await this._requestOnce(upperMethod, path, url, options);
      } catch (err) {
        const restErr = err instanceof RestError
          ? err
          : new RestError(err instanceof Error ? err.message : String(err), {
            method: upperMethod,
            path,
            retryable: true,
          });

        lastErr = restErr;
        if (restErr.status === 429) {
          const scope = restErr.globalRateLimit ? 'global' : 'route';
          this.metrics?.restRateLimitedTotal?.inc?.(1, {
            method: upperMethod,
            path,
            scope,
          });
          if (restErr.globalRateLimit) {
            const fallbackDelayMs = Math.max(250, this.retryBaseDelayMs);
            const until = Date.now() + (restErr.retryAfterMs ?? fallbackDelayMs);
            this.globalRateLimitUntilMs = Math.max(this.globalRateLimitUntilMs, until);
          }
        }

        const canRetry = this._shouldRetry(restErr, upperMethod, retryUnsafe) && attempt < this.maxRetries;

        if (!canRetry) {
          throw restErr;
        }

        const delayMs = restErr.retryAfterMs ?? nextDelayMs(attempt, this.retryBaseDelayMs);
        this.logger?.warn?.('REST request retrying', {
          method: upperMethod,
          path,
          attempt,
          delayMs,
          error: restErr.message,
        });
        this.metrics?.restRetriesTotal?.inc?.(1, {
          method: upperMethod,
          path,
        });

        await sleep(delayMs);
      }
    }

    throw lastErr ?? new RestError(`Unhandled REST request error for ${upperMethod} ${path}`);
  }

  async _requestOnce(method, path, url, options) {
    const hasBody = options.body != null;
    const headers = {
      Authorization: this.authHeader,
      ...(options.headers ?? {}),
    };
    if (
      hasBody
      && !Object.prototype.hasOwnProperty.call(headers, 'Content-Type')
      && !Object.prototype.hasOwnProperty.call(headers, 'content-type')
    ) {
      headers['Content-Type'] = 'application/json';
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new RestError(`Network error: ${err instanceof Error ? err.message : String(err)}`, {
        method,
        path,
        retryable: true,
      });
    }

    const parsedBody = await this._parseBody(response);

    if (response.status === 429) {
      const retryAfterMs = resolveRateLimitDelayMs(response, parsedBody);
      const globalRateLimit = parseGlobalRateLimitFlag(parsedBody?.global);

      throw new RestError(`[REST] ${method} ${path} -> 429 (${extractErrorMessage(parsedBody, response.statusText)})`, {
        method,
        path,
        status: response.status,
        retryAfterMs,
        retryable: true,
        globalRateLimit,
        details: parsedBody,
      });
    }

    if (!response.ok) {
      const retryable = response.status >= 500;
      throw new RestError(
        `[REST] ${method} ${path} -> ${response.status} (${extractErrorMessage(parsedBody, response.statusText)})`,
        {
          method,
          path,
          status: response.status,
          retryable,
          details: parsedBody,
        }
      );
    }

    return parsedBody;
  }

  _shouldRetry(error, method, retryUnsafe) {
    if (!error?.retryable) return false;

    if (error.status === 429) return true;
    if (isRetryFriendlyMethod(method)) return true;
    if (error.status == null) return retryUnsafe;
    return retryUnsafe;
  }

  async _waitForGlobalRateLimit(method, path) {
    const waitMs = Math.max(0, Math.ceil(this.globalRateLimitUntilMs - Date.now()));
    if (waitMs <= 0) return;

    this.logger?.warn?.('REST global rate limit active, delaying request', {
      method,
      path,
      waitMs,
    });
    this.metrics?.restGlobalRateLimitWaitMs?.inc?.(waitMs, { method, path });
    await sleep(waitMs);
  }

  async _parseBody(response) {
    if (response.status === 204) return null;

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getCurrentUser() {
    return this.request('GET', '/users/@me');
  }

  async getGatewayBot() {
    try {
      return await this.request('GET', '/gateway/bot');
    } catch (err) {
      if (err instanceof RestError && err.status === 404) {
        return this.request('GET', '/gateway');
      }
      throw err;
    }
  }

  async getChannel(channelId) {
    return this.request('GET', `/channels/${channelId}`);
  }

  async listCurrentUserGuilds(options = {}) {
    const query = {};
    if (options.before != null) query.before = options.before;
    if (options.after != null) query.after = options.after;
    if (options.limit != null) query.limit = options.limit;
    if (options.withCounts != null) query.with_counts = options.withCounts;
    return this.request('GET', '/users/@me/guilds', { query });
  }

  async getGuild(guildId, options = {}) {
    const query = {};
    if (options.withCounts != null) query.with_counts = options.withCounts;
    return this.request('GET', `/guilds/${guildId}`, { query });
  }

  async getGuildMember(guildId, userId) {
    return this.request('GET', `/guilds/${guildId}/members/${userId}`);
  }

  async listGuildMembers(guildId, options = {}) {
    const query = {};
    if (options.limit != null) query.limit = options.limit;
    if (options.after != null) query.after = options.after;
    return this.request('GET', `/guilds/${guildId}/members`, { query });
  }

  async listGuildRoles(guildId) {
    return this.request('GET', `/guilds/${guildId}/roles`);
  }

  async sendTyping(channelId) {
    return this.request('POST', `/channels/${channelId}/typing`, { retryUnsafe: true });
  }

  async sendMessage(channelId, payload) {
    const body = normalizeMessagePayload(payload);

    try {
      return await this.request('POST', `/channels/${channelId}/messages`, {
        body,
        retryUnsafe: false,
      });
    } catch (err) {
      if (
        err instanceof RestError &&
        err.status === 400 &&
        Array.isArray(body.embeds)
      ) {
        this.logger?.warn?.('Embed payload rejected by API, falling back to plain content', {
          channelId,
          error: err.message,
        });
        const fallbackContent = body.content || body.embeds[0]?.description || body.embeds[0]?.title || 'Message';
        return this.request('POST', `/channels/${channelId}/messages`, {
          body: {
            content: fallbackContent,
            nonce: body.nonce,
            message_reference: body.message_reference,
            allowed_mentions: body.allowed_mentions,
          },
          retryUnsafe: false,
        });
      }

      throw err;
    }
  }

  async editMessage(channelId, messageId, payload) {
    const body = normalizeMessageEditPayload(payload);
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, {
      body,
      retryUnsafe: false,
    });
  }

  async addReactionToMessage(channelId, messageId, emoji, options = {}) {
    const encoded = encodeURIComponent(String(emoji ?? '').trim());
    const query = {};
    if (options?.sessionId != null) query.session_id = options.sessionId;
    return this.request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
      query,
      retryUnsafe: true,
    });
  }

  async removeOwnReactionFromMessage(channelId, messageId, emoji, options = {}) {
    const encoded = encodeURIComponent(String(emoji ?? '').trim());
    const query = {};
    if (options?.sessionId != null) query.session_id = options.sessionId;
    return this.request('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
      query,
      retryUnsafe: true,
    });
  }
}

export { RestError };
