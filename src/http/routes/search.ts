import { Router } from 'express';
import { LIMITS, type RouteContext } from '../context.js';
import { boundedInt, requiredString } from '../params.js';
import { badRequest, noStore } from '../respond.js';

/** Free-text search across every message, for spot-checking an ingest. */
export function searchRoute(ctx: RouteContext): Router {
  const router = Router();

  router.get('/v1/search', (req, res) => {
    const q = requiredString(req, 'q');
    if (!q.ok) return badRequest(res, q.message);

    const limit = boundedInt(req, 'limit', LIMITS.search);
    if (!limit.ok) return badRequest(res, limit.message);

    const { total, results } = ctx.catalog().search(q.value, limit.value);

    noStore(res);
    return res.json({
      q: q.value,
      total,
      count: results.length,
      truncated: total > results.length,
      results,
    });
  });

  return router;
}
