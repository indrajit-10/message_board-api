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
  // Scope pinned to the section here: these cover how deep the crawl goes,
  // not how wide, which the hub tests below cover.
  it('reaches every page, however deep, with no sitemap to help', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, scope: `${S}/`, delayMs: 0 });
    const paths = pages.map((p) => new URL(p.link).pathname);

    assert.equal(pages.length, Object.keys(PAGES).length, `got: ${paths.join(', ')}`);
    assert.ok(paths.includes(`${S}/birthday/for-family/for-mom/`), 'did not reach the deepest leaf');
    assert.ok(paths.includes(`${S}/wedding/for-bride/`));
  });

  it('carries the whole path, so the deepest pages can still be placed', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, scope: `${S}/`, delayMs: 0 });
    const mom = pages.find((p) => p.link.endsWith('/for-mom/'));
    assert.deepEqual(mom?.categories, ['birthday', 'for-family', 'for-mom']);
  });

  it('stays inside the section however far it goes', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, scope: `${S}/`, delayMs: 0 });
    for (const page of pages) {
      assert.ok(new URL(page.link).pathname.startsWith(`${S}/`), `wandered to ${page.link}`);
    }
  });

  it('stops at the depth limit rather than running forever', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, scope: `${S}/`, maxDepth: 1, delayMs: 0 });
    const paths = pages.map((p) => new URL(p.link).pathname);
    assert.ok(paths.includes(`${S}/birthday/`), 'depth 1 should be reached');
    assert.ok(!paths.includes(`${S}/birthday/for-family/for-mom/`), 'depth 3 should not be');
  });

  it('honours the page cap', async () => {
    const pages = await crawlSection({ base, section: `${S}/`, scope: `${S}/`, maxPages: 3, delayMs: 0 });
    assert.equal(pages.length, 3);
  });
});

/**
 * The section index is a hub: it links out to message pages that live at the
 * site root, like /messages-for-1st-birthday/. Bounding the crawl to the hub's
 * own path follows none of them, so scope is separate from the starting point.
 */
describe('a hub linking out of its own path', () => {
  let hubServer: Server;
  let hubBase: string;

  const ROOT_PAGES = ['/messages-for-1st-birthday/', '/birthday-messages/', '/everyday-messages/'];

  before(async () => {
    const app = express();
    app.get(`${S}/`, (_q, r) =>
      r.type('html').send(
        chrome(`<h1>Hub</h1><ul>${ROOT_PAGES.map((h) => `<li><a href="${h}">${h}</a></li>`).join('')}</ul>`),
      ),
    );
    for (const path of ROOT_PAGES) app.get(path, (_q, r) => r.type('html').send(leaf(path)));
    app.get('/', (_q, r) => r.type('html').send(chrome('<h1>Home</h1>')));
    hubServer = app.listen(0);
    await new Promise((resolve) => hubServer.once('listening', resolve));
    hubBase = `http://127.0.0.1:${(hubServer.address() as AddressInfo).port}`;
  });

  after(() => hubServer.close());

  it('follows the hub out to pages that are not beneath it', async () => {
    const pages = await crawlSection({ base: hubBase, section: `${S}/`, delayMs: 0 });
    const paths = pages.map((p) => new URL(p.link).pathname);
    for (const expected of ROOT_PAGES) {
      assert.ok(paths.includes(expected), `never reached ${expected}; got ${paths.join(', ')}`);
    }
  });

  it('reads the subject from the full path when the scope is the whole site', async () => {
    const pages = await crawlSection({ base: hubBase, section: `${S}/`, delayMs: 0 });
    const first = pages.find((p) => p.link.endsWith('/messages-for-1st-birthday/'));
    assert.deepEqual(first?.categories, ['messages-for-1st-birthday']);
  });

  it('can still be narrowed back to one path when that is what is wanted', async () => {
    const pages = await crawlSection({
      base: hubBase,
      section: `${S}/`,
      scope: `${S}/`,
      delayMs: 0,
    });
    assert.equal(pages.length, 1, 'an explicit scope should exclude the root pages again');
  });
});
