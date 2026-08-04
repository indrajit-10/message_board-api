import type { MessageSource } from '../types.js';
import { FixtureSource } from './fixture.js';

/**
 * Chooses the backing source. Stage 1 registers its ingest-backed source here
 * and flips MESSAGE_SOURCE; routes and clients stay untouched.
 */
export function createSource(kind = process.env.MESSAGE_SOURCE ?? 'fixture'): MessageSource {
  switch (kind) {
    case 'fixture':
      return new FixtureSource();
    default:
      throw new Error(`Unknown MESSAGE_SOURCE "${kind}" (known: fixture)`);
  }
}

export { FixtureSource };
