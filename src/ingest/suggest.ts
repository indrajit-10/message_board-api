import { isMain } from './isMain.js';
import { loadManifest, MANIFEST_PATH } from './manifest.js';
import { listSiteUrls } from './sitemap.js';

/**
 * Proposes URLs to paste into the manifest's `pages`.
 *
 * An authoring aid, not part of ingest. The keywords it scores with used to
 * decide which topic a crawled page became — silently, and wrongly whenever a
 * title was unusual. Here the same keywords only ever produce a shortlist that
 * a person reads and accepts, which is the difference between a guess in the
 * pipeline and a guess in a suggestion.
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
  urls: string[];
}

export function suggestPages(
  topics: Array<{ id: string; label: string; pages: unknown[]; find?: { all: string[]; any: string[] } }>,
  siteUrls: string[],
  { includeFilled = false, perTopic = 8 } = {},
): Suggestion[] {
  const haystacks = siteUrls.map((url) => ({
    url,
    text: decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, ' ').toLowerCase(),
  }));

  const out: Suggestion[] = [];

  for (const topic of topics) {
    if (!includeFilled && topic.pages.length > 0) continue;
    const find = topic.find;
    if (!find || (find.all.length === 0 && find.any.length === 0)) continue;

    const urls = haystacks
      .filter(({ text }) => {
        const allOk = find.all.every((k) => mentions(text, k));
        const anyOk = find.any.length === 0 || find.any.some((k) => mentions(text, k));
        return allOk && anyOk;
      })
      .map(({ url }) => url)
      .slice(0, perTopic);

    if (urls.length) out.push({ topicId: topic.id, label: topic.label, urls });
  }

  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };

  const manifest = await loadManifest(value('--manifest') ?? MANIFEST_PATH);
  const base = value('--base') ?? manifest.base;

  console.log(`Listing pages on ${base} …`);
  const siteUrls = await listSiteUrls(base, (m) => console.log(m));

  if (siteUrls.length === 0) {
    console.log();
    console.log('Nothing to suggest from. Add page URLs to the manifest by hand —');
    console.log('you know the site, and a sitemap is only a shortcut for finding them.');
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

  console.log('Candidates, by topic. Review these — a matching URL is not proof the');
  console.log('page holds card messages. Paste the ones you want into "pages".');
  console.log();

  for (const s of suggestions) {
    console.log(`${s.topicId}  (${s.label})`);
    console.log('  "pages": [');
    for (const url of s.urls) console.log(`    "${new URL(url).pathname}",`);
    console.log('  ]');
    console.log();
  }

  const covered = new Set(suggestions.map((s) => s.topicId));
  const uncovered = manifest.topics.filter((t) => t.pages.length === 0 && !covered.has(t.id));
  if (uncovered.length) {
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
