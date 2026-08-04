import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMessages } from './extract.js';
import type { RawPost } from './fetchPosts.js';
import { matchRule, type Rule } from './mapping.js';
import { buildTopics } from './run.js';

/**
 * The blog cannot be reached from CI, so these fixtures stand in for it. They
 * cover the four ways a WordPress post is likely to mark up a list of wishes,
 * plus the chrome that sits in the same tags as the messages.
 */

const AS_LIST = `
  <p>Looking for the right words? Here are our favourites:</p>
  <ol>
    <li>Happy birthday to the friend who always makes me laugh.</li>
    <li>Wishing you a day as wonderful as you are, my dear friend.</li>
    <li>Another year of putting up with me — thank you, and happy birthday!</li>
  </ol>
  <p>Read more birthday ideas on our blog.</p>
`;

const AS_NUMBERED_PARAGRAPHS = `
  <h2>Birthday wishes for friends</h2>
  <p>1. Happy birthday to the friend who always makes me laugh.</p>
  <p>2. Wishing you a day as wonderful as you are, my dear friend.</p>
  <p>3. May this year bring you everything you have been hoping for.</p>
`;

const AS_BLOCKQUOTES = `
  <blockquote><p>Happy birthday to the friend who always makes me laugh.</p></blockquote>
  <blockquote><p>Wishing you a day as wonderful as you are, my dear friend.</p></blockquote>
  <blockquote><p>May this year bring you everything you have been hoping for.</p></blockquote>
`;

const AS_LINEBREAKS = `
  <p>
    Happy birthday to the friend who always makes me laugh.<br />
    Wishing you a day as wonderful as you are, my dear friend.<br />
    May this year bring you everything you have been hoping for.
  </p>
`;

describe('extractMessages', () => {
  it('reads a list', () => {
    const { messages, pattern } = extractMessages(AS_LIST);
    assert.equal(pattern, 'list');
    assert.equal(messages.length, 3);
    assert.equal(messages[0], 'Happy birthday to the friend who always makes me laugh.');
  });

  it('reads numbered paragraphs and strips the numbering', () => {
    const { messages, pattern } = extractMessages(AS_NUMBERED_PARAGRAPHS);
    assert.equal(pattern, 'paragraph');
    assert.equal(messages.length, 3);
    for (const m of messages) assert.ok(!/^\d/.test(m), `numbering left on: ${m}`);
  });

  it('reads blockquotes', () => {
    const { messages } = extractMessages(AS_BLOCKQUOTES);
    assert.equal(messages.length, 3);
  });

  it('reads one paragraph split by <br>', () => {
    const { messages, pattern } = extractMessages(AS_LINEBREAKS);
    assert.equal(pattern, 'linebreak');
    assert.equal(messages.length, 3);
    assert.equal(messages[0], 'Happy birthday to the friend who always makes me laugh.');
  });

  it('drops the lead-in and the call to action around a list', () => {
    const { messages } = extractMessages(AS_LIST);
    const joined = messages.join(' ').toLowerCase();
    assert.ok(!joined.includes('here are our favourites'));
    assert.ok(!joined.includes('read more'));
  });

  it('drops navigation, links, headings and legal chrome', () => {
    const noisy = `
      <ul>
        <li>Wishing you a very happy birthday and a wonderful year ahead.</li>
        <li>Click here to send this card to a friend today</li>
        <li>Visit https://blog.123greetings.com for more ideas and wishes</li>
        <li>HAPPY BIRTHDAY WISHES FOR EVERYONE</li>
        <li>Birthday &raquo; Friends &raquo; Wishes for a dear friend today</li>
        <li>Copyright 123Greetings, all rights reserved worldwide</li>
        <li>Short one</li>
      </ul>`;
    const { messages } = extractMessages(noisy);
    assert.deepEqual(messages, ['Wishing you a very happy birthday and a wonderful year ahead.']);
  });

  it('decodes entities and normalises non-breaking spaces', () => {
    const html = `<ul><li>Here&#8217;s to you &amp; yours &mdash; happy&nbsp;birthday, my friend!</li></ul>`;
    const { messages } = extractMessages(html);
    assert.equal(messages[0], 'Here’s to you & yours — happy birthday, my friend!');
    assert.ok(!messages[0]?.includes('&'.concat('amp;')));
    assert.ok(!messages[0]?.includes(' '));
  });

  it('strips bullets and wrapping quotes', () => {
    const html = `<ul>
      <li>• Wishing you a wonderful birthday and a brilliant year ahead.</li>
      <li>"May your birthday bring you everything you have hoped for."</li>
    </ul>`;
    const { messages } = extractMessages(html);
    assert.equal(messages[0], 'Wishing you a wonderful birthday and a brilliant year ahead.');
    assert.equal(messages[1], 'May your birthday bring you everything you have hoped for.');
  });

  it('removes duplicates within a post', () => {
    const html = `<ul>
      <li>Wishing you a wonderful birthday and a brilliant year ahead.</li>
      <li>Wishing you a wonderful birthday and a brilliant year ahead.</li>
    </ul>`;
    assert.equal(extractMessages(html).messages.length, 1);
  });

  it('ignores script and style content', () => {
    const html = `<script>var x = "Happy birthday to you my dearest friend";</script>${AS_LIST}`;
    const { messages } = extractMessages(html);
    assert.ok(!messages.some((m) => m.includes('var x')));
    assert.equal(messages.length, 3);
  });

  it('picks the richest markup when a post mixes several', () => {
    const mixed = `
      <blockquote><p>One quoted wish that is long enough to survive filtering.</p></blockquote>
      <ul>
        <li>Wishing you a very happy birthday and a wonderful year ahead.</li>
        <li>May your day be filled with laughter and very good company.</li>
        <li>Here is to another year of friendship and terrible jokes.</li>
      </ul>`;
    const { messages, pattern } = extractMessages(mixed);
    assert.equal(pattern, 'list');
    assert.equal(messages.length, 3);
  });

  it('reports nothing rather than guessing on a post with no messages', () => {
    const { messages, pattern } = extractMessages('<p>Short.</p><h2>A heading</h2>');
    assert.equal(messages.length, 0);
    assert.equal(pattern, 'none');
  });
});

