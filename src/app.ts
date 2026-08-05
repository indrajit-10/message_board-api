import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import { selectMessages } from './selection.js';
import { resolveTopic, toMessages } from './taxonomy.js';
import type { MessageSource } from './types.js';

/** Repo root, whether running from src/ under tsx or dist/ after a build. */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 25;
export const DEFAULT_SEARCH_LIMIT = 100;
export const MAX_SEARCH_LIMIT = 500;

function firstParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createApp(source: MessageSource): Express {
  const app = express();
  app.use(cors());
  app.disable('x-powered-by');

  // Demo page for the CTA, served from the API so it can call it same-origin.
  app.use(express.static(PUBLIC_DIR));

  // Pretty paths; express.static already serves the .html files themselves.
  app.get('/api', (_req: Request, res: Response) => {
    res.sendFile(join(PUBLIC_DIR, 'api.html'));
  });
  app.get('/browse', (_req: Request, res: Response) => {
    res.sendFile(join(PUBLIC_DIR, 'browse.html'));
  });

  /**
   * The CTA on a card-sending page: hand over the card's category and
   * subcategory, get back messages the user can drop into the message box.
   *
   * Deliberately never 404s on an unknown category. The card taxonomy is far
   * larger than our message coverage, so an unmatched card falls back to
   * category-wide and then generic messages, and `resolved.match` says which
   * happened. A user who presses the button should always get something to
   * write.
   */
  app.get('/v1/messages', (req: Request, res: Response) => {
    const category = firstParam(req.query.category);
    const subcategory = firstParam(req.query.subcategory);

    if (!category) {
      fail(res, 400, 'invalid_request', 'Query parameter "category" is required.');
      return;
    }

    const rawLimit = firstParam(req.query.limit);
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
        fail(res, 400, 'invalid_request', `"limit" must be an integer between 1 and ${MAX_LIMIT}.`);
        return;
      }
      limit = parsed;
    }

    const exclude = new Set(
      (firstParam(req.query.exclude) ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );

    const resolution = resolveTopic(source.topics(), category, subcategory);
    if (!resolution) {
      fail(res, 503, 'no_messages', 'No messages are loaded. Check /v1/health.');
      return;
    }

    const selection = selectMessages(toMessages(resolution.topic), limit, exclude);

    // Responses are randomised per press, so caching them would defeat the CTA.
    res.set('Cache-Control', 'no-store');
    res.json({
      category,
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

  /**
   * Coverage map. Lets the client (or you) see which card categories actually
   * have dedicated messages instead of guessing from fallback behaviour.
   */
  app.get('/v1/categories', (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
      count: source.topics().length,
      topics: source.topics().map((t) => ({
        id: t.id,
        label: t.label,
        serves: t.serves,
        message_count: t.messages.length,
      })),
    });
  });

  /**
   * One topic with everything in it. The CTA never needs this — it exists so
   * an ingest can be inspected, since counts alone do not tell you whether
   * what was extracted is worth serving.
   */
  app.get('/v1/topics/:id', (req: Request, res: Response) => {
    const topic = source.topics().find((t) => t.id === req.params.id);
    if (!topic) {
      fail(res, 404, 'unknown_topic', `No topic "${req.params.id}". See /v1/categories.`);
      return;
    }
    const messages = toMessages(topic);
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      id: topic.id,
      label: topic.label,
      serves: topic.serves,
      count: messages.length,
      messages,
    });
  });

  /** Free-text search across every message, for spot-checking an ingest. */
  app.get('/v1/search', (req: Request, res: Response) => {
    const q = (firstParam(req.query.q) ?? '').trim();
    if (!q) {
      fail(res, 400, 'invalid_request', 'Query parameter "q" is required.');
      return;
    }

    const rawLimit = firstParam(req.query.limit);
    let limit = DEFAULT_SEARCH_LIMIT;
    if (rawLimit !== undefined) {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SEARCH_LIMIT) {
        fail(res, 400, 'invalid_request', `"limit" must be between 1 and ${MAX_SEARCH_LIMIT}.`);
        return;
      }
      limit = parsed;
    }

    const needle = q.toLowerCase();
    const results: Array<Record<string, string>> = [];
    let total = 0;

    for (const topic of source.topics()) {
      for (const message of toMessages(topic)) {
        if (!message.text.toLowerCase().includes(needle)) continue;
        total++;
        if (results.length < limit) {
          results.push({ ...message, topic: topic.id, label: topic.label });
        }
      }
    }

    res.set('Cache-Control', 'no-store');
    res.json({ q, total, count: results.length, truncated: total > results.length, results });
  });

  app.get('/v1/health', (_req: Request, res: Response) => {
    const topics = source.topics();
    res.set('Cache-Control', 'no-store');
    res.json({
      status: topics.length > 0 ? 'ok' : 'empty',
      source: source.name,
      topics: topics.length,
      messages: topics.reduce((sum, t) => sum + t.messages.length, 0),
      last_updated: source.lastUpdated(),
    });
  });

  app.use((_req: Request, res: Response) => {
    fail(res, 404, 'not_found', 'Unknown endpoint.');
  });

  return app;
}
