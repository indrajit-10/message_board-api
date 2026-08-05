import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageSource } from '../types.js';
import { FixtureSource } from './fixture.js';
import { LiveSource } from './live.js';
import { StoreSource } from './store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STORE_PATH = join(ROOT, 'data', 'topics.json');

/**
 * Chooses the backing source.
 *
 * "auto" prefers an ingested store and falls back to fixtures, so a checkout
 * that has never run ingest still boots and still answers.
 *
 * "live" skips the store entirely and reads the blog at startup, for when
 * running a separate ingest step is not wanted.
 */
export function createSource(kind = process.env.MESSAGE_SOURCE ?? 'auto'): MessageSource {
  switch (kind) {
    case 'auto':
      return existsSync(STORE_PATH) ? new StoreSource(STORE_PATH) : new FixtureSource();
    case 'store':
      return new StoreSource(STORE_PATH);
    case 'fixture':
      return new FixtureSource();
    case 'live':
      return new LiveSource();
    default:
      throw new Error(`Unknown MESSAGE_SOURCE "${kind}" (known: auto, live, store, fixture)`);
  }
}

export { FixtureSource, LiveSource, StoreSource };