const RULES: Rule[] = [
  {
    id: 'birthday-friends',
    label: 'Birthday wishes for friends',
    serves: ['birthday/friends'],
    all: ['birthday'],
    any: ['friend'],
  },
  {
    id: 'birthday-family',
    label: 'Birthday wishes for family',
    serves: ['birthday/mom'],
    all: ['birthday'],
    any: ['mom', 'mother'],
  },
  {
    id: 'birthday-general',
    label: 'Birthday wishes',
    serves: ['birthday/*'],
    all: ['birthday'],
    any: [],
  },
  {
    id: 'thank-you',
    label: 'Thank you messages',
    serves: ['thank_you/*'],
    all: [],
    any: ['thank you'],
  },
];

const post = (slug: string, title = '', categories: string[] = []) => ({ slug, title, categories });

describe('matchRule', () => {
  it('matches a specific rule before the general one', () => {
    assert.equal(matchRule(post('birthday-wishes-for-friends'), RULES)?.id, 'birthday-friends');
    assert.equal(matchRule(post('birthday-wishes-for-mom'), RULES)?.id, 'birthday-family');
  });

  it('falls through to the category-wide rule', () => {
    assert.equal(matchRule(post('50-birthday-wishes'), RULES)?.id, 'birthday-general');
  });

  it('reads the title and blog categories, not just the slug', () => {
    assert.equal(matchRule(post('post-1234', 'Thank You Notes That Work'), RULES)?.id, 'thank-you');
    assert.equal(matchRule(post('post-99', '', ['thank you']), RULES)?.id, 'thank-you');
  });

  it('requires every `all` keyword', () => {
    assert.equal(matchRule(post('wishes-for-friends'), RULES), null);
  });

  it('returns null for a post it cannot place', () => {
    assert.equal(matchRule(post('how-we-redesigned-our-app'), RULES), null);
  });
});

const rawPost = (slug: string, html: string, link: string): RawPost => ({
  slug,
  title: slug.replace(/-/g, ' '),
  link,
  html,
  categories: [],
});

describe('buildTopics', () => {
  it('merges several posts into one topic and keeps each message its own source', () => {
    const { topics } = buildTopics(
      [
        rawPost('birthday-wishes-for-friends', AS_LIST, 'https://blog.example.com/a/'),
        rawPost('more-birthday-wishes-for-friends', AS_NUMBERED_PARAGRAPHS, 'https://blog.example.com/b/'),
      ],
      RULES,
    );

    assert.equal(topics.length, 1);
    const topic = topics[0];
    assert.equal(topic?.id, 'birthday-friends');

    const sources = new Set(
      (topic?.messages ?? []).map((m) => (typeof m === 'string' ? '' : m.source_url)),
    );
    assert.equal(sources.size, 2, 'messages should keep the post they came from');
  });

  it('dedupes identical messages that appear in two posts', () => {
    const { topics } = buildTopics(
      [
        rawPost('birthday-wishes-for-friends', AS_LIST, 'https://blog.example.com/a/'),
        rawPost('best-birthday-wishes-for-friends', AS_LIST, 'https://blog.example.com/b/'),
      ],
      RULES,
    );
    assert.equal(topics[0]?.messages.length, 3, 'the same three wishes twice should collapse');
  });

  it('reports posts it could not place instead of dropping them quietly', () => {
    const { unmapped, topics } = buildTopics(
      [rawPost('our-new-office', AS_LIST, 'https://blog.example.com/c/')],
      RULES,
    );
    assert.equal(topics.length, 0);
    assert.equal(unmapped.length, 1);
    assert.equal(unmapped[0]?.slug, 'our-new-office');
  });

  it('reports posts that yielded no messages', () => {
    const { empty } = buildTopics(
      [rawPost('birthday-wishes-for-friends', '<p>Nope.</p>', 'https://blog.example.com/d/')],
      RULES,
    );
    assert.equal(empty.length, 1);
  });

  it('counts which markup each post used', () => {
    const { patterns } = buildTopics(
      [
        rawPost('birthday-wishes-for-friends', AS_LIST, 'https://blog.example.com/a/'),
        rawPost('birthday-wishes-for-friends-2', AS_LINEBREAKS, 'https://blog.example.com/b/'),
      ],
      RULES,
    );
    assert.equal(patterns.list, 1);
    assert.equal(patterns.linebreak, 1);
  });

  it('orders topics by how many messages they hold', () => {
    const { topics } = buildTopics(
      [
        rawPost('birthday-wishes-for-friends', AS_LIST, 'https://blog.example.com/a/'),
        rawPost('birthday-wishes-for-mom', AS_BLOCKQUOTES, 'https://blog.example.com/b/'),
        rawPost('birthday-wishes-for-mother-again', AS_NUMBERED_PARAGRAPHS, 'https://blog.example.com/c/'),
      ],
      RULES,
    );
    const counts = topics.map((t) => t.messages.length);
    assert.deepEqual([...counts].sort((a, b) => b - a), counts);
  });
});
