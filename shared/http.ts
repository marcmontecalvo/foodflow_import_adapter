export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
    this.body = body;
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  /** Minimum gap between requests through this client, to stay polite to a store's site. */
  minIntervalMs?: number;
  /** Retries for 429 / 5xx / network failures. 4xx other than 429 never retries. */
  retries?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A small JSON-over-HTTP client with spacing between calls and bounded retry. */
export function createHttp(options: HttpOptions = {}) {
  const { headers = {}, minIntervalMs = 0, retries = 2, timeoutMs = 60_000 } = options;
  let lastCall = 0;

  async function getJson(url: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) target.searchParams.set(key, String(value));
    }
    for (let attempt = 0; ; attempt++) {
      const wait = lastCall + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      let res: Response;
      try {
        res = await fetch(target, { headers, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt >= retries) throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.ok) return res.json();
      const body = await res.text().catch(() => "");
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(res.status, target.origin + target.pathname, body.slice(0, 500));
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt);
    }
  }

  return { getJson };
}
