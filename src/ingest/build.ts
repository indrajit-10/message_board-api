import type { Topic } from '../core/types.js';
import { extractMessages, type ExtractVia } from './extract.js';
import type { Manifest } from './manifest.js';
import { pageTargets } from './manifest.js';

export interface FetchedPage {
  url: string;
  ok: boolean;
  status: number;
  html: string;
  error?: string;
}

export type PageStatus = 'ok' | 'fallback' | 'empty' | 'unreachable';

export interface PageOutcome {
  url: string;
  /** Topics this page feeds. */
  topics: string[];
  status: PageStatus;
  via: ExtractVia;
  strategies: string[];
  messages: number;
  httpStatus: number;
  error?: string;
}

export interface BuildResult {
  topics: Topic[];
  outcomes: PageOutcome[];
  rejected: Record<string, number>;
  extracted: number;
  kept: number;
  /** Declared topics with no pages listed — coverage waiting to be filled in. */
  topicsWithoutPages: string[];
}

/**
 * Manifest + fetched HTML -> topics.
 *
 * Pure, so the whole pipeline is testable without touching the network. Which
 * page belongs to which topic is read from the manifest rather than inferred,
 * so nothing here can quietly file a page under the wrong subject.
 */
export function buildTopics(manifest: Manifest, fetched: Map<string, FetchedPage>): BuildResult {
  const targets = pageTargets(manifest);
  const byTopic = new Map<string, Array<{ text: string; source_url: string }>>();
  const outcomes: PageOutcome[] = [];
  const rejected: Record<string, number> = {};
  let extracted = 0;

  for (const target of targets) {
    const page = fetched.get(target.url);

    if (!page || !page.ok) {
      outcomes.push({
        url: target.url,
        topics: target.topics,
        status: 'unreachable',
        via: 'none',
        strategies: [],
        messages: 0,
        httpStatus: page?.status ?? 0,
        ...(page?.error ? { error: page.error } : {}),
      });
      continue;
    }

    const result = extractMessages(page.html, {
      selector: target.selector,
      minLength: manifest.defaults.minLength,
      maxLength: manifest.defaults.maxLength,
    });

    extracted += result.messages.length;
    for (const [reason, n] of Object.entries(result.rejected)) {
      rejected[reason] = (rejected[reason] ?? 0) + n;
    }

    for (const topicId of target.topics) {
      const bucket = byTopic.get(topicId) ?? [];
      for (const text of result.messages) bucket.push({ text, source_url: target.url });
      byTopic.set(topicId, bucket);
    }

    outcomes.push({
      url: target.url,
      topics: target.topics,
      status: result.via === 'declared' ? 'ok' : result.via === 'fallback' ? 'fallback' : 'empty',
      via: result.via,
      strategies: result.strategies,
      messages: result.messages.length,
      httpStatus: page.status,
    });
  }

  // Pages overlap in content, so dedupe within each topic after merging.
  const topics: Topic[] = [];
  for (const declared of manifest.topics) {
    const collected = byTopic.get(declared.id) ?? [];
    if (collected.length === 0) continue;

    const seen = new Set<string>();
    const messages = collected.filter((m) => {
      const key = m.text.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    topics.push({
      id: declared.id,
      label: declared.label,
      origin: 'blog',
      source_url: messages[0]?.source_url ?? declared.pages[0]?.url ?? manifest.base,
      serves: declared.serves,
      messages,
    });
  }

  topics.sort((a, b) => b.messages.length - a.messages.length);

  return {
    topics,
    outcomes,
    rejected,
    extracted,
    kept: topics.reduce((n, t) => n + t.messages.length, 0),
    topicsWithoutPages: manifest.topics.filter((t) => t.pages.length === 0).map((t) => t.id),
  };
}

/**
 * Whether anything serves "*".
 *
 * Without it an uncovered card gets nothing back and the app should hide the
 * button. That is the honest outcome — borrowing placeholder text to fill the
 * gap would put words we wrote in front of a user, which is the one thing this
 * feature must never do.
 */
export function hasGlobalFallback(topics: Topic[]): boolean {
  return topics.some((t) => t.serves.includes('*'));
}
