import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MessageSource } from '../types.js';
import { FixtureSource } from './fixture.js';
import { StoreSource } from './store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STORE_PATH = join(ROOT, 'data', 'topics.json');

/**
 * Chooses the backing source.
 *
 * "auto" prefers ingested messages and falls back to fixtures, so a checkout
 * that has never run ingest still boots and still answers — the CTA works from
 * the first `npm run dev`, and starts serving real messages the moment the
 * store exists. Force either with MESSAGE_SOURCE=store|fixture.
 */
export function createSource(kind = process.env.MESSAGE_SOURCE ?? 'auto'): MessageSource {
  switch (kind) {
    case 'auto':
      return existsSync(STORE_PATH) ? new StoreSource(STORE_PATH) : new FixtureSource();
    case 'store':
      return new StoreSource(STORE_PATH);
    case 'fixture':
      return new FixtureSource();
    default:
      throw new Error(`Unknown MESSAGE_SOURCE "${kind}" (known: auto, store, fixture)`);
  }
}

export { FixtureSource, StoreSource };
