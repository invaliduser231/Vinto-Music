function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function withRetry(fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const onRetry = options.onRetry ?? null;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const retry = attempt < maxAttempts && shouldRetry(err, attempt);
      if (!retry) break;

      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * Math.max(100, baseDelayMs));
      const delayMs = Math.min(maxDelayMs, exponential + jitter);

      if (onRetry) {
        onRetry({ attempt, delayMs, error: err });
      }

      await sleep(delayMs);
    }
  }

  throw lastError;
}

export { sleep };
