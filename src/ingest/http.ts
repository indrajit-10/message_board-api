export const DEFAULT_BASE = 'https://blog.123greetings.com';

const UA =
  'message-board-api ingest (+https://github.com/indrajit-10/message_board-api)';

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  error?: string;
}

/**
 * One polite GET: identifies itself, times out rather than hanging a build,
 * and never throws — callers get a status they can branch on. The ingest job
 * touches a lot of URLs in a row, so a single failure has to be a data point
 * rather than a crash.
 */
export async function get(url: string, timeoutMs = 20_000): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: controller.signal,
      redirect: 'follow',
    });
    return {
      ok: res.ok,
      status: res.status,
      body: await res.text(),
      contentType: res.headers.get('content-type') ?? '',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: '',
      contentType: '',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson<T>(url: string): Promise<{ data: T | null; res: FetchResult }> {
  const res = await get(url);
  if (!res.ok) return { data: null, res };
  try {
    return { data: JSON.parse(res.body) as T, res };
  } catch {
    return { data: null, res: { ...res, ok: false, error: 'response was not JSON' } };
  }
}

/** Space out requests so a full ingest never looks like a hammering. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
