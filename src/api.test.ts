import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from './app.js';
import { FixtureSource } from './sources/index.js';

let server: Server;
let base: string;

before(async () => {
  const source = new FixtureSource();
  await source.load();
  server = createApp(source).listen(0);
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
    assert.equal(body.source, 'fixture');
    assert.ok(body.messages > 0);
  });

  it('404s an unknown endpoint', async () => {
    const res = await fetch(`${base}/v1/nope`);
    assert.equal(res.status, 404);
  });
});
