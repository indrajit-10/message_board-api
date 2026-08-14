import type { Request } from 'express';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Express types a repeated query parameter as an array and a bracketed one as
 * an object. Collapsing to the first string keeps `?limit=5&limit=9` from
 * reaching `Number()` as an array, which coerces to NaN and reads as a
 * mangled error rather than "you sent it twice".
 */
export function firstParam(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function requiredString(req: Request, name: string): Parsed<string> {
  const raw = firstParam(req.query[name])?.trim();
  if (!raw) return { ok: false, message: `Query parameter "${name}" is required.` };
  return { ok: true, value: raw };
}

export function optionalString(req: Request, name: string): string | undefined {
  const raw = firstParam(req.query[name])?.trim();
  return raw ? raw : undefined;
}

export function boundedInt(
  req: Request,
  name: string,
  { min, max, fallback }: { min: number; max: number; fallback: number },
): Parsed<number> {
  const raw = firstParam(req.query[name]);
  if (raw === undefined) return { ok: true, value: fallback };

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, message: `"${name}" must be an integer between ${min} and ${max}.` };
  }
  return { ok: true, value: parsed };
}

/** Comma-separated message ids the client already has on screen. */
export function idSet(req: Request, name: string): Set<string> {
  return new Set(
    (firstParam(req.query[name]) ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
