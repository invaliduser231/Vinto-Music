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

function formatContext(context: LoggerContext): string {
  if (!context || typeof context !== 'object') return '';
  const keys = Object.keys(context);
  if (!keys.length) return '';
  try {
    return ` ${JSON.stringify(context)}`;
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




