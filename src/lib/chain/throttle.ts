/**
 * Tatum's free tier rate-limits bursts (HTTP 429). Every Tatum call goes through
 * `tatumCall`, which spaces calls out and retries 429 / UNAVAILABLE with backoff.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const minIntervalMs = Number(process.env.TATUM_MIN_INTERVAL_MS ?? 350);
let nextSlot = 0;

async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + minIntervalMs;
  if (at > now) await sleep(at - now);
}

export function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: unknown })?.code;
  return /429|RESOURCE_EXHAUSTED|rate limit|too many requests/i.test(msg) || code === "RESOURCE_EXHAUSTED";
}

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = String((err as { code?: unknown })?.code ?? "");
  return isRateLimit(err) || /UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|503|502/i.test(msg + code);
}

export function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = String((err as { code?: unknown })?.code ?? "");
  return /NOT_FOUND|not found/i.test(msg) || code === "NOT_FOUND";
}

export async function tatumCall<T>(fn: () => PromiseLike<T>, retries = 5): Promise<T> {
  let delay = 600;
  for (let attempt = 0; ; attempt++) {
    await waitForSlot();
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      await sleep(delay + Math.random() * 200);
      delay = Math.min(delay * 2, 8000);
    }
  }
}
