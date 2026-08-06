import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageSource, Topic } from '../types.js';

interface FixtureFile {
  generated_at: string;
  topics: Topic[];
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Stage 0 source: topics loaded from a checked-in JSON file.
 *
 * Lets the CTA, the client and this whole contract be built and tested before
 * any ingest from the blog exists. Stage 1 adds a source that reads the same
 * shape out of the ingest store; nothing above this file changes.
 */
export class FixtureSource implements MessageSource {
  readonly name = 'fixture';

  /** Fixtures are never the blog's messages. */
  readonly degraded = true;

  #topics: Topic[] = [];
  #generatedAt: string | null = null;

  async load(): Promise<void> {
    const path = join(HERE, 'fixtures', 'topics.json');
    const parsed = JSON.parse(await readFile(path, 'utf8')) as FixtureFile;
    // Stamped here rather than trusted from the file: this source is the
    // placeholder source, so nothing it loads can be blog text.
    this.#topics = parsed.topics.map((t) => ({ ...t, origin: 'placeholder' as const }));
    this.#generatedAt = parsed.generated_at;
  }

  topics(): Topic[] {
    return this.#topics;
  }

  lastUpdated(): string | null {
    return this.#generatedAt;
  }
}
