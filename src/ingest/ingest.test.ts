import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { isUnderSection, normaliseUrl, sectionSegments } from './crawl.js';
import { extractMessages } from './extract.js';
import { isMain } from './isMain.js';
import type { RawPost } from './fetchPosts.js';
import { loadRules, matchRule, mentions, type Rule } from './mapping.js';
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

  it('keeps every list on a page that mixes markup', () => {
    const mixed = `
      <blockquote><p>One quoted wish that is long enough to survive filtering.</p></blockquote>
      <ul>
        <li>Wishing you a very happy birthday and a wonderful year ahead.</li>
        <li>May your day be filled with laughter and very good company.</li>
        <li>Here is to another year of friendship and terrible jokes.</li>
      </ul>`;
    const { messages, pattern } = extractMessages(mixed);
    assert.equal(messages.length, 4, 'the quote is a message too, not a losing candidate');
    assert.equal(pattern, 'list+blockquote');
  });

  /**
   * Prose is the exception. On a page with no message list the wishes are in
   * <p>, but on a page that has one the <p> holds the introduction — so bare
   * paragraphs are a fallback, never merged in alongside a list.
   */
  it('does not mix intro prose in with a list', () => {
    const withProse = `
      <p>Birthdays are a wonderful chance to tell someone how much they mean.</p>
      <ul>
        <li>Wishing you a very happy birthday and a wonderful year ahead.</li>
        <li>May your day be filled with laughter and very good company.</li>
      </ul>`;
    const { messages, pattern } = extractMessages(withProse);
    assert.equal(pattern, 'list');
    assert.equal(messages.length, 2);
    assert.ok(!messages.some((m) => m.startsWith('Birthdays are')));
  });

  it('reports why candidates were dropped', () => {
    const html = `<ul>
      <li>Wishing you a very happy birthday and a wonderful year ahead.</li>
      <li>Copyright 123Greetings, all rights reserved worldwide</li>
      <li>Tiny</li>
    </ul>`;
    const { rejected } = extractMessages(html);
    assert.equal(rejected.boilerplate, 1);
    assert.equal(rejected.too_short, 1);
  });

  it('reports nothing rather than guessing on a post with no messages', () => {
    const { messages, pattern } = extractMessages('<p>Short.</p><h2>A heading</h2>');
    assert.equal(messages.length, 0);
    assert.equal(pattern, 'none');
  });
});

/**
 * A crawled page is the whole document, not a post body. The nav alone holds
 * more <li> than the message list does, so without narrowing to the content
 * region the menu would win the strategy scoring and become "the messages".
 */
const FULL_PAGE = `
<html><body>
  <header class="site-header"><h1>123Greetings Blog</h1></header>
  <nav class="navbar"><ul>
    <li><a href="/what-to-write-in-a-card/birthday/">Birthday</a></li>
    <li><a href="/what-to-write-in-a-card/anniversary/">Anniversary</a></li>
    <li><a href="/what-to-write-in-a-card/wedding/">Wedding</a></li>
    <li><a href="/what-to-write-in-a-card/thank-you/">Thank You</a></li>
    <li><a href="/what-to-write-in-a-card/get-well/">Get Well Soon</a></li>
    <li><a href="/what-to-write-in-a-card/sympathy/">Sympathy</a></li>
    <li><a href="/what-to-write-in-a-card/love/">Love and Romance</a></li>
    <li><a href="/what-to-write-in-a-card/congratulations/">Congratulations</a></li>
  </ul></nav>
  <div class="breadcrumbs"><a href="/">Home</a> » <a href="/what-to-write-in-a-card/">Cards</a></div>
  <article><div class="entry-content">
    <h2>Birthday Messages for Mom</h2>
    <p>Not sure what to write? Try one of these:</p>
    <ul>
      <li>Happy birthday, Mom. Thank you for everything you have done for me.</li>
      <li>To the best mother in the world, have the most wonderful day today.</li>
      <li>Mom, you deserve every good thing this year has coming. Happy birthday.</li>
    </ul>
  </div></article>
  <aside class="sidebar"><ul>
    <li><a href="/what-to-write-in-a-card/birthday/">Popular: birthday messages for everyone</a></li>
    <li><a href="/what-to-write-in-a-card/love/">Popular: romantic messages for partners</a></li>
  </ul></aside>
  <footer class="site-footer"><ul>
    <li>Copyright 123Greetings, all rights reserved worldwide</li>
    <li>Privacy policy and terms of use for this website</li>
  </ul></footer>
</body></html>`;

