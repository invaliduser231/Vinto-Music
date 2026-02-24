import { sleep } from './utils/retry.js';

class RestError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RestError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.retryable = options.retryable ?? false;
    this.method = options.method ?? null;
    this.path = options.path ?? null;
    this.details = options.details ?? null;
  }
}

function isSafeMethod(method) {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
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
  }

  async request(method, path, options = {}) {
    const upperMethod = method.toUpperCase();
    const url = `${this.base}${path}${toQueryString(options.query)}`;
    const retryUnsafe = options.retryUnsafe === true;

    let lastErr;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
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

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          ...(options.headers ?? {}),
        },
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
      const retryAfterMs =
        parseRetryAfterMs(response.headers.get('retry-after')) ??
        parseRetryAfterMs(parsedBody?.retry_after);

      throw new RestError(`[REST] ${method} ${path} -> 429 (${extractErrorMessage(parsedBody, response.statusText)})`, {
        method,
        path,
        status: response.status,
        retryAfterMs,
        retryable: true,
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
    if (error.status == null) return true;

    if (isSafeMethod(method)) return true;
    return retryUnsafe;
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
    return this.request('GET', '/gateway/bot');
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

  async sendTyping(channelId) {
    return this.request('POST', `/channels/${channelId}/typing`, { retryUnsafe: false });
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

  async addReactionToMessage(channelId, messageId, emoji) {
    const encoded = encodeURIComponent(String(emoji ?? '').trim());
    return this.request('PUT', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
      retryUnsafe: false,
    });
  }

  async removeOwnReactionFromMessage(channelId, messageId, emoji) {
    const encoded = encodeURIComponent(String(emoji ?? '').trim());
    return this.request('DELETE', `/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`, {
      retryUnsafe: false,
    });
  }
}

export { RestError };
