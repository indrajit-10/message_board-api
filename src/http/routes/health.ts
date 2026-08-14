import { Router } from 'express';
import type { Topic } from '../../core/types.js';
import type { RouteContext } from '../context.js';
import { noStore } from '../respond.js';

const countMessages = (topics: Topic[]): number =>
  topics.reduce((sum, t) => sum + t.messages.length, 0);

export function healthRoute(ctx: RouteContext): Router {
  const router = Router();

  router.get('/v1/health', (_req, res) => {
    // Read the source, not the catalog: the catalog has already dropped
    // placeholders, and whether any are loaded is exactly what this reports.
    const all = ctx.source.topics();
    const blog = all.filter((t) => t.origin !== 'placeholder');
    const placeholder = all.filter((t) => t.origin === 'placeholder');

    noStore(res);
    res.json({
      status: blog.length > 0 ? 'ok' : 'no_blog_messages',
      source: ctx.source.name,
      degraded: ctx.source.degraded === true,
      topics: blog.length,
      messages: countMessages(blog),
      // Loaded but withheld. Should be 0 in production; anything else means
      // text we wrote is one config flag away from a user.
      placeholder_messages: countMessages(placeholder),
      serving_placeholders: ctx.allowPlaceholders,
      last_updated: ctx.source.lastUpdated(),
    });
  });

  return router;
}
