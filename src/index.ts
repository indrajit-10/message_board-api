import { createApp } from './app.js';
import { createSource } from './sources/index.js';

const port = Number(process.env.PORT ?? 3000);

// A flag rather than an env var: setting one inline works differently in bash,
// cmd and PowerShell, and this has to be the same command everywhere.
const kind = process.argv.includes('--live') ? 'live' : undefined;

const source = createSource(kind);
await source.load();

const messages = source.topics().reduce((sum, t) => sum + t.messages.length, 0);
const rule = '─'.repeat(64);

/**
 * Serving placeholders looks exactly like serving the blog unless something
 * says otherwise: the API answers, the pages render, the counts are just
 * lower. Announcing it at startup is the difference between noticing in
 * seconds and assuming the crawl worked.
 */
function announce(): void {
  console.log(rule);
  if (!source.degraded) {
    console.log(`  ${messages} messages from the blog, ${source.topics().length} topics`);
    console.log(`  last read ${source.lastUpdated() ?? 'unknown'}`);
  } else if (source.name === 'fixture') {
    console.log(`  PLACEHOLDERS — ${messages} built-in messages. The blog has NOT been read.`);
    console.log();
    console.log('  To read the blog instead, stop this (Ctrl+C) and run:');
    console.log('      npm run dev:live');
  } else {
    console.log(`  PLACEHOLDERS — reading the blog failed, see the error above.`);
    console.log(`  Serving ${messages} built-in messages so the API still answers.`);
  }
  console.log(rule);
}

createApp(source).listen(port, () => {
  announce();
  console.log(`  listening on http://localhost:${port}`);
  console.log(`    demo    http://localhost:${port}/`);
  console.log(`    browse  http://localhost:${port}/browse`);
  console.log(`    api     http://localhost:${port}/api`);
});
