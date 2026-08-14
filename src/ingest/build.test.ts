import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type FetchedPage, buildTopics, hasGlobalFallback } from './build.js';
import { parseManifest } from './manifest.js';

const BASE = 'https://blog.example.com';

const page = (body: string) => `<html><body><div class="entry-content">${body}</div></body></html>`;

const list = (...lines: string[]) => page(`<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`);

const ok = (url: string, html: string): FetchedPage => ({ url, ok: true, status: 200, html });

function manifest(topics: unknown[]) {
  return parseManifest({
    base: BASE,
    defaults: { selector: '.entry-content li', minLength: 15, maxLength: 400 },
    topics,
  });
}

const A = 'Happy birthday to the friend who always makes me laugh out loud.';
const B = 'Wishing you a day as wonderful and generous as you have always been.';
const C = 'Thinking of you today and sending my very warmest wishes along.';

describe('building topics from declared pages', () => {
  it('files messages under the topic that declared the page, not one inferred from it', () => {
    // The page's own words are all about birthdays; the manifest says it is
    // the sympathy topic, and the manifest is what decides.
    const m = manifest([
      { id: 'sympathy', label: 'Sympathy', serves: ['sympathy/*'], pages: ['/p/'] },
    ]);
    const built = buildTopics(m, new Map([[`${BASE}/p/`, ok(`${BASE}/p/`, list(A, B))]]));

    assert.equal(built.topics.length, 1);
    assert.equal(built.topics[0]?.id, 'sympathy');
    assert.equal(built.topics[0]?.messages.length, 2);
  });

  it('attributes each message to the page it came from', () => {
    const m = manifest([{ id: 't', label: 'T', serves: ['t/*'], pages: ['/one/', '/two/'] }]);
    const built = buildTopics(
      m,
      new Map([
        [`${BASE}/one/`, ok(`${BASE}/one/`, list(A))],
        [`${BASE}/two/`, ok(`${BASE}/two/`, list(B))],
      ]),
    );

    const urls = built.topics[0]?.messages.map((msg) =>
      typeof msg === 'string' ? null : msg.source_url,
    );
    assert.deepEqual(urls, [`${BASE}/one/`, `${BASE}/two/`]);
  });

  it('dedupes across pages that repeat the same message', () => {
    const m = manifest([{ id: 't', label: 'T', serves: ['t/*'], pages: ['/one/', '/two/'] }]);
    const built = buildTopics(
      m,
      new Map([
        [`${BASE}/one/`, ok(`${BASE}/one/`, list(A, B))],
        [`${BASE}/two/`, ok(`${BASE}/two/`, list(B, C))],
      ]),
    );
    assert.equal(built.topics[0]?.messages.length, 3);
  });

  it('feeds one page to every topic that names it', () => {
    const m = manifest([
      { id: 'a', label: 'A', serves: ['a/*'], pages: ['/shared/'] },
      { id: 'b', label: 'B', serves: ['b/*'], pages: ['/shared/'] },
    ]);
    const built = buildTopics(m, new Map([[`${BASE}/shared/`, ok(`${BASE}/shared/`, list(A, B))]]));
    assert.deepEqual(
      built.topics.map((t) => t.id).sort(),
      ['a', 'b'],
    );
  });

  it('omits a topic whose pages yielded nothing rather than serving it empty', () => {
    const m = manifest([{ id: 't', label: 'T', serves: ['t/*'], pages: ['/p/'] }]);
    const built = buildTopics(m, new Map([[`${BASE}/p/`, ok(`${BASE}/p/`, page('<div>hi</div>'))]]));
    assert.equal(built.topics.length, 0);
  });
});

/**
 * Every way a page can fail has to end up named in the outcomes, because a
 * page that quietly contributes nothing is exactly how the old pipeline lost
 * messages without anyone noticing.
 */
describe('reporting what went wrong', () => {
  it('marks a page that could not be fetched, and keeps the rest', () => {
    const m = manifest([{ id: 't', label: 'T', serves: ['t/*'], pages: ['/gone/', '/here/'] }]);
    const built = buildTopics(
      m,
      new Map([
        [`${BASE}/gone/`, { url: `${BASE}/gone/`, ok: false, status: 404, html: '' }],
        [`${BASE}/here/`, ok(`${BASE}/here/`, list(A))],
      ]),
    );

    const gone = built.outcomes.find((o) => o.url.endsWith('/gone/'));
    assert.equal(gone?.status, 'unreachable');
    assert.equal(gone?.httpStatus, 404);
    assert.equal(built.kept, 1, 'the reachable page still contributes');
  });

  it('marks a page whose declared selector stopped matching', () => {
    const m = manifest([
      {
        id: 't',
        label: 'T',
        serves: ['t/*'],
        pages: [{ url: '/p/', selector: '.moved li' }],
      },
    ]);
    const built = buildTopics(
      m,
      new Map([[`${BASE}/p/`, ok(`${BASE}/p/`, `${page(`<blockquote>${A}</blockquote>`)}`)]]),
    );

    const outcome = built.outcomes[0];
    assert.equal(outcome?.status, 'fallback');
    assert.deepEqual(outcome?.strategies, ['blockquote']);
    assert.equal(built.kept, 1, 'salvaged, but reported');
  });

  it('marks a page that yielded nothing at all', () => {
    const m = manifest([{ id: 't', label: 'T', serves: ['t/*'], pages: ['/p/'] }]);
    const built = buildTopics(m, new Map([[`${BASE}/p/`, ok(`${BASE}/p/`, page('<div>hi</div>'))]]));
    assert.equal(built.outcomes[0]?.status, 'empty');
  });

  it('lists topics with no pages declared, so unfilled coverage is visible', () => {
    const m = manifest([
      { id: 'filled', label: 'F', serves: ['f/*'], pages: ['/p/'] },
      { id: 'blank', label: 'B', serves: ['b/*'], pages: [] },
    ]);
    const built = buildTopics(m, new Map([[`${BASE}/p/`, ok(`${BASE}/p/`, list(A))]]));
    assert.deepEqual(built.topicsWithoutPages, ['blank']);
  });

  it('counts a page missing from the fetch map as unreachable', () => {
    const m = manifest([{ id: 't', label: 'T', serves: ['t/*'], pages: ['/p/'] }]);
    const built = buildTopics(m, new Map());
    assert.equal(built.outcomes[0]?.status, 'unreachable');
  });
});

describe('hasGlobalFallback', () => {
  it('is false when nothing serves "*"', () => {
    assert.equal(hasGlobalFallback([{ id: 'a', label: 'A', source_url: '', serves: ['a/*'], messages: [] }]), false);
  });

  it('is true when something does', () => {
    assert.equal(hasGlobalFallback([{ id: 'a', label: 'A', source_url: '', serves: ['*'], messages: [] }]), true);
  });
});
