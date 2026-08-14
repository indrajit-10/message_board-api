import { normalisePattern, resolutionOrder, toMessages } from './taxonomy.js';
import type { Message, MessageSource, Resolution, Topic } from './types.js';

export interface SearchHit extends Message {
  topic: string;
  label: string;
}

/**
 * An immutable, fully-derived view of one set of topics.
 *
 * Everything the routes need is computed once here instead of per request:
 * placeholder filtering, message ids, the pattern index resolution walks, and
 * the lowercased text search compares against. The old code redid all four on
 * every call, so `/v1/search` alone re-lowercased every message in the store
 * for each query.
 */
export class Catalog {
  readonly topics: readonly Topic[];
  readonly messageCount: number;

  readonly #messagesByTopic = new Map<string, Message[]>();
  readonly #byPattern = new Map<string, Topic>();
  readonly #searchRows: Array<{ hit: SearchHit; haystack: string }> = [];

  constructor(topics: readonly Topic[]) {
    this.topics = topics;

    for (const topic of topics) {
      const messages = toMessages(topic);
      this.#messagesByTopic.set(topic.id, messages);

      // First topic to claim a pattern keeps it, matching the old find()
      // semantics where the earliest topic in the list won.
      for (const pattern of topic.serves) {
        const key = normalisePattern(pattern);
        if (!this.#byPattern.has(key)) this.#byPattern.set(key, topic);
      }

      for (const message of messages) {
        this.#searchRows.push({
          hit: { ...message, topic: topic.id, label: topic.label },
          haystack: message.text.toLowerCase(),
        });
      }
    }

    this.messageCount = this.#searchRows.length;
  }

  messagesFor(topicId: string): Message[] {
    return this.#messagesByTopic.get(topicId) ?? [];
  }

  topicById(id: string): Topic | undefined {
    return this.topics.find((t) => t.id === id);
  }

  /** Exact, then category-wide, then the global pool. */
  resolve(category: string, subcategory: string | undefined): Resolution | null {
    for (const attempt of resolutionOrder(category, subcategory)) {
      const topic = this.#byPattern.get(attempt.pattern);
      if (topic) return { topic, match: attempt.match };
    }
    return null;
  }

  search(query: string, limit: number): { total: number; results: SearchHit[] } {
    const needle = query.toLowerCase();
    const results: SearchHit[] = [];
    let total = 0;

    for (const row of this.#searchRows) {
      if (!row.haystack.includes(needle)) continue;
      total++;
      if (results.length < limit) results.push(row.hit);
    }

    return { total, results };
  }
}

/**
 * A catalog that rebuilds only when the source actually swaps its topics.
 *
 * `LiveSource` replaces its array wholesale on each refresh, so comparing the
 * array by reference is enough to know the derived view is stale — no timers,
 * no invalidation calls from the refresh path.
 */
export function catalogView(
  source: MessageSource,
  { allowPlaceholders }: { allowPlaceholders: boolean },
): () => Catalog {
  let builtFrom: readonly Topic[] | null = null;
  let catalog: Catalog | null = null;

  return () => {
    const all = source.topics();
    if (catalog && builtFrom === all) return catalog;

    const servable = allowPlaceholders ? all : all.filter((t) => t.origin !== 'placeholder');
    catalog = new Catalog(servable);
    builtFrom = all;
    return catalog;
  };
}
