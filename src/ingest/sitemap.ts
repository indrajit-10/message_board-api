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

/**
 * Indexes first, then the per-type files Yoast and similar plugins publish.
 *
 * The per-type split is the important part: Yoast puts posts in
 * post-sitemap.xml and pages in page-sitemap.xml, so a section built from
 * WordPress pages is listed in neither the posts sitemap nor the posts API.
 * Every one of these is read — stopping at the first that returns something
 * is how you end up with only half a section.
 */
const WELL_KNOWN = [
  '/wp-sitemap.xml',
  '/sitemap_index.xml',
  '/sitemap-index.xml',
  '/sitemap.xml',
  '/page-sitemap.xml',
  '/post-sitemap.xml',
  '/category-sitemap.xml',
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
  const contributors: string[] = [];

  function collect(raw: string): void {
    const url = normaliseUrl(raw, base);
    if (url && isUnderSection(url, base, section)) found.add(url);
  }

  async function read(url: string): Promise<number> {
    if (tried.has(url)) return 0;
    tried.add(url);

    const res = await get(url);
    if (!res.ok || !/xml/i.test(res.contentType)) return 0;

    const before = found.size;
    const { urls, isIndex } = locations(res.body);

    if (isIndex) {
      for (const child of urls.slice(0, MAX_CHILD_SITEMAPS)) await read(child);
    } else {
      for (const url of urls) collect(url);
    }
    return found.size - before;
  }

  // Every candidate, not just the first that works: a site can split its
  // sitemap by post type, and the section may live in more than one of them.
  for (const candidate of candidates) {
    const added = await read(candidate);
    if (added > 0) contributors.push(`${new URL(candidate).pathname} (+${added})`);
  }

  if (found.size === 0) onProgress?.('  no sitemap listed this section, following links only');
  else onProgress?.(`  sitemap listed ${found.size} pages: ${contributors.join(', ')}`);

  return [...found];
}
