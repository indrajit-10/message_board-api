import { readFile, writeFile } from 'node:fs/promises';
import * as cheerio from 'cheerio';
import { isMain } from './isMain.js';
import { loadManifest, MANIFEST_PATH, type ManifestTopic } from './manifest.js';
import { listSiteUrls } from './sitemap.js';

/**
 * Proposes URLs to put in the manifest's `pages`.
 *
 * An authoring aid, not part of ingest. The keywords it scores with used to
 * decide which topic a crawled page became — silently, and wrongly whenever a
 * title was unusual. Here the same keywords only ever produce a shortlist that
 * a person accepts, which is the difference between a guess in the pipeline
 * and a guess in a suggestion.
 */

const patterns = new Map<string, RegExp>();

/**
 * Whole words, with an optional plural "s".
 *
 * Substring matching cannot tell "son" in "messages-for-son" from the one in
 * "grandson", "person" or "season", and reads "mother" inside "grandmother".
 */
function keywordPattern(keyword: string): RegExp {
  let pattern = patterns.get(keyword);
  if (!pattern) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}s?(?![\\p{L}\\p{N}])`, 'iu');
    patterns.set(keyword, pattern);
  }
  return pattern;
}

export function mentions(text: string, keyword: string): boolean {
  return keywordPattern(keyword).test(text);
}

export interface Suggestion {
  topicId: string;
  label: string;
  paths: string[];
}

/** How specifically a URL matched, so the best candidates sort first. */
function score(text: string, find: { all: string[]; any: string[] }): number {
  const hits = find.any.filter((k) => mentions(text, k)).length;
  // A shorter path that matched is more likely to be the topic's own page than
  // a long one that happens to contain the word.
  return hits * 100 - text.length;
}

export function suggestPages(
  topics: ManifestTopic[],
  siteUrls: string[],
  { includeFilled = false, perTopic = 8 } = {},
): Suggestion[] {
  const haystacks = siteUrls.map((url) => {
    const pathname = new URL(url).pathname;
    return { pathname, text: decodeURIComponent(pathname).replace(/[-_/]+/g, ' ').toLowerCase() };
  });

  const out: Suggestion[] = [];

  for (const topic of topics) {
    if (!includeFilled && topic.pages.length > 0) continue;
    const find = topic.find;
    if (!find || (find.all.length === 0 && find.any.length === 0)) continue;

    const paths = haystacks
      .filter(({ text }) => {
        const allOk = find.all.every((k) => mentions(text, k));
        const anyOk = find.any.length === 0 || find.any.some((k) => mentions(text, k));
        return allOk && anyOk;
      })
      .sort((a, b) => score(b.text, find) - score(a.text, find))
      .slice(0, perTopic)
      .map(({ pathname }) => pathname);

    if (paths.length) out.push({ topicId: topic.id, label: topic.label, paths });
  }

  return out;
}

/**
 * URLs out of a saved file, so this works without reaching the site.
 *
 * Accepts a sitemap (index or urlset) or a plain list, one per line. A sitemap
 * index only lists other sitemaps, so those come back separately — they have
 * to be saved too, rather than silently yielding nothing.
 */
export function urlsFromFile(content: string): { pages: string[]; childSitemaps: string[] } {
  const trimmed = content.trim();
  const raw = trimmed.startsWith('<')
    ? cheerio
        .load(trimmed, { xmlMode: true })('loc')
        .map((_, el) => cheerio.load(trimmed, { xmlMode: true })(el).text().trim())
        .get()
    : trimmed.split('\n').map((l) => l.trim());

  const pages: string[] = [];
  const childSitemaps: string[] = [];

  for (const value of raw) {
    if (!value || value.startsWith('#')) continue;
    if (/\.xml(\?|$)/i.test(value)) childSitemaps.push(value);
    else pages.push(value);
  }

  return { pages, childSitemaps };
}

/** Rewrites `pages` in place, keeping every other field and the file's shape. */
async function applyToManifest(path: string, suggestions: Suggestion[]): Promise<number> {
  const doc = JSON.parse(await readFile(path, 'utf8')) as {
    topics: Array<{ id: string; pages: unknown[] }>;
  };
  const byId = new Map(suggestions.map((s) => [s.topicId, s.paths]));
  let changed = 0;

  for (const topic of doc.topics) {
    const paths = byId.get(topic.id);
    if (!paths || topic.pages.length > 0) continue;
    topic.pages = paths;
    changed++;
  }

  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`);
  return changed;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const values = (flag: string) =>
    argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1] as string] : []));

  const manifestPath = value('--manifest') ?? MANIFEST_PATH;
  const manifest = await loadManifest(manifestPath);
  const files = values('--from');

  let siteUrls: string[];

  if (files.length > 0) {
    // Offline: whatever was saved from the site, no network needed.
    const pages: string[] = [];
    const children: string[] = [];
    for (const file of files) {
      const found = urlsFromFile(await readFile(file, 'utf8'));
      pages.push(...found.pages);
      children.push(...found.childSitemaps);
    }
    siteUrls = [...new Set(pages)].filter((u) => {
      try {
        return new URL(u).host === new URL(manifest.base).host;
      } catch {
        return false;
      }
    });
    console.log(`Read ${siteUrls.length} page URLs from ${files.length} file(s)`);

    if (children.length) {
      console.log();
      console.log(`These are sitemap indexes listing ${children.length} more sitemap(s).`);
      console.log('Save each of these and pass them too, with another --from:');
      for (const child of children.slice(0, 25)) console.log(`  ${child}`);
      if (children.length > 25) console.log(`  … and ${children.length - 25} more`);
      console.log();
    }
  } else {
    const base = value('--base') ?? manifest.base;
    console.log(`Listing pages on ${base} …`);
    siteUrls = await listSiteUrls(base, (m) => console.log(m));
  }

  if (siteUrls.length === 0) {
    console.log();
    console.log('No page URLs to work from.');
    console.log('If this host is unreachable from here, save its sitemap and pass it:');
    console.log('  npm run suggest -- --from ./sitemap_index.xml');
    return;
  }

  const suggestions = suggestPages(manifest.topics, siteUrls, {
    includeFilled: argv.includes('--all'),
  });

  console.log();
  if (suggestions.length === 0) {
    console.log('No candidates matched. Either every topic already has pages');
    console.log('(use --all to see suggestions for those too), or the keywords in');
    console.log('"find" do not appear in any URL on this host.');
    return;
  }

  for (const s of suggestions) {
    console.log(`${s.topicId}  (${s.label})`);
    for (const path of s.paths) console.log(`    ${path}`);
    console.log();
  }

  if (argv.includes('--write')) {
    const changed = await applyToManifest(manifestPath, suggestions);
    console.log(`Wrote pages for ${changed} topic(s) into ${manifestPath}`);
    console.log();
    console.log('These are guesses from URL keywords. A matching URL is not proof the');
    console.log('page holds card messages. Check what they actually produce before');
    console.log('serving any of it:');
    console.log('    npm run check -- --verbose');
  } else {
    console.log('Nothing written. To put these in the manifest:');
    console.log('    npm run suggest -- --write');
    console.log('then check what they produce with:  npm run check -- --verbose');
  }

  const covered = new Set(suggestions.map((s) => s.topicId));
  const uncovered = manifest.topics.filter((t) => t.pages.length === 0 && !covered.has(t.id));
  if (uncovered.length) {
    console.log();
    console.log(`No candidate matched ${uncovered.length} topic(s):`);
    console.log(`  ${uncovered.map((t) => t.id).join(', ')}`);
    console.log('  Add their URLs by hand, or widen their "find" keywords.');
  }
}

if (isMain(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(`\nsuggest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
