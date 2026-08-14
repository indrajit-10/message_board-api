import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from './createApp.js';
import { FixtureSource, StoreSource } from '../sources/index.js';
import type { MessageSource } from '../core/types.js';

let server: Server;
let base: string;

/**
 * The fixture text, presented as though it had come from the blog.
 *
 * The suites below are about selection, the fallback chain and exclude — not
 * about where the words came from. Stamping the origin lets them run through
 * the same strict path production uses, instead of being waved through by a
 * flag that production must never set.
 */
function asIngested(fixtures: FixtureSource): MessageSource {
  return {
    name: 'store',
    load: async () => {},
    topics: () => fixtures.topics().map((t) => ({ ...t, origin: 'blog' as const })),
    lastUpdated: () => fixtures.lastUpdated(),
  };
}

before(async () => {
  const fixtures = new FixtureSource();
  await fixtures.load();
  server = createApp(asIngested(fixtures)).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

interface MessagesBody {
  category: string;
  subcategory: string | null;
  resolved: { topic: string; label: string; match: string; source_url: string };
  count: number;
  messages: Array<{ id: string; text: string; source_url: string }>;
  has_more: boolean;
  wrapped: boolean;
}

async function getMessages(query: string): Promise<{ status: number; body: MessagesBody }> {
  const res = await fetch(`${base}/v1/messages?${query}`);
  return { status: res.status, body: (await res.json()) as MessagesBody };
}

describe('GET /v1/messages', () => {
  it('returns 5 messages by default', async () => {
    const { status, body } = await getMessages('category=birthday&subcategory=friends');
    assert.equal(status, 200);
    assert.equal(body.count, 5);
    assert.equal(body.messages.length, 5);
  });

  it('matches category + subcategory exactly when covered', async () => {
    const { body } = await getMessages('category=birthday&subcategory=friends');
    assert.equal(body.resolved.match, 'exact');
    assert.equal(body.resolved.topic, 'birthday-friends');
  });

  it('falls back to category-wide messages for an uncovered subcategory', async () => {
    const { body } = await getMessages('category=birthday&subcategory=colleague');
    assert.equal(body.resolved.match, 'category');
    assert.equal(body.resolved.topic, 'birthday-general');
  });

  it('falls back to generic messages rather than failing on an unknown category', async () => {
    const { status, body } = await getMessages('category=quinceanera&subcategory=cousin');
    assert.equal(status, 200);
    assert.equal(body.resolved.match, 'generic');
    assert.equal(body.count, 5);
  });

  it('normalises slug punctuation and case', async () => {
    const hyphen = await getMessages('category=Thank-You');
    const underscore = await getMessages('category=thank_you');
    assert.equal(hyphen.body.resolved.topic, 'thank-you');
    assert.equal(underscore.body.resolved.topic, 'thank-you');
  });

  it('gives every message a plain-text body and a source url', async () => {
    const { body } = await getMessages('category=birthday&subcategory=friends');
    for (const message of body.messages) {
      assert.ok(message.text.length > 0);
      assert.ok(!/<[a-z/]/i.test(message.text), `message contains markup: ${message.text}`);
      assert.match(message.source_url, /^https:\/\//);
    }
  });

  it('keeps message ids stable across calls so exclude works', async () => {
    const first = await getMessages('category=love&limit=25');
    const second = await getMessages('category=love&limit=25');
    const idsOf = (b: MessagesBody) => b.messages.map((m) => m.id).sort();
    assert.deepEqual(idsOf(first.body), idsOf(second.body));
  });

  it('never repeats excluded messages on a second press', async () => {
    const first = await getMessages('category=birthday&subcategory=friends');
    const seen = first.body.messages.map((m) => m.id);
    const second = await getMessages(
      `category=birthday&subcategory=friends&exclude=${seen.join(',')}`,
    );
    for (const message of second.body.messages) {
      assert.ok(!seen.includes(message.id), `repeated ${message.id}`);
    }
  });

  it('wraps instead of returning nothing once the pool is exhausted', async () => {
    const all = await getMessages('category=birthday&subcategory=friends&limit=25');
    const every = all.body.messages.map((m) => m.id);
    const { body } = await getMessages(
      `category=birthday&subcategory=friends&exclude=${every.join(',')}`,
    );
    assert.equal(body.wrapped, true);
    assert.ok(body.count > 0);
  });

  it('reports has_more while unseen messages remain', async () => {
    const { body } = await getMessages('category=birthday&subcategory=friends&limit=1');
    assert.equal(body.has_more, true);
  });

  it('rejects a missing category', async () => {
    const res = await fetch(`${base}/v1/messages`);
    assert.equal(res.status, 400);
  });

  it('rejects an out-of-range limit', async () => {
    for (const limit of ['0', '26', 'abc', '2.5']) {
      const res = await fetch(`${base}/v1/messages?category=birthday&limit=${limit}`);
      assert.equal(res.status, 400, `limit=${limit} should be rejected`);
    }
  });

  it('is not cached, so repeat presses can differ', async () => {
    const res = await fetch(`${base}/v1/messages?category=birthday`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

describe('supporting endpoints', () => {
  it('lists coverage', async () => {
    const res = await fetch(`${base}/v1/categories`);
    const body = (await res.json()) as {
      count: number;
      topics: Array<{ id: string; serves: string[]; message_count: number }>;
    };
    assert.equal(res.status, 200);
    assert.ok(body.count > 0);
    assert.ok(body.topics.every((t) => t.message_count > 0));
    assert.ok(body.topics.some((t) => t.serves.includes('*')), 'needs a generic fallback topic');
  });

  it('reports health', async () => {
    const res = await fetch(`${base}/v1/health`);
    const body = (await res.json()) as { status: string; source: string; messages: number };
    assert.equal(body.status, 'ok');
    assert.equal(body.source, 'store');
    assert.ok(body.messages > 0);
  });

  it('404s an unknown endpoint', async () => {
    const res = await fetch(`${base}/v1/nope`);
    assert.equal(res.status, 404);
  });

  it('serves the CTA demo page at the root', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /Get Messages/);
  });

  it('serves the API explorer at /api', async () => {
    const res = await fetch(`${base}/api`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /API explorer/);
  });

  it('serves the browser at /browse', async () => {
    const res = await fetch(`${base}/browse`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Browse messages/);
  });
});

describe('inspecting what is loaded', () => {
  it('returns a whole topic, not a sample of it', async () => {
    const listed = (await (await fetch(`${base}/v1/categories`)).json()) as {
      topics: Array<{ id: string; message_count: number }>;
    };
    const first = listed.topics[0]!;

    const res = await fetch(`${base}/v1/topics/${first.id}`);
    const body = (await res.json()) as { count: number; messages: Array<{ id: string }> };
    assert.equal(res.status, 200);
    assert.equal(body.count, first.message_count, 'should return every message, not five');
    assert.equal(body.messages.length, first.message_count);
  });

  it('404s an unknown topic', async () => {
    const res = await fetch(`${base}/v1/topics/not-a-topic`);
    assert.equal(res.status, 404);
  });

  it('searches across every topic', async () => {
    const res = await fetch(`${base}/v1/search?q=birthday`);
    const body = (await res.json()) as {
      total: number;
      results: Array<{ text: string; topic: string }>;
    };
    assert.equal(res.status, 200);
    assert.ok(body.total > 0);
    for (const r of body.results) {
      assert.match(r.text.toLowerCase(), /birthday/);
      assert.ok(r.topic, 'each hit should say which topic it came from');
    }
  });

  it('searches case-insensitively', async () => {
    const lower = (await (await fetch(`${base}/v1/search?q=happy`)).json()) as { total: number };
    const upper = (await (await fetch(`${base}/v1/search?q=HAPPY`)).json()) as { total: number };
    assert.equal(lower.total, upper.total);
  });

  it('reports when results were truncated', async () => {
    const res = await fetch(`${base}/v1/search?q=you&limit=2`);
    const body = (await res.json()) as { total: number; count: number; truncated: boolean };
    assert.equal(body.count, 2);
    assert.equal(body.truncated, body.total > 2);
  });

  it('rejects an empty search', async () => {
    assert.equal((await fetch(`${base}/v1/search`)).status, 400);
    assert.equal((await fetch(`${base}/v1/search?q=%20`)).status, 400);
  });
});

/**
 * Ingested messages have to travel the same path fixtures do. This builds a
 * store file by hand — the shape `npm run ingest` writes — and serves it, so a
 * change to the contract cannot quietly break real messages while fixtures
 * keep passing.
 */
describe('serving an ingested store', () => {
  let storeServer: Server;
  let storeBase: string;

  before(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mba-store-'));
    const path = join(dir, 'topics.json');
    await writeFile(
      path,
      JSON.stringify({
        generated_at: '2026-08-04T09:00:00Z',
        source: 'https://blog.example.com',
        manifest: 'manifest.json',
        topics: [
          {
            id: 'birthday-friends',
            label: 'Birthday wishes for friends',
            source_url: 'https://blog.example.com/a/',
            serves: ['birthday/friends'],
            messages: [
              { text: 'Happy birthday to the friend who always makes me laugh.', source_url: 'https://blog.example.com/a/' },
              { text: 'Wishing you a day as wonderful as you are.', source_url: 'https://blog.example.com/b/' },
            ],
          },
          {
            id: 'everyday',
            label: 'Messages for any card',
            source_url: 'https://blog.example.com/c/',
            serves: ['*'],
            messages: ['Thinking of you today and sending my very best wishes.'],
          },
        ],
      }),
    );

    const source = new StoreSource(path);
    await source.load();
    storeServer = createApp(source).listen(0);
    await new Promise((resolve) => storeServer.once('listening', resolve));
    storeBase = `http://127.0.0.1:${(storeServer.address() as AddressInfo).port}`;
  });

  after(() => storeServer.close());

  it('serves ingested messages', async () => {
    const res = await fetch(`${storeBase}/v1/messages?category=birthday&subcategory=friends`);
    const body = (await res.json()) as MessagesBody;
    assert.equal(body.resolved.match, 'exact');
    assert.equal(body.count, 2);
  });

  it('attributes each message to the post it came from', async () => {
    const res = await fetch(
      `${storeBase}/v1/messages?category=birthday&subcategory=friends&limit=25`,
    );
    const body = (await res.json()) as MessagesBody;
    const urls = new Set(body.messages.map((m) => m.source_url));
    assert.equal(urls.size, 2, 'per-message source_url should survive to the client');
  });

  it('still falls back for an uncovered card', async () => {
    const res = await fetch(`${storeBase}/v1/messages?category=quinceanera`);
    const body = (await res.json()) as MessagesBody;
    assert.equal(res.status, 200);
    assert.equal(body.resolved.match, 'generic');
  });

  it('reports the ingest timestamp in health', async () => {
    const res = await fetch(`${storeBase}/v1/health`);
    const body = (await res.json()) as { source: string; last_updated: string };
    assert.equal(body.source, 'store');
    assert.equal(body.last_updated, '2026-08-04T09:00:00Z');
  });

  it('refuses an empty store rather than serving nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mba-empty-'));
    const path = join(dir, 'topics.json');
    await writeFile(path, JSON.stringify({ generated_at: 'x', topics: [] }));
    await assert.rejects(() => new StoreSource(path).load(), /no topics/);
  });
});

/**
 * The feature exists because the wording is human-written. Text we wrote must
 * never reach a user, so these lock the door: fixtures are loaded, and every
 * read path must still refuse to hand them out.
 */
describe('refusing to serve anything we wrote ourselves', () => {
  let strict: Server;
  let strictBase: string;

  before(async () => {
    const source = new FixtureSource();
    await source.load();
    strict = createApp(source).listen(0);
    await new Promise((resolve) => strict.once('listening', resolve));
    strictBase = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
  });

  after(() => strict.close());

  it('serves no messages at all when only placeholders are loaded', async () => {
    const res = await fetch(`${strictBase}/v1/messages?category=birthday&subcategory=friends`);
    const body = (await res.json()) as MessagesBody & { unavailable_reason?: string };
    assert.equal(res.status, 200, 'the app needs a clean answer, not an error');
    assert.equal(body.count, 0);
    assert.deepEqual(body.messages, []);
    assert.equal(body.unavailable_reason, 'no_blog_messages_loaded');
  });

  it('offers no categories built from placeholders', async () => {
    const body = (await (await fetch(`${strictBase}/v1/categories`)).json()) as { count: number };
    assert.equal(body.count, 0);
  });

  it('finds nothing when searching placeholders', async () => {
    const body = (await (await fetch(`${strictBase}/v1/search?q=birthday`)).json()) as {
      total: number;
    };
    assert.equal(body.total, 0);
  });

  it('will not open a placeholder topic directly', async () => {
    const res = await fetch(`${strictBase}/v1/topics/birthday-friends`);
    assert.equal(res.status, 404);
  });

  it('reports the withheld count so a leak would be visible', async () => {
    const body = (await (await fetch(`${strictBase}/v1/health`)).json()) as {
      status: string;
      messages: number;
      placeholder_messages: number;
      serving_placeholders: boolean;
    };
    assert.equal(body.status, 'no_blog_messages');
    assert.equal(body.messages, 0, 'nothing servable');
    assert.equal(body.placeholder_messages, 64, 'loaded but withheld');
    assert.equal(body.serving_placeholders, false);
  });
});
