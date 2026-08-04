import { createApp } from './app.js';
import { createSource } from './sources/index.js';

const port = Number(process.env.PORT ?? 3000);

const source = createSource();
await source.load();

createApp(source).listen(port, () => {
  console.log(`message-board-api listening on http://localhost:${port}`);
  console.log(`  source=${source.name} topics=${source.topics().length}`);
  console.log(`  try: curl "http://localhost:${port}/v1/messages?category=birthday&subcategory=friends"`);
});
