import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { discoverFromSitemap } from './sitemap.js';

const SECTION = '/what-to-write-in-a-card/';

let server: Server;
let base: string;
let withoutSitemap: Server;
let bareBase: string;

before(async () => {
  const app = express();

  // The nested shape WordPress actually serves: an index pointing at children.
  app.get('/wp-sitemap.xml', (_q, r) =>
    r.type('application/xml').send(`<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${base}/wp-sitemap-posts-post-1.xml</loc></sitemap>
      </sitemapindex>`),
  );

  app.get('/wp-sitemap-posts-post-1.xml', (_q, r) =>
    r.type('application/xml').send(`<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>${base}${SECTION}</loc></url>
        <url><loc>${base}${SECTION}birthday/</loc></url>
        <url><loc>${base}${SECTION}birthday/for-mom</loc></url>
        <url><loc>${base}${SECTION}sympathy/</loc></url>
        <url><loc>${base}/about/</loc></url>
        <url><loc>${base}/everyday-messages/</loc></url>
        <url><loc>https://elsewhere.example.com${SECTION}birthday/</loc></url>
      </urlset>`),
  );

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  withoutSitemap = express()
    .get('/robots.txt', (_q, r) => r.type('text/plain').send('User-agent: *\n'))
    .listen(0);
  await new Promise((resolve) => withoutSitemap.once('listening', resolve));
  bareBase = `http://127.0.0.1:${(withoutSitemap.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  withoutSitemap.close();
});

describe('finding pages the navigation does not link to', () => {
  it('follows a sitemap index through to the urls', async () => {
    const urls = await discoverFromSitemap(base, SECTION);
    assert.ok(urls.length > 0, 'should read through the index to the child sitemap');
    assert.ok(urls.some((u) => u.endsWith(`${SECTION}sympathy/`)));
  });

  it('keeps only what is under the section, on this host', async () => {
    const urls = await discoverFromSitemap(base, SECTION);
    for (const url of urls) {
      assert.ok(url.startsWith(`${base}${SECTION}`), `should not have kept ${url}`);
    }
    assert.ok(!urls.some((u) => u.includes('/about/')));
    assert.ok(!urls.some((u) => u.includes('/everyday-messages/')));
    assert.ok(!urls.some((u) => u.includes('elsewhere.example.com')));
  });

  it('canonicalises so a page is not queued twice', async () => {
    const urls = await discoverFromSitemap(base, SECTION);
    assert.equal(new Set(urls).size, urls.length);
    assert.ok(urls.some((u) => u.endsWith('/birthday/for-mom/')), 'missing slash should be added');
  });

  it('returns nothing when the site has no sitemap, rather than failing', async () => {
    const urls = await discoverFromSitemap(bareBase, SECTION);
    assert.deepEqual(urls, []);
  });
});

/**
 * Yoast splits by post type: posts in post-sitemap.xml, pages in
 * page-sitemap.xml. A section built from pages is listed in neither the posts
 * sitemap nor the posts API, so reading only the first sitemap that returns
 * something loses it entirely.
 */
describe('a sitemap split across post types', () => {
  let split: Server;
  let splitBase: string;

  before(async () => {
    const app = express();
    app.get('/post-sitemap.xml', (_q, r) =>
      r.type('application/xml').send(`<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${splitBase}${SECTION}a-post-that-lives-here/</loc></url>
        </urlset>`),
    );
    app.get('/page-sitemap.xml', (_q, r) =>
      r.type('application/xml').send(`<?xml version="1.0"?>
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>${splitBase}${SECTION}birthday/</loc></url>
          <url><loc>${splitBase}${SECTION}anniversary/</loc></url>
          <url><loc>${splitBase}${SECTION}sympathy/</loc></url>
        </urlset>`),
    );
    split = app.listen(0);
    await new Promise((resolve) => split.once('listening', resolve));
    splitBase = `http://127.0.0.1:${(split.address() as AddressInfo).port}`;
  });

  after(() => split.close());

  it('reads every sitemap, not just the first one that answers', async () => {
    const urls = await discoverFromSitemap(splitBase, SECTION);
    assert.equal(urls.length, 4, `expected posts and pages, got: ${urls.join(', ')}`);
    assert.ok(urls.some((u) => u.endsWith('/a-post-that-lives-here/')), 'lost the posts sitemap');
    assert.ok(urls.some((u) => u.endsWith('/birthday/')), 'lost the pages sitemap');
    assert.ok(urls.some((u) => u.endsWith('/sympathy/')), 'lost the pages sitemap');
  });
});
