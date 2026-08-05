import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Topic } from '../types.js';
import { crawlSection } from './crawl.js';
import { extractMessages } from './extract.js';
import { fetchPosts, type RawPost } from './fetchPosts.js';
import { DEFAULT_BASE } from './http.js';
import { isMain } from './isMain.js';
import { loadRules, matchRule, type Rule } from './mapping.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = join(ROOT, 'data', 'topics.json');
const FIXTURES = join(ROOT, 'src', 'sources', 'fixtures', 'topics.json');

/** Where the card messages live. Everything under it is fair game. */
export const DEFAULT_SECTION = '/what-to-write-in-a-card/';

interface Args {
  base: string;
  out: string;
  section: string;
  transport: 'crawl' | 'wp-json';
  limit?: number;
  categorySlug?: string;
  dryRun: boolean;
  verbose: boolean;
  reset: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const limit = value('--limit');
  const transport = value('--transport') ?? 'crawl';
  if (transport !== 'crawl' && transport !== 'wp-json') {
    throw new Error(`--transport must be "crawl" or "wp-json", got "${transport}".`);
  }
  return {
    base: value('--base') ?? DEFAULT_BASE,
    out: value('--out') ?? DEFAULT_OUT,
    section: value('--section') ?? DEFAULT_SECTION,
    transport,
    limit: limit ? Number(limit) : undefined,
    categorySlug: value('--category'),
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    reset: argv.includes('--reset'),
  };
}

interface Bucket {
  rule: Rule;
  messages: Array<{ text: string; source_url: string }>;
  postCount: number;
}

export interface IngestSummary {
  transport: string;
  posts: number;
  extracted: number;
  kept: number;
  topics: Topic[];
  patterns: Record<string, number>;
  unmapped: RawPost[];
  empty: RawPost[];
  seededFallback: boolean;
}

