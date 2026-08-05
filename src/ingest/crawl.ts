import * as cheerio from 'cheerio';
import type { RawPost } from './fetchPosts.js';
import { get, pause } from './http.js';

export interface CrawlOptions {
  base: string;
  /** Where to begin. */
  section: string;
  /**
   * What counts as in bounds, default the whole host.
   *
   * Kept separate from the starting point on purpose. The section index is a
   * hub: it links to message pages that live elsewhere on the site, so using
   * it as the boundary as well means following none of them and coming back
   * with the hub and little else.
   */
  scope?: string;
  maxPages?: number;
  maxDepth?: number;
  delayMs?: number;
  /** Extra starting points, e.g. everything the sitemap lists. */
  seeds?: string[];
  onProgress?: (message: string) => void;
}

const DEFAULTS = { maxPages: 2000, maxDepth: 8, delayMs: 250 };

/** Assets and feeds that are never a page of card messages. */
const NOT_A_PAGE = /\.(?:jpe?g|png|gif|svg|webp|ico|css|js|pdf|zip|xml|rss)(?:$|\?)/i;

/**
 * Everything under a section URL, found by following links rather than by
 * asking an API.
 *
 * The messages live in a path tree — /what-to-write-in-a-card/, then /birthday,
 * /anniversary and so on beneath it. Whether those are WordPress posts, pages
 * or hand-built HTML is not something we can know from outside, and the posts
 * API only ever sees one of the three. Walking the links finds them all.
 */
export function normaliseUrl(raw: string, base: string): string | null {
  // An empty href resolves to the page itself, which is never a new link.
  if (!raw.trim()) return null;

  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.search = '';

  // One canonical form, so /birthday and /birthday/ are not crawled twice.
  // Only directory-style paths get the slash: "cover.jpg/" would no longer
  // look like a file, and the asset filter would let it through.
  const last = url.pathname.split('/').pop() ?? '';
  if (!url.pathname.endsWith('/') && !last.includes('.')) url.pathname += '/';

  return url.href;
}

export function isUnderSection(href: string, base: string, section: string): boolean {
  let url: URL;
  let root: URL;
  try {
    url = new URL(href);
    root = new URL(section, base);
  } catch {
    return false;
  }
  if (url.host !== root.host) return false;
  if (NOT_A_PAGE.test(url.pathname)) return false;

  const sectionPath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
  return url.pathname.startsWith(sectionPath);
}

/** The path below the section root, e.g. ["birthday", "for-mom"]. */
export function sectionSegments(href: string, base: string, section: string): string[] {
  const url = new URL(href);
  const root = new URL(section, base);
  const sectionPath = root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`;
  return url.pathname.slice(sectionPath.length).split('/').filter(Boolean);
}

function pageTitle($: cheerio.CheerioAPI): string {
  const h1 = $('h1').first().text().trim();
  if (h1) return h1;
  return $('title').first().text().trim();
}

/**
 * Breadth-first so the section index and its immediate children are read
 * before anything deeper — if a cap is hit, what is kept is the useful part
 * of the tree rather than an arbitrary branch of it.
 */
export async function crawlSection(options: CrawlOptions): Promise<RawPost[]> {
  const { base, section, onProgress } = options;
  const scope = options.scope ?? '/';
  const maxPages = options.maxPages ?? DEFAULTS.maxPages;
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;
  const delayMs = options.delayMs ?? DEFAULTS.delayMs;

  const start = normaliseUrl(section, base);
  if (!start) throw new Error(`Could not build a URL from base "${base}" and section "${section}".`);

  const seen = new Set<string>([start]);
  const queue: Array<{ url: string; depth: number }> = [{ url: start, depth: 0 }];

  // Seeds go in at depth 0 so their own links are followed too — a sitemap
  // can list a section index without listing everything beneath it.
  for (const seed of options.seeds ?? []) {
    const url = normaliseUrl(seed, base);
    if (!url || seen.has(url) || !isUnderSection(url, base, scope)) continue;
    seen.add(url);
    queue.push({ url, depth: 0 });
  }

  const pages: RawPost[] = [];
  let fetched = 0;
  let failed = 0;
  let deepest = 0;

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift()!;

    const res = await get(url);
    fetched++;
    if (!res.ok || !/html/i.test(res.contentType)) {
      failed++;
      onProgress?.(`  skipped ${url} (HTTP ${res.status})`);
      await pause(delayMs);
      continue;
    }

    const $ = cheerio.load(res.body);
    const segments = sectionSegments(url, base, scope);
    deepest = Math.max(deepest, depth);

    pages.push({
      slug: segments.at(-1) ?? 'index',
      title: pageTitle($),
      link: url,
      html: res.body,
      // Path segments describe the subject far more reliably than a slug does,
      // and they are what the mapping rules read.
      categories: segments,
    });

    if (depth < maxDepth) {
      for (const el of $('a[href]').toArray()) {
        const href = normaliseUrl($(el).attr('href') ?? '', url);
        if (!href || seen.has(href)) continue;
        if (!isUnderSection(href, base, scope)) continue;
        seen.add(href);
        queue.push({ url: href, depth: depth + 1 });
      }
    }

    if (pages.length % 10 === 0) onProgress?.(`  crawled ${pages.length} pages`);
    await pause(delayMs);
  }

  const stoppedShort = pages.length >= maxPages;
  onProgress?.(
    `  crawl finished: ${pages.length} pages kept, ${fetched} fetched, ${failed} skipped` +
      `, ${deepest} levels deep` +
      (stoppedShort ? `, STOPPED at the ${maxPages}-page cap` : ''),
  );
  // Hitting a cap means pages were left unread; say so rather than let the
  // result look like the whole section.
  if (stoppedShort) {
    onProgress?.(`  raise it with --limit if the section is larger than ${maxPages} pages`);
  }
  if (deepest >= maxDepth) {
    onProgress?.(`  reached the depth limit of ${maxDepth}; anything deeper was not followed`);
  }

  if (pages.length === 0) {
    throw new Error(
      `Nothing readable under ${start}. Check the section path, and run "npm run probe" to see what the host returns.`,
    );
  }

  return pages;
}
