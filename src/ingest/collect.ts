import type { FetchedPage } from './build.js';
import { get, pause } from './fetch.js';
import { type Manifest, pageTargets } from './manifest.js';

export interface CollectOptions {
  delayMs?: number;
  onProgress?: (message: string) => void;
}

/**
 * Fetch exactly the pages the manifest names — nothing discovered, nothing
 * followed.
 *
 * The old pipeline walked links and read sitemaps because it could not know
 * what existed. The list is now declared, so this is a loop over it, and a
 * page that stops responding is one named failure rather than a hole in a
 * crawl nobody notices.
 */
export async function fetchDeclared(
  manifest: Manifest,
  { delayMs = 250, onProgress }: CollectOptions = {},
): Promise<Map<string, FetchedPage>> {
  const targets = pageTargets(manifest);
  const urls = [...new Set(targets.map((t) => t.url))];
  const fetched = new Map<string, FetchedPage>();

  onProgress?.(`Reading ${urls.length} declared page${urls.length === 1 ? '' : 's'} from ${manifest.base}`);

  for (const [i, url] of urls.entries()) {
    const res = await get(url);
    const isHtml = /html/i.test(res.contentType);

    fetched.set(url, {
      url,
      ok: res.ok && isHtml,
      status: res.status,
      html: res.body,
      ...(res.error
        ? { error: res.error }
        : res.ok && !isHtml
          ? { error: `expected HTML, got "${res.contentType || 'no content-type'}"` }
          : {}),
    });

    if (!res.ok) onProgress?.(`  [${i + 1}/${urls.length}] ${url} — HTTP ${res.status}`);
    if (i < urls.length - 1) await pause(delayMs);
  }

  return fetched;
}
