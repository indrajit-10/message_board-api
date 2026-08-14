import { Router } from 'express';
import type { RouteContext } from '../context.js';
import { cacheFor, fail } from '../respond.js';

/**
 * Reading the catalog: what coverage exists, and what is actually in a topic.
 *
 * Neither is on the CTA's path. They exist so an ingest can be inspected —
 * counts alone do not tell you whether what was extracted is worth serving.
 */
export function catalogRoutes(ctx: RouteContext): Router {
  const router = Router();

  /** Coverage map: which card categories have dedicated messages, and how many. */
  router.get('/v1/categories', (_req, res) => {
    const catalog = ctx.catalog();
    cacheFor(res, 300);
    res.json({
      count: catalog.topics.length,
      topics: catalog.topics.map((t) => ({
        id: t.id,
        label: t.label,
        serves: t.serves,
        message_count: catalog.messagesFor(t.id).length,
      })),
    });
  });

  /** One topic with every message in it, rather than a sample. */
  router.get('/v1/topics/:id', (req, res) => {
    const catalog = ctx.catalog();
    const id = req.params.id;
    const topic = catalog.topicById(id);
    if (!topic) {
      return fail(res, 404, 'unknown_topic', `No topic "${id}". See /v1/categories.`);
    }

    const messages = catalog.messagesFor(topic.id);
    cacheFor(res, 60);
    return res.json({
      id: topic.id,
      label: topic.label,
      serves: topic.serves,
      count: messages.length,
      messages,
    });
  });

  return router;
}