/** Pure pipeline over already-fetched posts, so it can be tested without network. */
export function buildTopics(posts: RawPost[], rules: Rule[]) {
  const buckets = new Map<string, Bucket>();
  const patterns: Record<string, number> = {};
  const unmapped: RawPost[] = [];
  const empty: RawPost[] = [];
  let extracted = 0;

  for (const post of posts) {
    const result = extractMessages(post.html);
    patterns[result.pattern] = (patterns[result.pattern] ?? 0) + 1;
    extracted += result.messages.length;

    if (result.messages.length === 0) {
      empty.push(post);
      continue;
    }

    const rule = matchRule(post, rules);
    if (!rule) {
      unmapped.push(post);
      continue;
    }

    let bucket = buckets.get(rule.id);
    if (!bucket) {
      bucket = { rule, messages: [], postCount: 0 };
      buckets.set(rule.id, bucket);
    }
    bucket.postCount++;
    for (const text of result.messages) bucket.messages.push({ text, source_url: post.link });
  }

  // Posts overlap in content, so dedupe within each topic after merging.
  const topics: Topic[] = [];
  for (const bucket of buckets.values()) {
    const seen = new Set<string>();
    const messages = bucket.messages.filter((m) => {
      const key = m.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    topics.push({
      id: bucket.rule.id,
      label: bucket.rule.label,
      source_url: messages[0]?.source_url ?? '',
      serves: bucket.rule.serves,
      messages,
    });
  }

  topics.sort((a, b) => b.messages.length - a.messages.length);
  const kept = topics.reduce((n, t) => n + t.messages.length, 0);
  return { topics, patterns, unmapped, empty, extracted, kept };
}

/**
 * The API resolves an uncovered card down to the topic serving "*". Without
 * one, those requests 503 and the CTA breaks on exactly the long-tail cards it
 * is meant to rescue — so if ingest produced no global fallback, borrow the
 * fixture one rather than ship a store that cannot answer.
 */
async function ensureFallback(topics: Topic[]): Promise<boolean> {
  if (topics.some((t) => t.serves.includes('*'))) return false;
  const fixture = JSON.parse(await readFile(FIXTURES, 'utf8')) as { topics: Topic[] };
  const everyday = fixture.topics.find((t) => t.serves.includes('*'));
  if (everyday) topics.push(everyday);
  return Boolean(everyday);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function report(summary: IngestSummary, args: Args): void {
  const line = (s = '') => console.log(s);

  line();
  line(`transport   ${summary.transport}`);
  line(`posts       ${summary.posts}`);
  line(
    `markup      ${Object.entries(summary.patterns)
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => `${p}=${n}`)
      .join('  ')}`,
  );
  line(`extracted   ${summary.extracted} messages`);
  line(`kept        ${summary.kept} after dedupe`);
  line();

  line(`Topics (${summary.topics.length}):`);
  for (const t of summary.topics) {
    line(`  ${String(t.messages.length).padStart(5)}  ${t.id.padEnd(20)} ${t.serves.join(' ')}`);
  }
  line();

  if (summary.empty.length) {
    line(`${plural(summary.empty.length, 'post')} yielded no messages:`);
    for (const p of summary.empty.slice(0, 10)) line(`  ${p.slug}`);
    if (summary.empty.length > 10) line(`  … and ${summary.empty.length - 10} more`);
    line('  If these are message posts, the markup is one extract.ts does not read yet.');
    line();
  }

  if (summary.unmapped.length) {
    line(`${plural(summary.unmapped.length, 'post')} had messages but no card mapping:`);
    for (const p of summary.unmapped.slice(0, 15)) line(`  ${p.slug}`);
    if (summary.unmapped.length > 15) line(`  … and ${summary.unmapped.length - 15} more`);
    line('  Add rules to src/ingest/rules.json to bring these in.');
    line();
  }

  if (summary.seededFallback) {
    line('No ingested topic serves "*", so the fixture fallback was kept.');
    line('Add a rule serving "*" once you know which posts are general-purpose.');
    line();
  }

  if (args.verbose) {
    line('Sample of what was kept:');
    for (const t of summary.topics.slice(0, 3)) {
      line(`  [${t.id}]`);
      for (const m of t.messages.slice(0, 3)) {
        line(`    - ${(typeof m === 'string' ? m : m.text).slice(0, 100)}`);
      }
    }
    line();
  }
}

async function collect(args: Args): Promise<{ posts: RawPost[]; transport: string }> {
  const onProgress = (m: string) => console.log(m);

  if (args.transport === 'wp-json') {
    return fetchPosts({
      base: args.base,
      ...(args.limit === undefined ? {} : { limit: args.limit }),
      ...(args.categorySlug === undefined ? {} : { categorySlug: args.categorySlug }),
      onProgress,
    });
  }

  const pages = await crawlSection({
    base: args.base,
    section: args.section,
    ...(args.limit === undefined ? {} : { maxPages: args.limit }),
    onProgress,
  });
  return { posts: pages, transport: `crawl ${args.section}` };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.reset) {
    await rm(args.out, { force: true });
    console.log(`Removed ${args.out}`);
  }

  console.log(
    args.transport === 'crawl'
      ? `Crawling ${args.base}${args.section} and everything under it`
      : `Ingesting from ${args.base}${args.categorySlug ? ` [${args.categorySlug}]` : ''}`,
  );

  const rules = await loadRules();
  const { posts, transport } = await collect(args);

  const built = buildTopics(posts, rules);
  const seededFallback = await ensureFallback(built.topics);
  // Re-sort: a seeded fallback is appended after buildTopics has ordered them.
  built.topics.sort((a, b) => b.messages.length - a.messages.length);

  const summary: IngestSummary = {
    transport,
    posts: posts.length,
    extracted: built.extracted,
    kept: built.kept,
    topics: built.topics,
    patterns: built.patterns,
    unmapped: built.unmapped,
    empty: built.empty,
    seededFallback,
  };

  report(summary, args);

  if (args.dryRun) {
    console.log('--dry-run, nothing written. Drop the flag to write the store.');
    return;
  }

  if (built.kept === 0) {
    console.error('Nothing extracted, refusing to overwrite the store.');
    process.exitCode = 1;
    return;
  }

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(
    args.out,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        source: args.base,
        transport,
        topics: built.topics,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${args.out}`);
  console.log('Restart the API to serve it (it picks up the store automatically).');
}

if (isMain(import.meta.url)) {
  // A blocked host or a moved endpoint is an expected outcome here, not a bug
  // in this script — say what happened and what to try, without a stack trace.
  try {
    await main();
  } catch (err) {
    console.error(`\ningest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
