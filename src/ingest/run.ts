import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BuildResult, buildTopics, hasGlobalFallback, type PageOutcome } from './build.js';
import { fetchDeclared } from './collect.js';
import { isMain } from './isMain.js';
import { loadManifest, type Manifest, MANIFEST_PATH, resolvePageUrl } from './manifest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = join(ROOT, 'data', 'topics.json');

interface Args {
  manifest: string;
  out: string;
  base?: string;
  topic?: string;
  delayMs?: number;
  dryRun: boolean;
  verbose: boolean;
  reset: boolean;
  strict: boolean;
}

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const delay = value('--delay');
  return {
    manifest: value('--manifest') ?? MANIFEST_PATH,
    out: value('--out') ?? DEFAULT_OUT,
    ...(value('--base') ? { base: value('--base') as string } : {}),
    ...(value('--topic') ? { topic: value('--topic') as string } : {}),
    ...(delay ? { delayMs: Number(delay) } : {}),
    dryRun: argv.includes('--dry-run'),
    verbose: argv.includes('--verbose'),
    reset: argv.includes('--reset'),
    strict: argv.includes('--strict'),
  };
}

/** Point every declared page at a different host, for staging or a local copy. */
export function withBase(manifest: Manifest, base: string): Manifest {
  return {
    ...manifest,
    base,
    topics: manifest.topics.map((t) => ({
      ...t,
      pages: t.pages.map((p) => ({
        ...p,
        url: resolvePageUrl(base, new URL(p.url).pathname, `--base ${base}`),
      })),
    })),
  };
}

export function onlyTopic(manifest: Manifest, id: string): Manifest {
  const topic = manifest.topics.find((t) => t.id === id);
  if (!topic) {
    throw new Error(`No topic "${id}" in the manifest. Known ids are listed by: npm run verify`);
  }
  return { ...manifest, topics: [topic] };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function byStatus(outcomes: PageOutcome[]) {
  return {
    ok: outcomes.filter((o) => o.status === 'ok'),
    fallback: outcomes.filter((o) => o.status === 'fallback'),
    empty: outcomes.filter((o) => o.status === 'empty'),
    unreachable: outcomes.filter((o) => o.status === 'unreachable'),
  };
}

/**
 * Everything that did not go cleanly gets named, with the manifest edit that
 * would fix it. A page silently contributing nothing is exactly how the old
 * pipeline lost messages without anyone noticing.
 */
export function report(built: BuildResult, manifest: Manifest, verbose: boolean): void {
  const line = (s = '') => console.log(s);
  const groups = byStatus(built.outcomes);
  const total = built.outcomes.length;

  line();
  line(`pages       ${total} declared`);
  if (groups.ok.length) line(`            ${groups.ok.length} ok`);
  if (groups.fallback.length) line(`            ${groups.fallback.length} FALLBACK — declared selector found nothing`);
  if (groups.empty.length) line(`            ${groups.empty.length} EMPTY — no messages at all`);
  if (groups.unreachable.length) line(`            ${groups.unreachable.length} UNREACHABLE`);
  line(`extracted   ${built.extracted} messages`);
  line(`kept        ${built.kept} after dedupe`);

  const dropped = Object.entries(built.rejected).sort((a, b) => b[1] - a[1]);
  if (dropped.length) {
    line(`rejected    ${dropped.map(([r, n]) => `${r}=${n}`).join('  ')}`);
    line('            tune minLength / maxLength in the manifest, or edit extract.ts');
  }
  line();

  line(`Topics (${built.topics.length} of ${manifest.topics.length} have messages):`);
  for (const t of built.topics) {
    line(`  ${String(t.messages.length).padStart(5)}  ${t.id.padEnd(22)} ${t.serves.join(' ')}`);
  }
  line();

  if (groups.fallback.length) {
    line(`${plural(groups.fallback.length, 'page')} fell back to guessing the markup:`);
    for (const o of groups.fallback) {
      line(`  ${o.url}`);
      line(`      salvaged ${o.messages} via ${o.strategies.join('+')}, for ${o.topics.join(', ')}`);
    }
    line('  Fix: give these pages a "selector" in the manifest, or update defaults.selector.');
    line();
  }

  if (groups.empty.length) {
    line(`${plural(groups.empty.length, 'page')} yielded no messages:`);
    for (const o of groups.empty) line(`  ${o.url}  (for ${o.topics.join(', ')})`);
    line('  Either not a message page, or the markup is one extract.ts does not read.');
    line();
  }

  if (groups.unreachable.length) {
    line(`${plural(groups.unreachable.length, 'page')} could not be read:`);
    for (const o of groups.unreachable) {
      line(`  ${o.url}  ${o.error ?? `HTTP ${o.httpStatus}`}`);
    }
    line('  Fix: correct or remove these entries in the manifest.');
    line();
  }

  if (built.topicsWithoutPages.length) {
    const shown = built.topicsWithoutPages.slice(0, 12).join(', ');
    const more = built.topicsWithoutPages.length - 12;
    line(`${plural(built.topicsWithoutPages.length, 'topic')} have no pages declared:`);
    line(`  ${shown}${more > 0 ? `, … and ${more} more` : ''}`);
    line('  These serve nothing until you add page URLs. Run: npm run suggest');
    line();
  }

  if (!hasGlobalFallback(built.topics)) {
    line('No topic serves "*", so a card with no matching category gets nothing');
    line('back and the app should hide the button. Add pages to a general-purpose');
    line('topic whose "serves" includes "*" to cover that case.');
    line();
  }

  if (verbose) {
    line('Sample of what was kept:');
    for (const t of built.topics.slice(0, 3)) {
      line(`  [${t.id}]`);
      for (const m of t.messages.slice(0, 3)) {
        line(`    - ${(typeof m === 'string' ? m : m.text).slice(0, 100)}`);
      }
    }
    line();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let manifest = await loadManifest(args.manifest);
  if (args.base) manifest = withBase(manifest, args.base);
  if (args.topic) manifest = onlyTopic(manifest, args.topic);

  if (args.reset) {
    await rm(args.out, { force: true });
    console.log(`Removed ${args.out}`);
  }

  const fetched = await fetchDeclared(manifest, {
    ...(args.delayMs === undefined ? {} : { delayMs: args.delayMs }),
    onProgress: (m) => console.log(m),
  });

  const built = buildTopics(manifest, fetched);
  report(built, manifest, args.verbose);

  const failures = built.outcomes.filter((o) => o.status !== 'ok').length;

  if (args.dryRun) {
    console.log('--dry-run, nothing written. Drop the flag to write the store.');
    if (args.strict && failures > 0) process.exitCode = 1;
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
        source: manifest.base,
        manifest: args.manifest,
        topics: built.topics,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote ${args.out}`);
  console.log('Restart the API to serve it (it picks up the store automatically).');

  // --strict is for CI: a fallback or a 404 means the site moved under us, and
  // that should break a scheduled run rather than quietly shrink the store.
  if (args.strict && failures > 0) {
    console.error(`\n--strict: ${plural(failures, 'page')} did not extract cleanly.`);
    process.exitCode = 1;
  }
}

if (isMain(import.meta.url)) {
  // A moved page or a blocked host is an expected outcome here, not a bug in
  // this script — say what happened, without a stack trace.
  try {
    await main();
  } catch (err) {
    console.error(`\ningest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
