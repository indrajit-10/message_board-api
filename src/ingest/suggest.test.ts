import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseManifest } from './manifest.js';
import { suggestPages, urlsFromFile } from './suggest.js';

const BASE = 'https://blog.example.com';

const topics = (list: unknown[]) =>
  parseManifest({
    base: BASE,
    defaults: { selector: '.entry-content li', minLength: 15, maxLength: 400 },
    topics: list,
  }).topics;

describe('reading URLs from a saved file', () => {
  it('pulls page URLs out of a sitemap urlset', () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>${BASE}/birthday-messages/</loc></url>
        <url><loc>${BASE}/thank-you-notes/</loc></url>
      </urlset>`;
    const { pages, childSitemaps } = urlsFromFile(xml);
    assert.deepEqual(pages, [`${BASE}/birthday-messages/`, `${BASE}/thank-you-notes/`]);
    assert.deepEqual(childSitemaps, []);
  });

  /**
   * A sitemap index lists other sitemaps, not pages. Returning those silently
   * as pages would suggest nothing and look like the site had no content.
   */
  it('separates the children of a sitemap index', () => {
    const xml = `<?xml version="1.0"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>${BASE}/post-sitemap.xml</loc></sitemap>
        <sitemap><loc>${BASE}/page-sitemap.xml</loc></sitemap>
      </sitemapindex>`;
    const { pages, childSitemaps } = urlsFromFile(xml);
    assert.deepEqual(pages, []);
    assert.equal(childSitemaps.length, 2);
  });

  it('accepts a plain list, one URL per line', () => {
    const { pages } = urlsFromFile(`${BASE}/a/\n\n# a comment\n${BASE}/b/\n`);
    assert.deepEqual(pages, [`${BASE}/a/`, `${BASE}/b/`]);
  });
});

describe('suggesting pages for a topic', () => {
  const siteUrls = [
    `${BASE}/birthday-messages-for-mom/`,
    `${BASE}/birthday-messages-for-grandmother/`,
    `${BASE}/birthday-messages/`,
    `${BASE}/thank-you-notes/`,
  ];

  it('matches on whole words, so grandmother does not answer for mom', () => {
    const result = suggestPages(
      topics([
        {
          id: 'birthday-mom',
          label: 'Mom',
          serves: ['birthday/mom'],
          pages: [],
          find: { all: ['birthday'], any: ['mom', 'mother'] },
        },
      ]),
      siteUrls,
    );
    assert.deepEqual(result[0]?.paths, ['/birthday-messages-for-mom/']);
  });

  it('requires every "all" keyword', () => {
    const result = suggestPages(
      topics([
        {
          id: 'x',
          label: 'X',
          serves: ['x/*'],
          pages: [],
          find: { all: ['birthday', 'anniversary'], any: [] },
        },
      ]),
      siteUrls,
    );
    assert.equal(result.length, 0);
  });

  it('returns paths, not absolute URLs, since the manifest resolves against base', () => {
    const result = suggestPages(
      topics([
        { id: 't', label: 'T', serves: ['t/*'], pages: [], find: { all: [], any: ['thank'] } },
      ]),
      siteUrls,
    );
    assert.deepEqual(result[0]?.paths, ['/thank-you-notes/']);
  });

  it('skips topics that already have pages, unless asked for all', () => {
    const list = topics([
      {
        id: 'birthday-mom',
        label: 'Mom',
        serves: ['birthday/mom'],
        pages: ['/already/'],
        find: { all: ['birthday'], any: ['mom'] },
      },
    ]);
    assert.equal(suggestPages(list, siteUrls).length, 0);
    assert.equal(suggestPages(list, siteUrls, { includeFilled: true }).length, 1);
  });

  it('skips topics with no find keywords rather than proposing everything', () => {
    const list = topics([{ id: 't', label: 'T', serves: ['t/*'], pages: [] }]);
    assert.equal(suggestPages(list, siteUrls).length, 0);
  });

  it('puts the more specific match first', () => {
    const result = suggestPages(
      topics([
        {
          id: 'birthday-general',
          label: 'General',
          serves: ['birthday/*'],
          pages: [],
          find: { all: ['birthday'], any: [] },
        },
      ]),
      siteUrls,
    );
    assert.equal(result[0]?.paths[0], '/birthday-messages/', 'shortest matching path leads');
  });
});
