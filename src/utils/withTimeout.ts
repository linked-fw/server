/**
 * Settle with `promise`, or reject with `message` after `ms`. The operation is not
 * cancelled; the timeout only stops a caller (or a queue) from waiting on it forever.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A positive integer from the environment, else `fallback`. */
export function envMs(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const n = Number(env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
