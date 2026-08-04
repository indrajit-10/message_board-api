import type { Message } from './types.js';

export interface Selection {
  messages: Message[];
  has_more: boolean;
  wrapped: boolean;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = copy[i] as T;
    const b = copy[j] as T;
    copy[i] = b;
    copy[j] = a;
  }
  return copy;
}

/**
 * Pick messages for one press of the CTA.
 *
 * Random rather than paginated: pressing "Get Messages" again should show
 * something new, and `exclude` carries the ids already on screen so it does.
 *
 * When exclusions have used up the pool we wrap and serve from the full set
 * again instead of returning nothing — an empty result would read as a broken
 * button. `wrapped` tells the client it has now seen everything we have.
 */
export function selectMessages(
  pool: readonly Message[],
  limit: number,
  exclude: ReadonlySet<string>,
): Selection {
  const unseen = pool.filter((m) => !exclude.has(m.id));
  const wrapped = unseen.length === 0 && pool.length > 0;
  const candidates = wrapped ? pool : unseen;
  const messages = shuffled(candidates).slice(0, limit);

  return {
    messages,
    has_more: !wrapped && unseen.length > messages.length,
    wrapped,
  };
}
