/**
 * A single card message, ready to drop straight into a card's message box.
 *
 * `text` is plain text on purpose — no HTML, no entities. Whatever lands here
 * gets inserted verbatim into a textarea, so it has to be clean at rest rather
 * than sanitised by every client.
 */
export interface Message {
  id: string;
  text: string;
  source_url: string;
}

/**
 * How closely the request's card taxonomy matched the messages we served.
 *
 * The CTA never fails, so a request for a category we have no coverage for
 * still returns usable messages — this tells the client what it actually got
 * so the UI can label it honestly ("Birthday wishes for friends" vs "Wishes
 * you can use for any card").
 */
export type MatchKind = 'exact' | 'category' | 'generic';

/**
 * A message as stored. Ingest merges several blog posts into one topic, so a
 * message can carry the post it came from; fixtures write a bare string and
 * inherit the topic's `source_url`.
 */
export type TopicMessage = string | { text: string; source_url?: string };

/**
 * A pool of messages for one subject, plus the card taxonomy it covers.
 *
 * `serves` holds match patterns, most specific first:
 *   "birthday/friends"  exact category + subcategory
 *   "birthday/*"        any subcategory under a category
 *   "*"                 the global fallback
 */
export type Origin = 'blog' | 'placeholder';

export interface Topic {
  id: string;
  label: string;
  /**
   * Where the text came from. "placeholder" is written by us and must never
   * reach a user: the whole point of the feature is that the wording is
   * human-written by the blog's editors.
   */
  origin?: Origin;
  /** Attribution for messages that do not carry their own. */
  source_url: string;
  serves: string[];
  messages: TopicMessage[];
}

export interface Resolution {
  topic: Topic;
  match: MatchKind;
}

/**
 * Where topics come from.
 *
 * Stage 0 is `FixtureSource`. Stage 1 swaps in a source backed by the ingest
 * job without touching routes, selection, or any client — that is the whole
 * reason this boundary exists.
 */
export interface MessageSource {
  readonly name: string;
  load(): Promise<void>;
  topics(): Topic[];
  lastUpdated(): string | null;
  /** True when serving placeholders because the real source could not be read. */
  readonly degraded?: boolean;
}
