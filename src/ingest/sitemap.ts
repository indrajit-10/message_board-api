import * as cheerio from 'cheerio';
import { get } from './http.js';
import { isUnderSection, normaliseUrl } from './crawl.js';

/**
 * Every URL a site admits to having, filtered to the section we want.
 *
 * Link-following only ever reaches what something links to. A section index
 * that paginates, or a page reachable only from search, is invisible to it —
 * and "crawl everything under this path" has to mean everything. A sitemap is
 * the site's own list, so the two together cover far more than either alone.
 *
 * Best effort by design: plenty of sites have no sitemap, and that is not an
 * error, it just means the crawl falls back to following links.
 */

const WELL_KNOWN = [
  '/wp-sitemap.xml',
  '/sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/post-sitemap.xml',
  '/page-sitemap.xml',
];

/** A sitemap index can list many children; cap the follow-up to stay polite. */
const MAX_CHILD_SITEMAPS = 50;

function locations(xml: string): { urls: string[]; isIndex: boolean } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const urls = $('loc')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  return { urls, isIndex: $('sitemapindex').length > 0 };
}

async function sitemapsFromRobots(base: string): Promise<string[]> {
  const res = await get(`${base}/robots.txt`);
  if (!res.ok) return [];
  return res.body
    .split('\n')
    .filter((line) => /^\s*sitemap:/i.test(line))
    .map((line) => line.split(/:(.+)/)[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

export async function discoverFromSitemap(
  base: string,
  section: string,
  onProgress?: (message: string) => void,
): Promise<string[]> {
  const candidates = [
    ...(await sitemapsFromRobots(base)),
    ...WELL_KNOWN.map((path) => `${base}${path}`),
  ];

  const found = new Set<string>();
  const tried = new Set<string>();
  let readAny = false;

  for (const candidate of candidates) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);

    const res = await get(candidate);
    if (!res.ok || !/xml/i.test(res.contentType)) continue;
    readAny = true;

    const { urls, isIndex } = locations(res.body);

    if (isIndex) {
      for (const child of urls.slice(0, MAX_CHILD_SITEMAPS)) {
        if (tried.has(child)) continue;
        tried.add(child);
        const childRes = await get(child);
        if (!childRes.ok) continue;
        for (const url of locations(childRes.body).urls) collect(url);
      }
    } else {
      for (const url of urls) collect(url);
    }

    // A sitemap that covered the section is enough; no need to try the rest.
    if (found.size > 0) break;
  }

  function collect(raw: string): void {
    const url = normaliseUrl(raw, base);
    if (url && isUnderSection(url, base, section)) found.add(url);
  }

  if (!readAny) onProgress?.('  no sitemap found, following links only');
  else onProgress?.(`  sitemap listed ${found.size} pages under the section`);

  return [...found];
}
