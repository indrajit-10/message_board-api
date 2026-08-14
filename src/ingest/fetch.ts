const UA = 'message-board-api ingest (+https://github.com/indrajit-10/message_board-api)';

export interface FetchResult {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  error?: string;
}

/**
 * One polite GET: identifies itself, times out rather than hanging a build,
 * and never throws — callers get a status they can branch on. An ingest walks
 * a list of URLs, so a single failure has to be a data point rather than a
 * crash that loses the other forty.
 */
export async function get(url: string, timeoutMs = 20_000): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,*/*' },
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

/** Space out requests so a full ingest never looks like a hammering. */
export function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
