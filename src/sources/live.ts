import { buildTopics } from '../ingest/build.js';
import { fetchDeclared } from '../ingest/collect.js';
import { loadManifest, type Manifest } from '../ingest/manifest.js';
import type { MessageSource, Topic } from '../core/types.js';
import { FixtureSource } from './fixture.js';

export interface LiveOptions {
  manifestPath?: string;
  /** How often to re-read the blog. Set to 0 to read once at startup. */
  refreshMs?: number;
  quiet?: boolean;
}

const SIX_HOURS = 6 * 60 * 60 * 1000;

/**
 * Reads the manifest's pages at startup and holds the result in memory — no
 * ingest command, no store file.
 *
 * What it does not change is that a request never waits on the blog: serving
 * straight from a live fetch would put a remote site in the path of a button
 * inside the card flow, and one slow response there reads as a broken feature.
 *
 * If the pages cannot be read the fixtures are used instead, so the API still
 * boots and `/v1/health` reports `degraded`.
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
      this.#timer = setInterval(() => void this.#refresh(), every);
      // A background refresh should never be the reason the process stays up.
      this.#timer.unref();
    }
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  async #refresh(): Promise<void> {
    const log = (m: string) => {
      if (!this.options.quiet) console.log(m);
    };

    try {
      const manifest: Manifest = await loadManifest(this.options.manifestPath);
      const fetched = await fetchDeclared(manifest, { onProgress: log });
      const built = buildTopics(manifest, fetched);

      if (built.kept === 0) throw new Error('no messages extracted from the declared pages');

      // Replacing the array wholesale is what tells the catalog to rebuild.
      this.#topics = built.topics;
      this.#updated = new Date().toISOString();
      this.#degraded = false;

      const failed = built.outcomes.filter((o) => o.status !== 'ok');
      log(`  ${built.kept} messages across ${built.topics.length} topics`);
      if (failed.length > 0) {
        // Named here too: a live boot has no summary to read afterwards.
        console.warn(`  ${failed.length} page(s) did not extract cleanly:`);
        for (const o of failed) console.warn(`    ${o.status.padEnd(11)} ${o.url}`);
        console.warn('  Run "npm run check" for the full report.');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      // Keep whatever a previous refresh loaded — stale messages beat none.
      if (this.#topics.length > 0) {
        console.warn(`Refresh failed (${reason}); keeping messages from ${this.#updated}.`);
        return;
      }

      console.warn(`Could not read the declared pages: ${reason}`);
      console.warn('Falling back to the built-in fixtures so the API still boots.');
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
