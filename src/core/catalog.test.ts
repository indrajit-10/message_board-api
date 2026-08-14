import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Catalog, catalogView } from './catalog.js';
import type { MessageSource, Topic } from './types.js';

const topic = (id: string, serves: string[], messages: string[], origin: Topic['origin'] = 'blog'): Topic => ({
  id,
  label: id,
  origin,
  source_url: `https://blog.example.com/${id}/`,
  serves,
  messages,
});

const TOPICS = [
  topic('birthday-friends', ['birthday/friends'], ['Happy birthday, friend.']),
  topic('birthday-general', ['birthday/*'], ['Many happy returns of the day.']),
  topic('everyday', ['*'], ['Thinking of you.', 'Sending my very best.']),
];

describe('Catalog resolution', () => {
  const catalog = new Catalog(TOPICS);

  it('prefers an exact category + subcategory match', () => {
    assert.equal(catalog.resolve('birthday', 'friends')?.topic.id, 'birthday-friends');
    assert.equal(catalog.resolve('birthday', 'friends')?.match, 'exact');
  });

  it('falls back to category-wide for an uncovered subcategory', () => {
    const r = catalog.resolve('birthday', 'colleague');
    assert.equal(r?.topic.id, 'birthday-general');
    assert.equal(r?.match, 'category');
  });

  it('falls back to the global pool for an unknown category', () => {
    const r = catalog.resolve('quinceanera', 'cousin');
    assert.equal(r?.topic.id, 'everyday');
    assert.equal(r?.match, 'generic');
  });

  it('normalises punctuation and case before matching', () => {
    assert.equal(catalog.resolve('BIRTHDAY', 'Friends')?.topic.id, 'birthday-friends');
    assert.equal(catalog.resolve('birthday', 'best-friend')?.match, 'category');
  });

  it('returns null when nothing covers the card, not even generically', () => {
    const noFallback = new Catalog([topic('a', ['a/b'], ['x'])]);
    assert.equal(noFallback.resolve('zzz', undefined), null);
  });
});

describe('Catalog message views', () => {
  const catalog = new Catalog(TOPICS);

  it('gives every message a stable id derived from its text', () => {
    const first = catalog.messagesFor('everyday').map((m) => m.id);
    const again = new Catalog(TOPICS).messagesFor('everyday').map((m) => m.id);
    assert.deepEqual(first, again);
  });

  it('counts every message across every topic', () => {
    assert.equal(catalog.messageCount, 4);
  });

  it('returns an empty pool for an unknown topic rather than throwing', () => {
    assert.deepEqual(catalog.messagesFor('nope'), []);
  });
});

describe('Catalog search', () => {
  const catalog = new Catalog(TOPICS);

  it('matches case-insensitively and says which topic each hit came from', () => {
    const { total, results } = catalog.search('THINKING', 10);
    assert.equal(total, 1);
    assert.equal(results[0]?.topic, 'everyday');
    assert.equal(results[0]?.label, 'everyday');
  });

  it('reports the full total even when the page is capped', () => {
    const { total, results } = catalog.search('n', 1);
    assert.ok(total > 1);
    assert.equal(results.length, 1);
  });
});

/**
 * The old code re-filtered placeholders and re-lowercased every message on
 * each request. Deriving once means a live refresh has to invalidate that, and
 * swapping the topics array is what signals it.
 */
describe('catalogView', () => {
  function sourceOf(topics: Topic[]) {
    let current = topics;
    const source: MessageSource = {
      name: 'test',
      load: async () => {},
      topics: () => current,
      lastUpdated: () => null,
    };
    return { source, swap: (next: Topic[]) => (current = next) };
  }

  it('withholds placeholder topics by default', () => {
    const { source } = sourceOf([topic('p', ['*'], ['ours'], 'placeholder'), TOPICS[0] as Topic]);
    const view = catalogView(source, { allowPlaceholders: false });
    assert.deepEqual(view().topics.map((t) => t.id), ['birthday-friends']);
  });

  it('includes them when explicitly allowed', () => {
    const { source } = sourceOf([topic('p', ['*'], ['ours'], 'placeholder')]);
    const view = catalogView(source, { allowPlaceholders: true });
    assert.equal(view().topics.length, 1);
  });

  it('reuses the derived view while the topics are unchanged', () => {
    const { source } = sourceOf([...TOPICS]);
    const view = catalogView(source, { allowPlaceholders: false });
    assert.equal(view(), view());
  });

  it('rebuilds when the source swaps its topics, as a live refresh does', () => {
    const { source, swap } = sourceOf([...TOPICS]);
    const view = catalogView(source, { allowPlaceholders: false });
    const before = view();

    swap([topic('new', ['*'], ['Fresh from the blog.'])]);
    const after = view();

    assert.notEqual(before, after);
    assert.deepEqual(after.topics.map((t) => t.id), ['new']);
  });
});
