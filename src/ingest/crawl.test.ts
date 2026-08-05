import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { crawlSection } from './crawl.js';

const S = '/what-to-write-in-a-card';

const chrome = (body: string) => `<!doctype html><html><body>
  <nav class="navbar"><ul><li><a href="/">Home</a></li><li><a href="/about/">About</a></li></ul></nav>
  <article><div class="entry-content">${body}</div></article>
  <footer class="site-footer"><ul><li>Copyright, all rights reserved worldwide</li></ul></footer>
</body></html>`;

const hub = (title: string, links: string[]) =>
  chrome(`<h1>${title}</h1><ul>${links.map((h) => `<li><a href="${h}">${h}</a></li>`).join('')}</ul>`);

const leaf = (title: string) =>
  chrome(`<h1>${title}</h1><ul>
    <li>Wishing you a very happy day and a wonderful year ahead of you.</li>
    <li>May today be filled with laughter and with very good company.</li>
  </ul>`);

/**
 * Hubs linking to hubs, four levels deep, with no sitemap. The leaves can only
 * be reached by following links down through every intermediate page, which is
 * the shape a "browse by occasion, then by relationship" section actually has.
 */
const PAGES: Record<string, string> = {
  '': hub('Index', [`${S}/birthday/`, `${S}/wedding/`]),
  '/birthday': hub('Birthday', [`${S}/birthday/for-family/`, `${S}/birthday/for-friends/`]),
  '/birthday/for-family': hub('Family', [
    `${S}/birthday/for-family/for-mom/`,
    `${S}/birthday/for-family/for-dad/`,
  ]),
  '/birthday/for-family/for-mom': leaf('Mom'),
  '/birthday/for-family/for-dad': leaf('Dad'),
  '/birthday/for-friends': leaf('Friends'),
  '/wedding': hub('Wedding', [`${S}/wedding/for-bride/`]),
  '/wedding/for-bride': leaf('Bride'),
};

let server: Server;
let base: string;

before(async () => {
  const app = express();
  for (const [path, html] of Object.entries(PAGES)) {
    app.get(`${S}${path}`, (_q, r) => r.type('html').send(html));
    app.get(`${S}${path}/`, (_q, r) => r.type('html').send(html));
  }
  app.get('/', (_q, r) => r.type('html').send(leaf('Outside')));
  app.get('/about/', (_q, r) => r.type('html').send(leaf('Outside')));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

describe('following links down through nested pages', () => {
  it('reaches every page, however deep, with no sitemap to help', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, delayMs: 0 });
    const paths = pages.map((p) => new URL(p.link).pathname);

    assert.equal(pages.length, Object.keys(PAGES).length, `got: ${paths.join(', ')}`);
    assert.ok(paths.includes(`${S}/birthday/for-family/for-mom/`), 'did not reach the deepest leaf');
    assert.ok(paths.includes(`${S}/wedding/for-bride/`));
  });

  it('carries the whole path, so the deepest pages can still be placed', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, delayMs: 0 });
    const mom = pages.find((p) => p.link.endsWith('/for-mom/'));
    assert.deepEqual(mom?.categories, ['birthday', 'for-family', 'for-mom']);
  });

  it('stays inside the section however far it goes', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, delayMs: 0 });
    for (const page of pages) {
      assert.ok(new URL(page.link).pathname.startsWith(`${S}/`), `wandered to ${page.link}`);
    }
  });

  it('stops at the depth limit rather than running forever', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, maxDepth: 1, delayMs: 0 });
    const paths = pages.map((p) => new URL(p.link).pathname);
    assert.ok(paths.includes(`${S}/birthday/`), 'depth 1 should be reached');
    assert.ok(!paths.includes(`${S}/birthday/for-family/for-mom/`), 'depth 3 should not be');
  });

  it('honours the page cap', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, maxPages: 3, delayMs: 0 });
    assert.equal(pages.length, 3);
  });
});
