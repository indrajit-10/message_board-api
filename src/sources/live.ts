import { crawlSection } from '../ingest/crawl.js';
import { DEFAULT_BASE } from '../ingest/http.js';
import { loadRules } from '../ingest/mapping.js';
import { buildTopics, DEFAULT_SECTION, ensureFallback } from '../ingest/run.js';
import type { MessageSource, Topic } from '../types.js';
import { FixtureSource } from './fixture.js';

export interface LiveOptions {
  base?: string;
  section?: string;
  /** How often to re-read the blog. Set to 0 to read once at startup. */
  refreshMs?: number;
  quiet?: boolean;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Reads the blog at startup and holds the result in memory — no ingest
 * command, no store file.
 *
 * The crawl still happens; it just happens for you. That costs a slower boot
 * and messages that are only as fresh as the last refresh, and buys one less
 * step to remember. What it does not change is that a request never waits on
 * the blog: serving straight from a live fetch would put a remote site in the
 * path of a button inside the card flow, and one slow response there reads as
 * a broken feature.
 *
 * If the blog cannot be reached the fixtures are used instead, so the API
 * still boots and the CTA still answers.
 */
export class LiveSource implements MessageSource {
  readonly name = 'live';

  #topics: Topic[] = [];
  #updated: string | null = null;
  #degraded = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: LiveOptions = {}) {}

  get degraded(): boolean {
    return this.#degraded;
  }

  async load(): Promise<void> {
    await this.#refresh();

    const every = this.options.refreshMs ?? SIX_HOURS;
    if (every > 0) {
      this.#timer = setInterval(() => {
        void this.#refresh();
      }, every);
      // A background refresh should never be the reason the process stays up.
      this.#timer.unref();
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async #refresh(): Promise<void> {
    const base = this.options.base ?? DEFAULT_BASE;
    const section = this.options.section ?? DEFAULT_SECTION;
    const log = (m: string) => {
      if (!this.options.quiet) console.log(m);
    };

    try {
      log(`Reading ${base}${section} …`);
      const pages = await crawlSection({ base, section, onProgress: log });
      const rules = await loadRules();
      const { topics, kept } = buildTopics(pages, rules);
      await ensureFallback(topics);

      if (kept === 0) throw new Error('crawl produced no messages');

      this.#topics = topics;
      this.#updated = new Date().toISOString();
      this.#degraded = false;
      log(`  ${kept} messages across ${topics.length} topics`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      // Keep whatever a previous refresh loaded — stale messages beat none.
      if (this.#topics.length > 0) {
        console.warn(`Refresh failed (${reason}); keeping messages from ${this.#updated}.`);
        return;
      }

      console.warn(`Could not read ${base}${section}: ${reason}`);
      console.warn('Falling back to the built-in fixtures so the API still answers.');
      const fixtures = new FixtureSource();
      await fixtures.load();
      this.#topics = fixtures.topics();
      this.#updated = fixtures.lastUpdated();
      this.#degraded = true;
    }
  }

  topics(): Topic[] {
    return this.#topics;
  }

  lastUpdated(): string | null {
    return this.#updated;
  }
}