describe('reading a crawled page', () => {
  it('takes the article and ignores nav, sidebar and footer', () => {
    const { messages, pattern } = extractMessages(FULL_PAGE);
    assert.equal(pattern, 'list');
    assert.equal(messages.length, 3, `got: ${JSON.stringify(messages)}`);
    for (const m of messages) assert.match(m, /mom|mother/i);
  });

  it('keeps navigation labels out of the messages', () => {
    const { messages } = extractMessages(FULL_PAGE);
    const joined = messages.join(' ').toLowerCase();
    for (const label of ['anniversary', 'sympathy', 'congratulations', 'popular', 'copyright']) {
      assert.ok(!joined.includes(label), `chrome leaked into messages: ${label}`);
    }
  });

  it('still reads an API content fragment that has no article wrapper', () => {
    const { messages } = extractMessages(AS_LIST);
    assert.equal(messages.length, 3);
  });

  it('takes nothing from a section index, which is only links', () => {
    const index = `
      <article><div class="entry-content">
        <h1>What to Write in a Card</h1>
        <p>Browse by occasion:</p>
        <ul>
          <li><a href="/what-to-write-in-a-card/anniversary/">Anniversary messages</a></li>
          <li><a href="/what-to-write-in-a-card/get-well/">Get well soon messages</a></li>
          <li><a href="/what-to-write-in-a-card/congratulations/">Congratulations messages</a></li>
        </ul>
      </div></article>`;
    const { messages } = extractMessages(index);
    assert.deepEqual(messages, [], 'link labels are a table of contents, not messages');
  });

  it('keeps a message that merely contains a link', () => {
    const html = `<ul><li>Happy birthday, <a href="/x/">my dearest friend</a>, have a wonderful day today.</li></ul>`;
    const { messages } = extractMessages(html);
    assert.equal(messages.length, 1);
  });
});

describe('crawling a section', () => {
  const BASE = 'https://blog.123greetings.com';
  const SECTION = '/what-to-write-in-a-card/';

  it('follows only what lives under the section', () => {
    const under = (href: string) => isUnderSection(normaliseUrl(href, BASE)!, BASE, SECTION);
    assert.equal(under('/what-to-write-in-a-card/birthday/'), true);
    assert.equal(under('/what-to-write-in-a-card/birthday/for-mom/'), true);
    assert.equal(under('https://blog.123greetings.com/what-to-write-in-a-card/love/'), true);

    assert.equal(under('/everyday-messages/'), false, 'outside the section');
    assert.equal(under('/'), false, 'the site root');
    assert.equal(under('https://www.123greetings.com/what-to-write-in-a-card/'), false, 'another host');
  });

  it('skips assets that are not pages', () => {
    for (const href of ['/what-to-write-in-a-card/cover.jpg', '/what-to-write-in-a-card/feed.xml']) {
      assert.equal(isUnderSection(normaliseUrl(href, BASE)!, BASE, SECTION), false, href);
    }
  });

  it('collapses the variants of one URL so a page is fetched once', () => {
    const forms = [
      '/what-to-write-in-a-card/birthday',
      '/what-to-write-in-a-card/birthday/',
      '/what-to-write-in-a-card/birthday/#wishes',
      '/what-to-write-in-a-card/birthday/?utm_source=x',
    ];
    const canonical = new Set(forms.map((f) => normaliseUrl(f, BASE)));
    assert.equal(canonical.size, 1, [...canonical].join(' | '));
  });

  it('reads the card subject from the path', () => {
    const segs = (href: string) => sectionSegments(normaliseUrl(href, BASE)!, BASE, SECTION);
    assert.deepEqual(segs('/what-to-write-in-a-card/birthday/'), ['birthday']);
    assert.deepEqual(segs('/what-to-write-in-a-card/birthday/for-mom/'), ['birthday', 'for-mom']);
    assert.deepEqual(segs('/what-to-write-in-a-card/'), []);
  });

  it('ignores links it cannot parse', () => {
    for (const href of ['javascript:void(0)', 'mailto:hi@example.com', '']) {
      assert.equal(normaliseUrl(href, BASE), null, href);
    }
  });
});

