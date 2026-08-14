import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadManifest, MANIFEST_PATH, pageTargets, parseManifest } from './manifest.js';

const valid = {
  base: 'https://blog.example.com',
  defaults: { selector: '.entry-content li', minLength: 15, maxLength: 400 },
  topics: [
    {
      id: 'birthday-friends',
      label: 'Birthday wishes for friends',
      serves: ['birthday/friends'],
      pages: ['/a/'],
    },
  ],
};

const withTopics = (topics: unknown[]) => ({ ...valid, topics });

describe('manifest validation', () => {
  it('resolves declared paths against the base', () => {
    const m = parseManifest(valid);
    assert.equal(m.topics[0]?.pages[0]?.url, 'https://blog.example.com/a/');
  });

  it('accepts a per-page selector override', () => {
    const m = parseManifest(
      withTopics([{ ...valid.topics[0], pages: [{ url: '/a/', selector: '.msg li' }] }]),
    );
    assert.equal(m.topics[0]?.pages[0]?.selector, '.msg li');
  });

  it('allows a topic with no pages, so coverage can be filled in later', () => {
    const m = parseManifest(withTopics([{ ...valid.topics[0], pages: [] }]));
    assert.equal(m.topics[0]?.pages.length, 0);
  });

  /**
   * Every one of these used to be a silent shortfall: a typo produced a topic
   * that matched nothing, and the only symptom was a category quietly serving
   * the generic pool. Failing at load turns that into a message.
   */
  it('rejects a serves pattern the taxonomy could never match', () => {
    for (const pattern of ['birthday', 'a/b/c', '', 'birthday/']) {
      assert.throws(
        () => parseManifest(withTopics([{ ...valid.topics[0], serves: [pattern] }])),
        /serves/,
        `"${pattern}" should be rejected`,
      );
    }
  });

  it('accepts the three patterns the taxonomy does match', () => {
    for (const pattern of ['birthday/friends', 'birthday/*', '*']) {
      assert.doesNotThrow(() =>
        parseManifest(withTopics([{ ...valid.topics[0], serves: [pattern] }])),
      );
    }
  });

  it('rejects a duplicate topic id', () => {
    assert.throws(
      () => parseManifest(withTopics([valid.topics[0], valid.topics[0]])),
      /duplicates the id/,
    );
  });

  it('refuses a page on another host, so ingest cannot wander off the site', () => {
    assert.throws(
      () => parseManifest(withTopics([{ ...valid.topics[0], pages: ['https://elsewhere.com/a/'] }])),
      /not on blog\.example\.com/,
    );
  });

  it('names the exact path of a bad entry', () => {
    assert.throws(
      () => parseManifest(withTopics([{ ...valid.topics[0], label: '' }])),
      /topics\[0\]\.label/,
    );
  });

  it('rejects a length window that can never keep anything', () => {
    assert.throws(
      () => parseManifest({ ...valid, defaults: { ...valid.defaults, minLength: 400, maxLength: 15 } }),
      /minLength must be less than maxLength/,
    );
  });

  it('rejects an empty topic list', () => {
    assert.throws(() => parseManifest({ ...valid, topics: [] }), /non-empty array/);
  });
});

describe('pageTargets', () => {
  it('fetches a shared page once and feeds it to every topic that names it', () => {
    const m = parseManifest(
      withTopics([
        { id: 'a', label: 'A', serves: ['a/*'], pages: ['/shared/'] },
        { id: 'b', label: 'B', serves: ['b/*'], pages: ['/shared/'] },
      ]),
    );
    const targets = pageTargets(m);
    assert.equal(targets.length, 1);
    assert.deepEqual(targets[0]?.topics, ['a', 'b']);
  });

  it('keeps differing selectors on one URL apart', () => {
    const m = parseManifest(
      withTopics([
        { id: 'a', label: 'A', serves: ['a/*'], pages: [{ url: '/shared/', selector: '.one li' }] },
        { id: 'b', label: 'B', serves: ['b/*'], pages: [{ url: '/shared/', selector: '.two li' }] },
      ]),
    );
    assert.equal(pageTargets(m).length, 2);
  });

  it('falls back to the manifest default selector', () => {
    assert.equal(pageTargets(parseManifest(valid))[0]?.selector, '.entry-content li');
  });
});

describe('the checked-in manifest', () => {
  it('is valid', async () => {
    const m = await loadManifest(MANIFEST_PATH);
    assert.ok(m.topics.length > 0);
  });

  it('has no duplicate serves pattern, which would make coverage ambiguous', async () => {
    const m = await loadManifest(MANIFEST_PATH);
    const seen = new Map<string, string>();
    for (const topic of m.topics) {
      for (const pattern of topic.serves) {
        const owner = seen.get(pattern);
        assert.equal(owner, undefined, `"${pattern}" claimed by both ${owner} and ${topic.id}`);
        seen.set(pattern, topic.id);
      }
    }
  });
});
