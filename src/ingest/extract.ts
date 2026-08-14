import * as cheerio from 'cheerio';

/**
 * Pulls individual card messages out of a page's HTML.
 *
 * The manifest declares the selector that holds the messages, because we own
 * the site and therefore know. The guess-work below only runs when that
 * selector comes back empty, and when it does the result says so — a theme
 * change becomes a named failure on one page instead of a quiet shortfall
 * spread across the whole store.
 */

export interface ExtractOptions {
  selector: string;
  minLength: number;
  maxLength: number;
}

export type ExtractVia = 'declared' | 'fallback' | 'none';

export interface ExtractResult {
  messages: string[];
  via: ExtractVia;
  /** Which fallback strategies contributed, when `via` is "fallback". */
  strategies: string[];
  candidates: number;
  rejected: Record<string, number>;
}

/**
 * Phrases that mark navigation, calls to action and housekeeping rather than
 * something a person would write in a card. These sit in the same tags as the
 * real messages, so length alone will not separate them.
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
export function rejectReason(
  text: string,
  opts: { minLength: number; maxLength: number },
): string | null {
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
  if (text.split(/\s+/).length < 3) return 'too_few_words';

  return null;
}

/**
 * A list item that is just a link is a table of contents entry, not something
 * anyone writes in a card. Index pages are built entirely from these, and they
 * are long enough to clear the length filter, so they have to be recognised by
 * shape instead.
 */
function isMostlyLink($: cheerio.CheerioAPI, el: never): boolean {
  const node = $(el);
  const text = node.text().replace(/\s+/g, ' ').trim();
  if (!text) return true;
  const linked = node.find('a').text().replace(/\s+/g, ' ').trim();
  return linked.length >= text.length * 0.8;
}

/** Page furniture that holds list items and paragraphs but never a card message. */
const CHROME =
  'script, style, noscript, iframe, form, figure, figcaption, ' +
  'nav, header, footer, aside, ' +
  '.nav, .navbar, .menu, .navigation, .sidebar, .widget, .breadcrumb, .breadcrumbs, ' +
  '.comments, #comments, .comment-list, .pagination, .pager, ' +
  '.sharedaddy, .share, .social, .related, .related-posts, .tags, .meta, .site-header, .site-footer';

const CONTENT_REGIONS = [
  '.entry-content',
  '.post-content',
  '.article-content',
  'article',
  'main',
  '#content',
  '.content',
];

function contentRegion($: cheerio.CheerioAPI): cheerio.Cheerio<never> {
  for (const selector of CONTENT_REGIONS) {
    const found = $(selector).first();
    if (found.length && found.text().trim().length > 200) {
      return found as unknown as cheerio.Cheerio<never>;
    }
  }
  return $('body') as unknown as cheerio.Cheerio<never>;
}

interface Strategy {
  name: string;
  collect: ($: cheerio.CheerioAPI, region: cheerio.Cheerio<never>) => string[];
}

/**
 * The old pipeline's guess-work, kept only as a safety net.
 *
 * Reaching these means the declared selector found nothing, which is a
 * manifest to fix rather than a mode to run in — so whatever they salvage is
 * reported as a fallback rather than counted as a normal ingest.
 */
const FALLBACK_STRATEGIES: Strategy[] = [
  {
    name: 'list',
    collect: ($, region) =>
      region
        .find('li')
        .filter((_, el) => $(el).children('ul, ol').length === 0)
        .filter((_, el) => !isMostlyLink($, el as never))
        .map((_, el) => $(el).text())
        .get(),
  },
  {
    name: 'blockquote',
    collect: ($, region) =>
      region
        .find('blockquote')
        .map((_, el) => $(el).text())
        .get(),
  },
  {
    name: 'linebreak',
    collect: ($, region) => {
      const out: string[] = [];
      region.find('p').each((_, el) => {
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
    collect: ($, region) =>
      region
        .find('p')
        .filter((_, el) => !isMostlyLink($, el as never))
        .map((_, el) => $(el).text())
        .get(),
  },
];

/** Bare <p> holds prose on a page that has a message list, so it goes last. */
const STRUCTURED = new Set(['list', 'blockquote', 'linebreak']);

class Sieve {
  readonly messages: string[] = [];
  readonly rejected: Record<string, number> = {};
  candidates = 0;

  readonly #seen = new Set<string>();

  constructor(private readonly opts: { minLength: number; maxLength: number }) {}

  /** Returns how many of these candidates survived. */
  take(raw: string[]): number {
    this.candidates += raw.length;
    let kept = 0;

    for (const candidate of raw) {
      const text = clean(candidate);
      const reason = rejectReason(text, this.opts);
      if (reason) {
        this.rejected[reason] = (this.rejected[reason] ?? 0) + 1;
        continue;
      }
      const key = text.toLowerCase();
      if (this.#seen.has(key)) {
        this.rejected.duplicate = (this.rejected.duplicate ?? 0) + 1;
        continue;
      }
      this.#seen.add(key);
      this.messages.push(text);
      kept++;
    }
    return kept;
  }
}

export function extractMessages(html: string, options: ExtractOptions): ExtractResult {
  const $ = cheerio.load(html);
  $(CHROME).remove();

  const sieve = new Sieve(options);

  // What the manifest says holds the messages.
  let declared: string[] = [];
  try {
    declared = $(options.selector)
      .map((_, el) => $(el).text())
      .get();
  } catch (err) {
    throw new Error(
      `Selector "${options.selector}" is not valid CSS: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (sieve.take(declared) > 0) {
    return {
      messages: sieve.messages,
      via: 'declared',
      strategies: [],
      candidates: sieve.candidates,
      rejected: sieve.rejected,
    };
  }

  // Declared selector came up empty. Salvage what we can, and say so.
  const region = contentRegion($);
  const used: string[] = [];

  for (const strategy of FALLBACK_STRATEGIES) {
    if (!STRUCTURED.has(strategy.name)) continue;
    if (sieve.take(strategy.collect($, region)) > 0) used.push(strategy.name);
  }
  if (sieve.messages.length === 0) {
    for (const strategy of FALLBACK_STRATEGIES) {
      if (STRUCTURED.has(strategy.name)) continue;
      if (sieve.take(strategy.collect($, region)) > 0) used.push(strategy.name);
    }
  }

  return {
    messages: sieve.messages,
    via: sieve.messages.length > 0 ? 'fallback' : 'none',
    strategies: used,
    candidates: sieve.candidates,
    rejected: sieve.rejected,
  };
}
