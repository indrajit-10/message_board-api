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

const DEFAULTS = { minLength: 15, maxLength: 400 };

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
  if (text.split(/\s+/).length < 3) return 'too_few_words';

  return null;
}

/**
 * A list item that is just a link is a table of contents entry, not something
 * anyone writes in a card. Section index pages are built entirely from these
 * ("Anniversary messages", "Get well soon messages"), and they are long enough
 * to clear the length filter, so they have to be recognised by shape instead.
 */
function isMostlyLink(node: cheerio.Cheerio<never>): boolean {
  const text = node.text().replace(/\s+/g, ' ').trim();
  if (!text) return true;
  const linked = node.find('a').text().replace(/\s+/g, ' ').trim();
  return linked.length >= text.length * 0.8;
}

interface Strategy {
  name: string;
  collect: ($: cheerio.CheerioAPI, region: cheerio.Cheerio<never>) => string[];
}

const STRATEGIES: Strategy[] = [
  {
    name: 'list',
    // Skip list items that only wrap a nested list — their text is the children's.
    collect: ($, region) =>
      region
        .find('li')
        .filter((_, el) => $(el).children('ul, ol').length === 0)
        .filter((_, el) => !isMostlyLink($(el) as unknown as cheerio.Cheerio<never>))
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
    // One paragraph holding several messages separated by <br>.
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
        .filter((_, el) => !isMostlyLink($(el) as unknown as cheerio.Cheerio<never>))
        .map((_, el) => $(el).text())
        .get(),
  },
];

/** Page furniture that holds <li> and <p> but never a card message. */
const CHROME =
  'script, style, noscript, iframe, form, figure, figcaption, ' +
  'nav, header, footer, aside, ' +
  '.nav, .navbar, .menu, .navigation, .sidebar, .widget, .breadcrumb, .breadcrumbs, ' +
  '.comments, #comments, .comment-list, .pagination, .pager, ' +
  '.sharedaddy, .share, .social, .related, .related-posts, .tags, .meta, .site-header, .site-footer';

/**
 * Where the messages live on a page.
 *
 * A crawled page is the whole document — a nav menu alone can contribute
 * thirty <li> items, which would out-vote the real list and win the strategy
 * scoring outright. Narrowing first is what makes crawling a full page as
 * reliable as reading a post body from the API. When nothing matches (an API
 * content fragment has no <article>), <body> is already the content.
 */
const CONTENT_REGIONS = [
  '.entry-content',
  '.post-content',
  '.article-content',
  'article',
  'main',
  '#content',
  '.content',
];

export function contentRegion($: cheerio.CheerioAPI): cheerio.Cheerio<never> {
  $(CHROME).remove();
  for (const selector of CONTENT_REGIONS) {
    const found = $(selector).first();
    if (found.length && found.text().trim().length > 200) {
      return found as unknown as cheerio.Cheerio<never>;
    }
  }
  return $('body') as unknown as cheerio.Cheerio<never>;
}

/**
 * <li>, <blockquote> and <br>-split paragraphs each mark a list of wishes
 * outright. A page can use more than one — a numbered list followed by a few
 * pull-quotes — so all three are kept and merged.
 *
 * Bare <p> is different: on a page with no message list it holds the messages,
 * but on a page that has one it holds the surrounding prose. So it only runs
 * when the structured markup found nothing, rather than adding intro
 * paragraphs to every page that has a list.
 */
const STRUCTURED = new Set(['list', 'blockquote', 'linebreak']);

export function extractMessages(html: string, options: ExtractOptions = {}): ExtractResult {
  const opts = { ...DEFAULTS, ...options };
  const $ = cheerio.load(html);
  const region = contentRegion($);

  const rejected: Record<string, number> = {};
  const seen = new Set<string>();
  const messages: string[] = [];
  const used: string[] = [];
  let candidates = 0;

  const harvest = (strategy: Strategy): number => {
    const raw = strategy.collect($, region);
    candidates += raw.length;
    let kept = 0;

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
      kept++;
    }

    if (kept > 0) used.push(strategy.name);
    return kept;
  };

  for (const strategy of STRATEGIES) {
    if (STRUCTURED.has(strategy.name)) harvest(strategy);
  }

  if (messages.length === 0) {
    for (const strategy of STRATEGIES) {
      if (!STRUCTURED.has(strategy.name)) harvest(strategy);
    }
  }

  return {
    messages,
    pattern: used.length ? used.join('+') : 'none',
    candidates,
    rejected,
  };
}
