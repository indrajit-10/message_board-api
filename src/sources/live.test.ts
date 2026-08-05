import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { LiveSource } from './live.js';

const SECTION = '/what-to-write-in-a-card';

const page = (title: string, body: string) => `<!doctype html><html><body>
  <nav><ul>
    <li><a href="${SECTION}/birthday/">Birthday</a></li>
    <li><a href="${SECTION}/thank-you/">Thank You</a></li>
    <li><a href="/about/">About</a></li>
  </ul></nav>
  <article><div class="entry-content"><h1>${title}</h1>${body}</div></article>
  <footer><ul><li>Copyright, all rights reserved worldwide</li></ul></footer>
</body></html>`;

const PAGES: Record<string, string> = {
  '': page('What to Write in a Card', `<ul>
      <li><a href="${SECTION}/birthday/">Birthday messages</a></li>
      <li><a href="${SECTION}/thank-you/">Thank you messages</a></li>
    </ul>`),
  '/birthday': page('Birthday Messages', `<ul>
      <li>Wishing you a very happy birthday and a year full of good things.</li>
      <li>Happy birthday! May today be gentle, joyful and entirely about you.</li>
    </ul>
    <ul><li><a href="${SECTION}/birthday/for-mom/">Birthday messages for mom</a></li></ul>`),
  '/birthday/for-mom': page('Birthday Messages for Mom', `<ul>
      <li>Happy birthday, Mom. Thank you for everything you have done for me.</li>
      <li>To the best mother in the world, have the most wonderful day today.</li>
    </ul>`),
  '/thank-you': page('Thank You Messages', `<ul>
      <li>Thank you so much, your kindness made a real difference to me.</li>
      <li>I am truly grateful for your help and for all of your time.</li>
    </ul>`),
};

let server: Server;
let base: string;

before(async () => {
  const app = express();
  for (const [path, html] of Object.entries(PAGES)) {
    app.get(`${SECTION}${path}`, (_q, r) => r.type('html').send(html));
    app.get(`${SECTION}${path}/`, (_q, r) => r.type('html').send(html));
  }
  app.get('/about/', (_q, r) => r.type('html').send(page('About', '<p>Nothing to ingest here at all.</p>')));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe('reading the blog at startup instead of ingesting', () => {
  it('loads messages with no store file and no ingest command', async () => {
    const source = new LiveSource({ base, section: `${SECTION}/`, refreshMs: 0, quiet: true });
    await source.load();
    source.stop();

    assert.equal(source.degraded, false);
    assert.ok(source.topics().length > 0);

    const mom = source.topics().find((t) => t.id === 'birthday-mom');
    assert.ok(mom, 'the nested for-mom page should have been reached');
    assert.equal(mom?.messages.length, 2);
  });

  it('keeps page furniture and index links out of what it serves', async () => {
    const source = new LiveSource({ base, section: `${SECTION}/`, refreshMs: 0, quiet: true });
    await source.load();
    source.stop();

    const all = source
      .topics()
      .flatMap((t) => t.messages.map((m) => (typeof m === 'string' ? m : m.text).toLowerCase()));

    for (const junk of ['copyright', 'about', 'birthday messages', 'thank you messages']) {
      assert.ok(!all.includes(junk), `served page furniture: ${junk}`);
    }
    assert.ok(all.some((m) => m.includes('happy birthday, mom')));
  });

  /**
   * A blog that cannot be reached must not take the API down with it — the CTA
   * still has to answer, even if only with the fixtures.
   */
  it('falls back to fixtures when the blog cannot be reached', async () => {
    const source = new LiveSource({
      base: 'http://127.0.0.1:1',
      section: `${SECTION}/`,
      refreshMs: 0,
      quiet: true,
    });
    await source.load();
    source.stop();

    assert.equal(source.degraded, true);
    assert.ok(source.topics().length > 0, 'should still be able to answer');
    assert.ok(
      source.topics().some((t) => t.serves.includes('*')),
      'and still cover an unknown card',
    );
  });
});
