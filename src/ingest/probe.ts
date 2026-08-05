import * as cheerio from 'cheerio';
import { DEFAULT_BASE, get, getJson } from './http.js';
import { isMain } from './isMain.js';
import { DEFAULT_SECTION } from './run.js';
import { discoverFromSitemap } from './sitemap.js';

/**
 * Reports what the blog actually exposes, so ingest is configured against
 * observed behaviour rather than an assumption about how the site is built.
 *
 * Run it before the first ingest, and again if extraction quality drops —
 * a theme change usually shows up here first.
 */

interface WpPost {
  id: number;
  link: string;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  categories?: number[];
}

interface WpCategory {
  id: number;
  name: string;
  slug: string;
  count: number;
}

export interface ProbeReport {
  base: string;
  section: string;
  sitemapPages: string[];
  robots: { status: number; disallows: string[] };
  wpJson: { available: boolean; status: number; postCount: number | null };
  feed: { available: boolean; status: number };
  categories: Array<{ name: string; slug: string; count: number }>;
  samplePost: {
    title: string;
    slug: string;
    link: string;
    contentChars: number;
    structure: Record<string, number>;
    firstListItems: string[];
    firstParagraphs: string[];
  } | null;
}

function countTags($: cheerio.CheerioAPI): Record<string, number> {
  const tags = ['li', 'p', 'blockquote', 'h2', 'h3', 'h4', 'table', 'img'];
  const out: Record<string, number> = {};
  for (const tag of tags) out[tag] = $(tag).length;
  return out;
}

function sampleText($: cheerio.CheerioAPI, selector: string, n: number): string[] {
  return $(selector)
    .slice(0, n)
    .map((_, el) => $(el).text().replace(/\s+/g, ' ').trim())
    .get()
    .filter(Boolean);
}

export async function probe(base = DEFAULT_BASE, section = DEFAULT_SECTION): Promise<ProbeReport> {
  const robotsRes = await get(`${base}/robots.txt`);
  const disallows = robotsRes.ok
    ? robotsRes.body
        .split('\n')
        .filter((l) => /^\s*disallow:/i.test(l))
        .map((l) => l.split(':').slice(1).join(':').trim())
        .filter(Boolean)
    : [];

  const posts = await getJson<WpPost[]>(`${base}/wp-json/wp/v2/posts?per_page=1`);
  const cats = await getJson<WpCategory[]>(`${base}/wp-json/wp/v2/categories?per_page=100`);
  const feedRes = await get(`${base}/feed/`);

  let samplePost: ProbeReport['samplePost'] = null;
  const first = posts.data?.[0];
  if (first) {
    const $ = cheerio.load(first.content.rendered);
    samplePost = {
      title: first.title.rendered,
      slug: first.slug,
      link: first.link,
      contentChars: first.content.rendered.length,
      structure: countTags($),
      firstListItems: sampleText($, 'li', 5),
      firstParagraphs: sampleText($, 'p', 5),
    };
  }

  const sitemapPages = await discoverFromSitemap(base, section);

  return {
    base,
    section,
    sitemapPages,
    robots: { status: robotsRes.status, disallows },
    wpJson: {
      available: Boolean(posts.data),
      status: posts.res.status,
      postCount: posts.data ? posts.data.length : null,
    },
    feed: { available: feedRes.ok && /xml/.test(feedRes.contentType), status: feedRes.status },
    categories: (cats.data ?? [])
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((c) => ({ name: c.name, slug: c.slug, count: c.count })),
    samplePost,
  };
}

function print(report: ProbeReport): void {
  const line = (s = '') => console.log(s);
  line(`Probing ${report.base}`);
  line();

  line(`robots.txt        HTTP ${report.robots.status}`);
  if (report.robots.disallows.length) {
    line(`  disallows: ${report.robots.disallows.slice(0, 8).join(', ')}`);
  }

  line(
    `wp-json           ${report.wpJson.available ? 'YES' : 'no'}  (HTTP ${report.wpJson.status})`,
  );
  line(`feed              ${report.feed.available ? 'YES' : 'no'}  (HTTP ${report.feed.status})`);
  line();

  line(`section           ${report.section}`);
  line(`  sitemap lists    ${report.sitemapPages.length} pages under it`);
  for (const url of report.sitemapPages.slice(0, 25)) line(`    ${new URL(url).pathname}`);
  if (report.sitemapPages.length > 25) {
    line(`    … and ${report.sitemapPages.length - 25} more`);
  }
  line();

  if (report.categories.length) {
    line(`Categories (${report.categories.length}), busiest first:`);
    for (const c of report.categories.slice(0, 20)) {
      line(`  ${String(c.count).padStart(4)}  ${c.slug}`);
    }
    line();
  }

  if (report.samplePost) {
    const s = report.samplePost;
    line(`Sample post: ${s.title}`);
    line(`  slug ${s.slug}`);
    line(`  ${s.contentChars} chars of HTML`);
    line(
      `  structure: ${Object.entries(s.structure)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t}=${n}`)
        .join('  ')}`,
    );
    if (s.firstListItems.length) {
      line('  first <li> items:');
      for (const t of s.firstListItems) line(`    - ${t.slice(0, 90)}`);
    }
    if (s.firstParagraphs.length) {
      line('  first <p> items:');
      for (const t of s.firstParagraphs) line(`    - ${t.slice(0, 90)}`);
    }
    line();
  }

  // Ingest crawls the section by default, so the sitemap matters more than
  // the API here — say what will actually happen, not what an API can do.
  // A blocked host answers everything with the same error, so "no sitemap" and
  // "cannot reach the site" look identical unless every probe is considered
  // together. A proxy denial arrives as 403, not as a connection failure.
  const nothingAnswered =
    report.sitemapPages.length === 0 &&
    !report.wpJson.available &&
    !report.feed.available &&
    !(report.robots.status >= 200 && report.robots.status < 300);

  if (report.sitemapPages.length > 0) {
    line(`The sitemap covers ${report.section}, so the crawl has a full list to work from.`);
    line('Run: npm run ingest -- --reset --dry-run');
  } else if (nothingAnswered) {
    line(`Nothing on ${report.base} answered — robots.txt came back ${report.robots.status || 'unreachable'}.`);
    line('The host is refusing this client, or a proxy or firewall is in the way.');
    line('Ingest cannot work until a plain `curl` to that address succeeds.');
  } else {
    line(`No sitemap listed ${report.section}. The crawl will still follow links`);
    line('from the section index, which reaches less but usually still works.');
    line('Run: npm run ingest -- --reset --dry-run');
    if (report.wpJson.available) {
      line('wp-json also responded, so --transport wp-json is an alternative.');
    }
  }
}

if (isMain(import.meta.url)) {
  const base = process.argv.includes('--base')
    ? (process.argv[process.argv.indexOf('--base') + 1] ?? DEFAULT_BASE)
    : DEFAULT_BASE;
  const sectionArg = process.argv.includes('--section')
    ? (process.argv[process.argv.indexOf('--section') + 1] ?? DEFAULT_SECTION)
    : DEFAULT_SECTION;
  const report = await probe(base, sectionArg);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else print(report);
}
