import { createApp } from './app.js';
import { createSource } from './sources/index.js';

const port = Number(process.env.PORT ?? 3000);

// A flag rather than an env var: setting one inline works differently in bash,
// cmd and PowerShell, and this has to be the same command everywhere.
const kind = process.argv.includes('--live') ? 'live' : undefined;

const source = createSource(kind);
await source.load();

createApp(source).listen(port, () => {
  console.log(`message-board-api listening on http://localhost:${port}`);
  console.log(`  source=${source.name} topics=${source.topics().length}`);
  console.log(`  demo   http://localhost:${port}/`);
  console.log(`  browse http://localhost:${port}/browse`);
  console.log(`  api    http://localhost:${port}/api`);
});
