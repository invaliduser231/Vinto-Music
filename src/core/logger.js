const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveLevel(level) {
  if (typeof level !== 'string') return LEVELS.info;
  return LEVELS[level.toLowerCase()] ?? LEVELS.info;
}

function formatContext(context) {
  if (!context || typeof context !== 'object') return '';
  const keys = Object.keys(context);
  if (!keys.length) return '';
  try {
    return ` ${JSON.stringify(context)}`;
  } catch {
    return '';
  }
}

function timestamp() {
  return new Date().toISOString();
}

export function createLogger(options = {}) {
  const minLevel = resolveLevel(options.level);
  const name = options.name ? String(options.name) : null;

  function shouldLog(level) {
    return LEVELS[level] >= minLevel;
  }

  function write(level, message, context) {
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
    debug(message, context) {
      write('debug', message, context);
    },
    info(message, context) {
      write('info', message, context);
    },
    warn(message, context) {
      write('warn', message, context);
    },
    error(message, context) {
      write('error', message, context);
    },
    child(childName) {
      const nextName = name ? `${name}:${childName}` : String(childName);
      return createLogger({ level: options.level, name: nextName });
    },
  };
}
