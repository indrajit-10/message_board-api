import * as cheerio from 'cheerio';
import { get } from './fetch.js';

/**
 * Every URL the site admits to having.
 *
 * Not part of ingest — the manifest says what to read. This backs
 * `npm run suggest`, which proposes URLs to put in the manifest in the first
 * place, so it only ever has to be good enough to shortlist by hand.
 */

/**
 * Indexes first, then the per-type files Yoast and similar plugins publish.
 *
 * The per-type split matters: Yoast puts posts in post-sitemap.xml and pages
 * in page-sitemap.xml, so a section built from WordPress pages is listed in
 * neither the posts sitemap nor the posts API. All of them are read.
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
const MAX_CHILD_SITEMAPS = 200;

const NOT_A_PAGE = /\.(?:jpe?g|png|gif|svg|webp|ico|css|js|pdf|zip|xml|rss)(?:$|\?)/i;

function canonical(raw: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.host !== new URL(base).host) return null;
  if (NOT_A_PAGE.test(url.pathname)) return null;

  url.hash = '';
  url.search = '';
  // One form, so /birthday and /birthday/ are not listed twice.
  const last = url.pathname.split('/').pop() ?? '';
  if (!url.pathname.endsWith('/') && !last.includes('.')) url.pathname += '/';
  return url.href;
}

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

export async function listSiteUrls(
  base: string,
  onProgress?: (message: string) => void,
): Promise<string[]> {
  const candidates = [
    ...(await sitemapsFromRobots(base)),
    ...WELL_KNOWN.map((path) => `${base}${path}`),
  ];

  const found = new Set<string>();
  const tried = new Set<string>();
  const contributors: string[] = [];

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
      for (const raw of urls) {
        const url = canonical(raw, base);
        if (url) found.add(url);
      }
    }
    return found.size - before;
  }

  // Every candidate, not just the first that works: a site can split its
  // sitemap by post type, and message pages may live in more than one of them.
  for (const candidate of candidates) {
    const added = await read(candidate);
    if (added > 0) contributors.push(`${new URL(candidate).pathname} (+${added})`);
  }

  if (found.size === 0) onProgress?.('  no sitemap found on this host');
  else onProgress?.(`  sitemap listed ${found.size} pages: ${contributors.join(', ')}`);

  return [...found];
}
