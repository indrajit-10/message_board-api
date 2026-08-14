import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express } from 'express';
import { catalogView } from '../core/catalog.js';
import type { MessageSource } from '../core/types.js';
import type { RouteContext } from './context.js';
import { fail } from './respond.js';
import { catalogRoutes } from './routes/catalog.js';
import { healthRoute } from './routes/health.js';
import { messagesRoute } from './routes/messages.js';
import { searchRoute } from './routes/search.js';

/** Repo root, whether running from src/ under tsx or dist/ after a build. */
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

export interface AppOptions {
  /**
   * Serve placeholder text. Off, and it should stay off anywhere a user can
   * see: the feature's whole value is that a person wrote the words, so a
   * message we wrote is worse than no message at all.
   */
  allowPlaceholders?: boolean;
}

/**
 * Assembly only — every route lives in its own module and receives what it
 * needs through `RouteContext`. Placeholder filtering happens once, in the
 * catalog, so no endpoint can disagree with another about what is servable.
 */
export function createApp(source: MessageSource, options: AppOptions = {}): Express {
  const allowPlaceholders = options.allowPlaceholders === true;
  const ctx: RouteContext = {
    source,
    allowPlaceholders,
    catalog: catalogView(source, { allowPlaceholders }),
  };

  const app = express();
  app.use(cors());
  app.disable('x-powered-by');

  // The demo pages are served by the API so they can call it same-origin.
  app.use(express.static(PUBLIC_DIR));
  app.get('/api', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'api.html')));
  app.get('/browse', (_req, res) => res.sendFile(join(PUBLIC_DIR, 'browse.html')));

  app.use(messagesRoute(ctx));
  app.use(catalogRoutes(ctx));
  app.use(searchRoute(ctx));
  app.use(healthRoute(ctx));

  app.use((_req, res) => fail(res, 404, 'not_found', 'Unknown endpoint.'));

  return app;
}
