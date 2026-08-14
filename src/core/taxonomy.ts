import { createHash } from 'node:crypto';
import type { MatchKind, Message, Resolution, Topic } from './types.js';

/**
 * Card categories arrive as URL slugs ("birthday", "thank_you"). Normalise
 * hyphens, spaces and casing so `Thank You`, `thank-you` and `thank_you` all
 * land on the same topic — the CTA passes through whatever the card page has,
 * and that is not consistent across the site.
 */
export function normaliseSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function normalisePattern(pattern: string): string {
  if (pattern === '*') return '*';
  const [cat = '', sub = ''] = pattern.split('/');
  return sub === '*' ? `${normaliseSlug(cat)}/*` : `${normaliseSlug(cat)}/${normaliseSlug(sub)}`;
}

/**
 * The patterns a request could be answered by, most specific first.
 *
 * Exposed so the catalog can index on exactly these keys — resolution is then
 * a map lookup rather than a scan over every topic's `serves`.
 */
export function resolutionOrder(
  category: string,
  subcategory: string | undefined,
): Array<{ pattern: string; match: MatchKind }> {
  const cat = normaliseSlug(category);
  const sub = subcategory ? normaliseSlug(subcategory) : '';

  const attempts: Array<{ pattern: string; match: MatchKind }> = [];
  if (cat && sub) attempts.push({ pattern: `${cat}/${sub}`, match: 'exact' });
  if (cat) attempts.push({ pattern: `${cat}/*`, match: 'category' });
  attempts.push({ pattern: '*', match: 'generic' });
  return attempts;
}

/**
 * Pick the topic that best covers a card's category/subcategory.
 *
 * Tries exact match, then category-wide, then the global pool. Returns null
 * only when nothing covers the card at all — including the global fallback,
 * which means the loaded messages cannot answer for an uncovered card.
 */
export function resolveTopic(
  topics: Topic[],
  category: string,
  subcategory: string | undefined,
): Resolution | null {
  for (const attempt of resolutionOrder(category, subcategory)) {
    const topic = topics.find((t) => t.serves.some((p) => normalisePattern(p) === attempt.pattern));
    if (topic) return { topic, match: attempt.match };
  }
  return null;
}

/**
 * Message ids must survive restarts and re-ingests: the client sends ids back
 * in `exclude` so a second CTA press does not repeat what is already on
 * screen. Hashing the text (not its position) keeps an id pinned to its
 * message even when the pool is reordered or added to.
 */
export function messageId(topicId: string, text: string): string {
  const digest = createHash('sha1').update(text).digest('hex').slice(0, 8);
  return `${topicId}:${digest}`;
}

export function toMessages(topic: Topic): Message[] {
  return topic.messages.map((entry) => {
    const text = typeof entry === 'string' ? entry : entry.text;
    const source =
      typeof entry === 'string' ? topic.source_url : (entry.source_url ?? topic.source_url);
    return { id: messageId(topic.id, text), text, source_url: source };
  });
}
