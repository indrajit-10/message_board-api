import * as cheerio from 'cheerio';

/**
 * Pulls individual card messages out of a post's HTML.
 *
 * Blog posts do not agree on how to mark up a list of wishes — some use
 * <li>, some numbered <p>, some <blockquote>, some one <p> broken by <br>.
 * Rather than commit to one and break on the rest, every strategy runs and
 * the one yielding the most usable messages wins. `pattern` in the result
 * says which, so a sudden change in the mix is visible instead of silent.
 */

export interface ExtractOptions {
  minLength?: number;
  maxLength?: number;
}

export interface ExtractResult {
  messages: string[];
  pattern: string;
  candidates: number;
  rejected: Record<string, number>;
}

const DEFAULTS = { minLength: 20, maxLength: 400 };

/**
 * Phrases that mark navigation, calls to action and housekeeping rather than
 * something a person would write in a card. These sit in the same <li> and <p>
 * tags as the real messages, so length alone will not separate them.
 */
const BOILERPLATE = [
  'click here',
  'read more',
  'also read',
  'related post',
  'you may also',
  'share this',
  'browse',
  'view all',
  'see all',
  'all rights reserved',
  'copyright',
  'subscribe',
  'leave a comment',
  'post a comment',
  'filed under',
  'tagged with',
  'continue reading',
  'send this card',
  'send an ecard',
  'privacy policy',
  'terms of use',
];

const ENUMERATION = /^\s*(?:\(?\d{1,3}[.):\]]|[-–—•*·▪])\s+/;
const WRAPPING_QUOTES = /^["“”'']+\s*|\s*["“”'']+$/g;

function clean(raw: string): string {
  return raw
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(ENUMERATION, '')
    .replace(WRAPPING_QUOTES, '')
    .trim();
}

/** Returns a reason string when the text is not a card message, else null. */
export function rejectReason(text: string, opts: Required<ExtractOptions>): string | null {
  if (text.length < opts.minLength) return 'too_short';
  if (text.length > opts.maxLength) return 'too_long';

  const lower = text.toLowerCase();
  if (/https?:\/\/|www\.|\.com\b/.test(lower)) return 'contains_link';
  if (BOILERPLATE.some((phrase) => lower.includes(phrase))) return 'boilerplate';

  // "Here are some ideas:" introduces a list, it is not part of one.
  if (text.endsWith(':')) return 'lead_in';
  if (/[|»«›‹]/.test(text)) return 'navigation';

  const letters = text.replace(/[^a-z]/gi, '').length;
  if (letters < text.length * 0.5) return 'mostly_symbols';
  if (text === text.toUpperCase() && letters > 3) return 'all_caps';
  if (text.split(/\s+/).length < 4) return 'too_few_words';

  return null;
}

interface Strategy {
  name: string;
  collect: ($: cheerio.CheerioAPI) => string[];
}

const STRATEGIES: Strategy[] = [
  {
    name: 'list',
    // Skip list items that only wrap a nested list — their text is the children's.
    collect: ($) =>
      $('li')
        .filter((_, el) => $(el).children('ul, ol').length === 0)
        .map((_, el) => $(el).text())
        .get(),
  },
  {
    name: 'blockquote',
    collect: ($) =>
      $('blockquote')
        .map((_, el) => $(el).text())
        .get(),
  },
  {
    name: 'linebreak',
    // One paragraph holding several messages separated by <br>.
    collect: ($) => {
      const out: string[] = [];
      $('p').each((_, el) => {
        const html = $(el).html() ?? '';
        const parts = html.split(/<br\s*\/?>/i);
        if (parts.length < 2) return;
        for (const part of parts) out.push(cheerio.load(`<div>${part}</div>`)('div').text());
      });
      return out;
    },
  },
  {
    name: 'paragraph',
    collect: ($) =>
      $('p')
        .map((_, el) => $(el).text())
        .get(),
  },
];

export function extractMessages(html: string, options: ExtractOptions = {}): ExtractResult {
  const opts = { ...DEFAULTS, ...options };
  const $ = cheerio.load(html);

  // Strip anything that is chrome rather than content before looking at text.
  $('script, style, noscript, iframe, figure, figcaption, .sharedaddy, .related').remove();

  let best: ExtractResult = { messages: [], pattern: 'none', candidates: 0, rejected: {} };

  for (const strategy of STRATEGIES) {
    const rejected: Record<string, number> = {};
    const seen = new Set<string>();
    const messages: string[] = [];
    const raw = strategy.collect($);

    for (const candidate of raw) {
      const text = clean(candidate);
      const reason = rejectReason(text, opts);
      if (reason) {
        rejected[reason] = (rejected[reason] ?? 0) + 1;
        continue;
      }
      const key = text.toLowerCase();
      if (seen.has(key)) {
        rejected.duplicate = (rejected.duplicate ?? 0) + 1;
        continue;
      }
      seen.add(key);
      messages.push(text);
    }

    // Strictly greater keeps the earlier, more specific strategy on a tie.
    if (messages.length > best.messages.length) {
      best = { messages, pattern: strategy.name, candidates: raw.length, rejected };
    }
  }

  return best;
}
