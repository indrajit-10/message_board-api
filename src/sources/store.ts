import { readFile } from 'node:fs/promises';
import type { MessageSource, Topic } from '../types.js';

interface StoreFile {
  generated_at: string;
  source?: string;
  transport?: string;
  topics: Topic[];
}

/**
 * Serves whatever `npm run ingest` last wrote.
 *
 * Reads the file once at boot and holds it in memory: the CTA sits in a card
 * flow, so a request must never wait on disk, let alone on the blog. Getting
 * fresh messages means re-running ingest and restarting, which is also what
 * makes a bad ingest easy to roll back — the previous file is a file.
 */
export class StoreSource implements MessageSource {
  readonly name = 'store';

  #topics: Topic[] = [];
  #generatedAt: string | null = null;

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StoreFile;
    if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
      throw new Error(`${this.path} contains no topics — re-run "npm run ingest".`);
    }
    this.#topics = parsed.topics;
    this.#generatedAt = parsed.generated_at;
  }

  topics(): Topic[] {
    return this.#topics;
  }

  lastUpdated(): string | null {
    return this.#generatedAt;
  }
}
