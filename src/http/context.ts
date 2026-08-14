import type { Catalog } from '../core/catalog.js';
import type { MessageSource } from '../core/types.js';

/**
 * What every route needs, passed in rather than reached for.
 *
 * `catalog()` is a getter, not a value: a live source can swap its topics
 * between requests, and the routes should read whatever is current without
 * knowing that refreshing is a thing that happens.
 */
export interface RouteContext {
  catalog: () => Catalog;
  source: MessageSource;
  allowPlaceholders: boolean;
}

export const LIMITS = {
  messages: { min: 1, max: 25, fallback: 5 },
  search: { min: 1, max: 500, fallback: 100 },
} as const;
