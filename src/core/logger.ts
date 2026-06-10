const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

type LoggerLevel = keyof typeof LEVELS;
type LoggerContext = Record<string, unknown> | null | undefined;
type LoggerOptions = {
  level?: string | undefined;
  name?: string | null;
};

function resolveLevel(level: unknown): number {
  if (typeof level !== 'string') return LEVELS.info;
  const normalized = level.toLowerCase() as LoggerLevel;
  return LEVELS[normalized] ?? LEVELS.info;
}

const REDACT_KEY_PATTERN = /token|secret|password|authorization|auth|cookie|apikey|api[_-]?key|credential/i;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 4;

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…(${value.length})`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'function') return '[function]';
  if (typeof value !== 'object') return String(value);

  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => sanitizeValue(entry, depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…(+${value.length - MAX_ARRAY_ITEMS})`);
    return items;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = REDACT_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeValue(entry, depth + 1, seen);
  }
  return out;
}

function formatContext(context: LoggerContext): string {
  if (!context || typeof context !== 'object') return '';
  const keys = Object.keys(context);
  if (!keys.length) return '';
  try {
    return ` ${JSON.stringify(sanitizeValue(context, 0, new WeakSet()))}`;
  } catch {
    return '';
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

export function createLogger(options: LoggerOptions = {}) {
  const minLevel = resolveLevel(options.level);
  const name = options.name ? String(options.name) : null;

  function shouldLog(level: LoggerLevel) {
    return LEVELS[level] >= minLevel;
  }

  function write(level: LoggerLevel, message: unknown, context?: LoggerContext) {
    if (!shouldLog(level)) return;

    const safeMessage = message instanceof Error ? message.message : String(message);
    const prefix = name ? `[${name}]` : '';
    const line = `${timestamp()} ${level.toUpperCase()} ${prefix} ${safeMessage}${formatContext(context)}`.trim();

    if (level === 'error') {
      console.error(line);
      return;
    }

    if (level === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    debug(message: unknown, context?: LoggerContext) {
      write('debug', message, context);
    },
    info(message: unknown, context?: LoggerContext) {
      write('info', message, context);
    },
    warn(message: unknown, context?: LoggerContext) {
      write('warn', message, context);
    },
    error(message: unknown, context?: LoggerContext) {
      write('error', message, context);
    },
    child(childName: unknown) {
      const nextName = name ? `${name}:${childName}` : String(childName);
      return createLogger({
        ...(options.level ? { level: options.level } : {}),
        name: nextName,
      });
    },
  };
}