describe('isMain', () => {
  it('recognises the file node was told to run', () => {
    const path = '/srv/app/src/ingest/run.ts';
    assert.equal(isMain(pathToFileURL(path).href, path), true);
  });

  it('does not fire for a module that was merely imported', () => {
    assert.equal(isMain(pathToFileURL('/srv/app/src/ingest/probe.ts').href, '/srv/app/cli.js'), false);
  });

  it('handles paths that need URL encoding', () => {
    // The CLIs printed nothing on Windows because "file://" + argv[1] built
    // "file://D:\a\run.ts" rather than "file:///D:/a/run.ts". A path with a
    // space reproduces the same mismatch on any platform.
    const path = '/srv/my app/src/ingest/run.ts';
    const href = pathToFileURL(path).href;
    assert.equal(isMain(href, path), true);
    assert.notEqual(href, `file://${path}`, 'concatenation must not be treated as equivalent');
  });

  it('is false when node was given no script', () => {
    assert.equal(isMain('file:///srv/app/run.js', undefined), false);
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

/**
 * The blog groups posts into sections named "<topic>-messages" — e.g.
 * /birthday-messages/, /everyday-messages/. These check the shipped rules
 * against that naming, since a section nothing claims is a section whose
 * messages never reach the API.
 */
describe('the shipped rules', () => {
  it('places the blog’s own section slugs', async () => {
    const rules = await loadRules();
    const place = (slug: string) => matchRule(post(slug), rules)?.id;

    assert.equal(place('birthday-messages'), 'birthday-general');
    assert.equal(place('everyday-messages'), 'everyday');
    assert.equal(place('anniversary-messages'), 'anniversary');
    assert.equal(place('thank-you-messages'), 'thank-you');
    assert.equal(place('get-well-messages'), 'get-well');
    assert.equal(place('love-messages'), 'love');
    assert.equal(place('sympathy-messages'), 'sympathy');
    assert.equal(place('congratulations-messages'), 'congratulations');
  });

  it('still prefers the specific rule inside a section', async () => {
    const rules = await loadRules();
    assert.equal(matchRule(post('birthday-messages-for-mom'), rules)?.id, 'birthday-mom');
    assert.equal(matchRule(post('birthday-messages-for-best-friend'), rules)?.id, 'birthday-friends');
  });

  /**
   * Every relation needs its own rule. Lumping them means a card for Mom can
   * be answered with "Happy birthday, Dad" — worse than a generic wish,
   * because it reads as addressed to the wrong person.
   */
  it('keeps each family relation apart', async () => {
    const rules = await loadRules();
    const place = (slug: string) => matchRule(post(slug), rules)?.id;

    assert.equal(place('birthday-messages-for-mom'), 'birthday-mom');
    assert.equal(place('birthday-messages-for-dad'), 'birthday-dad');
    assert.equal(place('birthday-messages-for-sister'), 'birthday-sister');
    assert.equal(place('birthday-messages-for-brother'), 'birthday-brother');
    assert.equal(place('birthday-messages-for-son'), 'birthday-son');
    assert.equal(place('birthday-messages-for-daughter'), 'birthday-daughter');
    assert.equal(place('birthday-messages-for-wife'), 'birthday-wife');
    assert.equal(place('birthday-messages-for-husband'), 'birthday-husband');
  });

  it('does not read a grandparent as a parent', async () => {
    const rules = await loadRules();
    assert.equal(matchRule(post('birthday-messages-for-grandmother'), rules)?.id, 'birthday-grandmother');
    assert.equal(matchRule(post('birthday-messages-for-grandfather'), rules)?.id, 'birthday-grandfather');
  });

  it('does not read a girlfriend as a friend', async () => {
    const rules = await loadRules();
    assert.equal(matchRule(post('birthday-messages-for-girlfriend'), rules)?.id, 'birthday-girlfriend');
    assert.equal(matchRule(post('birthday-messages-for-boyfriend'), rules)?.id, 'birthday-boyfriend');
  });
});

describe('keyword matching', () => {
  it('matches whole words only', () => {
    assert.equal(mentions('birthday messages for son', 'son'), true);
    for (const text of ['a message for any person', 'wishes for the season', 'for my grandson']) {
      assert.equal(mentions(text, 'son'), false, `"son" should not match in: ${text}`);
    }
    assert.equal(mentions('wishes for grandmother', 'mother'), false);
    assert.equal(mentions('wishes for mother', 'mother'), true);
  });

  it('tolerates a plural, since posts say "for friends"', () => {
    assert.equal(mentions('birthday messages for friends', 'friend'), true);
    assert.equal(mentions('birthday messages for girlfriend', 'friend'), false);
  });

  it('handles keywords with punctuation and spaces', () => {
    assert.equal(mentions('the best mother\'s day wishes', "mother's day"), true);
    assert.equal(mentions('notes to say thank you today', 'thank you'), true);
    assert.equal(mentions('messages for a co-worker', 'co-worker'), true);
  });

  it('has exactly one global fallback, and it is last', async () => {
    const rules = await loadRules();
    const globals = rules.filter((r) => r.serves.includes('*'));
    assert.equal(globals.length, 1, 'more than one rule serving "*" makes resolution order matter');
    assert.equal(rules.at(-1)?.id, globals[0]?.id, 'the "*" rule must not claim posts a specific rule wants');
  });

  it('leaves a post that is not about card messages unplaced', async () => {
    const rules = await loadRules();
    assert.equal(matchRule(post('we-redesigned-our-mobile-app'), rules), null);
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
