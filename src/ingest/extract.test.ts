import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractMessages } from './extract.js';

const OPTS = { selector: '.entry-content li', minLength: 15, maxLength: 400 };

const page = (body: string) => `<html><body><div class="entry-content">${body}</div></body></html>`;

describe('extraction from the declared selector', () => {
  it('takes what the selector points at and says it did', () => {
    const html = page(`
      <ul>
        <li>Happy birthday to the friend who always makes me laugh out loud.</li>
        <li>Wishing you a day as wonderful and generous as you have always been.</li>
      </ul>`);

    const result = extractMessages(html, OPTS);
    assert.equal(result.via, 'declared');
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.strategies, []);
  });

  it('honours a selector aimed at something other than a list', () => {
    const html = page('<blockquote>Thinking of you today and sending my very best.</blockquote>');
    const result = extractMessages(html, { ...OPTS, selector: '.entry-content blockquote' });
    assert.equal(result.via, 'declared');
    assert.equal(result.messages.length, 1);
  });

  it('strips numbering and wrapping quotes', () => {
    const html = page('<ul><li>1. "Wishing you the happiest of birthdays today."</li></ul>');
    const result = extractMessages(html, OPTS);
    assert.equal(result.messages[0], 'Wishing you the happiest of birthdays today.');
  });

  it('drops boilerplate sitting in the same tags as the messages', () => {
    const html = page(`
      <ul>
        <li>Happy birthday to the friend who always makes me laugh out loud.</li>
        <li>Click here to send this card to someone you love today.</li>
      </ul>`);
    const result = extractMessages(html, OPTS);
    assert.equal(result.messages.length, 1);
    assert.equal(result.rejected.boilerplate, 1);
  });

  it('drops a repeat of the same message', () => {
    const line = 'Wishing you a day as wonderful and generous as you are.';
    const result = extractMessages(page(`<ul><li>${line}</li><li>${line}</li></ul>`), OPTS);
    assert.equal(result.messages.length, 1);
    assert.equal(result.rejected.duplicate, 1);
  });

  it('never reads page furniture, even when the selector would reach it', () => {
    const html = `<html><body>
      <nav><ul><li>Birthday messages for every occasion you can think of</li></ul></nav>
      <div class="entry-content"><ul><li>Happy birthday, and may this year be your best.</li></ul></div>
    </body></html>`;
    const result = extractMessages(html, { ...OPTS, selector: 'li' });
    assert.equal(result.messages.length, 1);
    assert.match(result.messages[0] ?? '', /Happy birthday/);
  });
});

/**
 * The point of the rewrite: when the declared selector stops matching, that is
 * a fact the run has to surface, not absorb. Salvaging is still worth doing —
 * it keeps a store from emptying on a theme change — but it is reported.
 */
describe('when the declared selector finds nothing', () => {
  const html = page(`
    <blockquote>Thinking of you today and sending my warmest possible wishes.</blockquote>
    <blockquote>Hoping your day is every bit as lovely as you deserve it to be.</blockquote>`);

  it('says it fell back rather than reporting a clean run', () => {
    const result = extractMessages(html, { ...OPTS, selector: '.nope li' });
    assert.equal(result.via, 'fallback');
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.strategies, ['blockquote']);
  });

  it('reports "none" when nothing salvages either', () => {
    const result = extractMessages('<html><body><div>hi</div></body></html>', OPTS);
    assert.equal(result.via, 'none');
    assert.equal(result.messages.length, 0);
  });

  it('leaves prose alone when a structured list already matched', () => {
    const both = page(`
      <p>Here are some birthday wishes you can borrow for a card today.</p>
      <blockquote>Thinking of you today and sending my warmest possible wishes.</blockquote>`);
    const result = extractMessages(both, { ...OPTS, selector: '.nope li' });
    assert.deepEqual(result.strategies, ['blockquote']);
    assert.equal(result.messages.length, 1);
  });
});

describe('a selector that is not valid CSS', () => {
  it('fails loudly instead of silently matching nothing', () => {
    assert.throws(
      () => extractMessages(page('<ul><li>anything at all goes here</li></ul>'), {
        ...OPTS,
        selector: '((',
      }),
      /not valid CSS/,
    );
  });
});
