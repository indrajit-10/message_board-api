import type { Response } from 'express';

export function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function badRequest(res: Response, message: string): void {
  fail(res, 400, 'invalid_request', message);
}

/**
 * `/v1/messages` randomises per press, so a cached response would hand every
 * card sender the same five lines and defeat the point of the button.
 */
export function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store');
}

export function cacheFor(res: Response, seconds: number): void {
  res.set('Cache-Control', `public, max-age=${seconds}`);
}
