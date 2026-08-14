import { Router } from 'express';
import { selectMessages } from '../../core/selection.js';
import { LIMITS, type RouteContext } from '../context.js';
import { boundedInt, idSet, optionalString, requiredString } from '../params.js';
import { badRequest, noStore } from '../respond.js';

/**
 * The CTA on a card-sending page: hand over the card's category and
 * subcategory, get back messages the user can drop into the message box.
 *
 * Deliberately never 404s on an unknown category. The card taxonomy is far
 * larger than our message coverage, so an unmatched card falls back to
 * category-wide and then generic messages, and `resolved.match` says which
 * happened.
 */
export function messagesRoute(ctx: RouteContext): Router {
  const router = Router();

  router.get('/v1/messages', (req, res) => {
    const category = requiredString(req, 'category');
    if (!category.ok) return badRequest(res, category.message);

    const limit = boundedInt(req, 'limit', LIMITS.messages);
    if (!limit.ok) return badRequest(res, limit.message);

    const subcategory = optionalString(req, 'subcategory');
    const catalog = ctx.catalog();
    const resolution = catalog.resolve(category.value, subcategory);

    noStore(res);

    // No blog messages cover this card. Answer plainly with an empty list so
    // the app can hide the button, rather than inventing something to show.
    if (!resolution) {
      return res.json({
        category: category.value,
        subcategory: subcategory ?? null,
        resolved: null,
        count: 0,
        messages: [],
        has_more: false,
        wrapped: false,
        // Servable, not loaded: withheld placeholders are loaded but can never
        // answer, so counting them here would report the wrong cause.
        unavailable_reason: catalog.topics.length
          ? 'no_blog_messages_for_this_card'
          : 'no_blog_messages_loaded',
      });
    }

    const pool = catalog.messagesFor(resolution.topic.id);
    const selection = selectMessages(pool, limit.value, idSet(req, 'exclude'));

    return res.json({
      category: category.value,
      subcategory: subcategory ?? null,
      resolved: {
        topic: resolution.topic.id,
        label: resolution.topic.label,
        match: resolution.match,
        source_url: resolution.topic.source_url,
      },
      count: selection.messages.length,
      messages: selection.messages,
      has_more: selection.has_more,
      wrapped: selection.wrapped,
    });
  });

  return router;
}
