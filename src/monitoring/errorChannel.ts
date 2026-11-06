import type { LoggerLike, MessagePayload } from '../types/core.ts';

export type ErrorReporter = {
  captureException?: (error: unknown, context?: Record<string, unknown>) => void;
  flush?: (timeoutMs?: number) => Promise<void>;
};

type ErrorChannelOptions = {
  channelId: string | null;
  rest: { sendMessage: (channelId: string, payload: MessagePayload) => Promise<unknown> };
  inner?: ErrorReporter | null;
  logger?: LoggerLike | undefined;
  secrets?: Array<string | null | undefined>;
  shardLabel?: string | null;
  now?: () => number;
};

const WINDOW_MS = 5 * 60_000;
const MAX_PER_WINDOW = 10;
const STACK_LINES = 6;
const MIN_SECRET_LENGTH = 6;

const REDACTIONS: Array<[RegExp, string]> = [
  [/(mongodb(?:\+srv)?:\/\/)[^@\s/]+@/gi, '$1***@'],
  [/(https?:\/\/)[^@\s/]+:[^@\s/]+@/gi, '$1***@'],
  [/([?&](?:token|key|secret|password|pass|arl|sig|signature|api_key|apikey|access_token)=)[^&\s]+/gi, '$1***'],
  [/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***'],
  [/\b(Bot|Bearer)\s+[A-Za-z0-9._-]{20,}/g, '$1 ***'],
];

export function redactErrorText(text: string, secrets: Array<string | null | undefined> = []): string {
  let output = String(text ?? '');
  for (const secret of secrets) {
    const value = String(secret ?? '').trim();
    if (value.length < MIN_SECRET_LENGTH) continue;
    output = output.split(value).join('***');
  }
  for (const [pattern, replacement] of REDACTIONS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

function describeError(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    const stack = String(error.stack ?? '')
      .split('\n')
      .slice(1, 1 + STACK_LINES)
      .map((line) => line.trim())
      .join('\n');
    return { message: `${error.name}: ${error.message}`, stack };
  }
  return { message: String(error), stack: '' };
}

function describeContext(context: Record<string, unknown>): string {
  return Object.entries(context)
    .filter(([, value]) => value != null && value !== '' && typeof value !== 'object')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

export function createErrorChannelReporter(options: ErrorChannelOptions): ErrorReporter | null {
  const channelId = String(options.channelId ?? '').trim();
  if (!channelId) return options.inner ?? null;

  const now = options.now ?? Date.now;
  const sentAt: number[] = [];
  const recentKeys = new Map<string, number>();
  let suppressed = 0;

  const post = async (error: unknown, context: Record<string, unknown>) => {
    const current = now();
    while (sentAt.length && current - sentAt[0]! > WINDOW_MS) sentAt.shift();
    for (const [key, at] of recentKeys) {
      if (current - at > WINDOW_MS) recentKeys.delete(key);
    }

    const { message, stack } = describeError(error);
    const source = String(context.source ?? 'unknown');
    const dedupeKey = `${source}\u0000${message}`;
    if (recentKeys.has(dedupeKey) || sentAt.length >= MAX_PER_WINDOW) {
      suppressed += 1;
      return;
    }
    recentKeys.set(dedupeKey, current);
    sentAt.push(current);

    const header = [`**${source}**`, options.shardLabel ? `shard ${options.shardLabel}` : null]
      .filter(Boolean)
      .join(' | ');
    const details = describeContext({ ...context, source: undefined });
    const skipped = suppressed > 0 ? `\n-# ${suppressed} similar errors were not posted` : '';
    suppressed = 0;
    const body = redactErrorText([message, stack].filter(Boolean).join('\n'), options.secrets ?? []).slice(0, 1500);
    const content = [
      header,
      details ? redactErrorText(details, options.secrets ?? []) : null,
      `\`\`\`\n${body}\n\`\`\``,
    ].filter(Boolean).join('\n') + skipped;

    await options.rest.sendMessage(channelId, {
      content: content.slice(0, 1900),
      allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
    });
  };

  return {
    captureException(error, context = {}) {
      options.inner?.captureException?.(error, context);
      post(error, context ?? {}).catch((err: unknown) => {
        options.logger?.debug?.('Posting to the error channel failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    async flush(timeoutMs) {
      await options.inner?.flush?.(timeoutMs);
    },
  };
}
