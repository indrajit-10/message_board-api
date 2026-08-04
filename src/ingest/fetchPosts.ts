import * as cheerio from 'cheerio';
import { DEFAULT_BASE, get, getJson, pause } from './http.js';

export interface RawPost {
  slug: string;
  title: string;
  link: string;
  html: string;
  categories: string[];
}

export interface FetchOptions {
  base?: string;
  limit?: number;
  categorySlug?: string;
  onProgress?: (message: string) => void;
}

interface WpPost {
  slug: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  categories?: number[];
}

interface WpCategory {
  id: number;
  name: string;
  slug: string;
}

const PER_PAGE = 100;
const POLITE_DELAY_MS = 300;

function stripTags(html: string): string {
  return cheerio.load(`<div>${html}</div>`)('div').text().replace(/\s+/g, ' ').trim();
}

async function viaWpJson(opts: Required<Pick<FetchOptions, 'base'>> & FetchOptions) {
  const { base, limit = Infinity, categorySlug, onProgress } = opts;

  const cats = await getJson<WpCategory[]>(`${base}/wp-json/wp/v2/categories?per_page=100`);
  if (!cats.data) return null;

  const byId = new Map(cats.data.map((c) => [c.id, c.slug]));

  let categoryFilter = '';
  if (categorySlug) {
    const match = cats.data.find((c) => c.slug === categorySlug);
    if (!match) {
      throw new Error(
        `No blog category with slug "${categorySlug}". Available: ${cats.data
          .map((c) => c.slug)
          .join(', ')}`,
      );
    }
    categoryFilter = `&categories=${match.id}`;
  }

  const posts: RawPost[] = [];
  for (let page = 1; posts.length < limit; page++) {
    const url = `${base}/wp-json/wp/v2/posts?per_page=${PER_PAGE}&page=${page}${categoryFilter}`;
    const { data, res } = await getJson<WpPost[]>(url);

    // A page past the end is a 400 from WordPress, not an error worth raising.
    if (!data || data.length === 0) {
      if (page === 1 && !res.ok) return null;
      break;
    }

    for (const p of data) {
      posts.push({
        slug: p.slug,
        title: stripTags(p.title.rendered),
        link: p.link,
        html: p.content.rendered,
        categories: (p.categories ?? []).map((id) => byId.get(id) ?? String(id)),
      });
    }

    onProgress?.(`  fetched ${posts.length} posts`);
    if (data.length < PER_PAGE) break;
    await pause(POLITE_DELAY_MS);
  }

  return posts.slice(0, limit === Infinity ? undefined : limit);
}

async function viaFeed(base: string, limit = Infinity): Promise<RawPost[] | null> {
  const res = await get(`${base}/feed/`);
  if (!res.ok) return null;

  const $ = cheerio.load(res.body, { xmlMode: true });
  const posts: RawPost[] = [];

  $('item').each((_, el) => {
    if (posts.length >= limit) return;
    const item = $(el);
    const link = item.find('link').first().text().trim();
    const html = item.find('content\\:encoded').first().text() || item.find('description').text();
    posts.push({
      slug: link.replace(/\/$/, '').split('/').pop() ?? '',
      title: item.find('title').first().text().trim(),
      link,
      html,
      categories: item
        .find('category')
        .map((__, c) => $(c).text().trim().toLowerCase())
        .get(),
    });
  });

  return posts.length ? posts : null;
}

/**
 * Prefers the REST API and falls back to the feed.
 *
 * The feed carries only the most recent posts — usually 10 to 25 — so it is a
 * way to keep working, not a substitute. The returned `transport` says which
 * ran, because "only 20 messages ingested" is otherwise a confusing result.
 */
export async function fetchPosts(
  options: FetchOptions = {},
): Promise<{ posts: RawPost[]; transport: 'wp-json' | 'feed' }> {
  const base = options.base ?? DEFAULT_BASE;

  const wp = await viaWpJson({ ...options, base });
  if (wp && wp.length) return { posts: wp, transport: 'wp-json' };

  options.onProgress?.('  wp-json unavailable, falling back to the feed');
  const feed = await viaFeed(base, options.limit);
  if (feed) return { posts: feed, transport: 'feed' };

  throw new Error(
    `Could not read posts from ${base}. Neither /wp-json/wp/v2/posts nor /feed/ returned usable data — run "npm run probe" to see what the host is actually serving.`,
  );
}
