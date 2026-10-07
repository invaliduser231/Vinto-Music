import { TimeoutError } from '../core/errors.ts';

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
