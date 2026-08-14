import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANIFEST_PATH = join(HERE, 'manifest.json');

export interface ManifestPage {
  /** Absolute, already resolved against the manifest's base. */
  url: string;
  /** Overrides the manifest default when this page marks messages up differently. */
  selector?: string;
}

export interface ManifestTopic {
  id: string;
  label: string;
  serves: string[];
  pages: ManifestPage[];
  /**
   * Keywords used only by `npm run suggest` to propose candidate URLs when
   * filling in `pages`. Never consulted during ingest — which page belongs to
   * which topic is declared above, not guessed from these.
   */
  find?: { all: string[]; any: string[] };
}

export interface Manifest {
  base: string;
  defaults: { selector: string; minLength: number; maxLength: number };
  topics: ManifestTopic[];
}

class ManifestError extends Error {
  constructor(where: string, problem: string) {
    super(`${MANIFEST_PATH}: ${where} ${problem}`);
    this.name = 'ManifestError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ManifestError(where, 'must be a non-empty string');
  return value.trim();
}

function requirePositiveInt(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ManifestError(where, 'must be a positive integer');
  }
  return value;
}

/**
 * A `serves` entry, as the taxonomy reads it: "category/subcategory",
 * "category/*", or "*". Anything else would silently never match a request,
 * so it is rejected here rather than discovered as missing coverage later.
 */
function requirePattern(value: unknown, where: string): string {
  const pattern = requireString(value, where);
  if (pattern === '*') return pattern;
  const parts = pattern.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ManifestError(where, `"${pattern}" must be "category/subcategory", "category/*" or "*"`);
  }
  return pattern;
}

/**
 * Pages are declared as paths and resolved against `base`.
 *
 * Cross-host entries are refused: this reads one site we own, and a stray
 * absolute URL would quietly turn the ingest into a crawl of somewhere else.
 */
export function resolvePageUrl(base: string, raw: string, where: string): string {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new ManifestError(where, `"${raw}" is not a usable URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ManifestError(where, `"${raw}" must be http or https`);
  }
  if (url.host !== new URL(base).host) {
    throw new ManifestError(where, `"${raw}" is not on ${new URL(base).host}`);
  }
  url.hash = '';
  return url.href;
}

function parsePage(raw: unknown, base: string, where: string): ManifestPage {
  if (typeof raw === 'string') return { url: resolvePageUrl(base, raw, where) };
  if (!isObject(raw)) throw new ManifestError(where, 'must be a URL string or { url, selector }');

  const url = resolvePageUrl(base, requireString(raw.url, `${where}.url`), `${where}.url`);
  if (raw.selector === undefined) return { url };
  return { url, selector: requireString(raw.selector, `${where}.selector`) };
}

export function parseManifest(input: unknown): Manifest {
  if (!isObject(input)) throw new ManifestError('root', 'must be a JSON object');

  const base = requireString(input.base, 'base');
  try {
    new URL(base);
  } catch {
    throw new ManifestError('base', `"${base}" is not a usable URL`);
  }

  if (!isObject(input.defaults)) throw new ManifestError('defaults', 'must be an object');
  const defaults = {
    selector: requireString(input.defaults.selector, 'defaults.selector'),
    minLength: requirePositiveInt(input.defaults.minLength, 'defaults.minLength'),
    maxLength: requirePositiveInt(input.defaults.maxLength, 'defaults.maxLength'),
  };
  if (defaults.minLength >= defaults.maxLength) {
    throw new ManifestError('defaults', 'minLength must be less than maxLength');
  }

  if (!Array.isArray(input.topics) || input.topics.length === 0) {
    throw new ManifestError('topics', 'must be a non-empty array');
  }

  const seen = new Set<string>();
  const topics: ManifestTopic[] = input.topics.map((raw, i) => {
    const where = `topics[${i}]`;
    if (!isObject(raw)) throw new ManifestError(where, 'must be an object');

    const id = requireString(raw.id, `${where}.id`);
    if (seen.has(id)) throw new ManifestError(where, `duplicates the id "${id}"`);
    seen.add(id);

    if (!Array.isArray(raw.serves) || raw.serves.length === 0) {
      throw new ManifestError(`${where}.serves`, 'must be a non-empty array');
    }
    if (!Array.isArray(raw.pages)) {
      throw new ManifestError(`${where}.pages`, 'must be an array (empty is allowed)');
    }

    const topic: ManifestTopic = {
      id,
      label: requireString(raw.label, `${where}.label`),
      serves: raw.serves.map((p, j) => requirePattern(p, `${where}.serves[${j}]`)),
      pages: raw.pages.map((p, j) => parsePage(p, base, `${where}.pages[${j}]`)),
    };

    if (isObject(raw.find)) {
      topic.find = {
        all: Array.isArray(raw.find.all) ? raw.find.all.map(String) : [],
        any: Array.isArray(raw.find.any) ? raw.find.any.map(String) : [],
      };
    }
    return topic;
  });

  return { base, defaults, topics };
}

export async function loadManifest(path = MANIFEST_PATH): Promise<Manifest> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`Could not read ${path}. This file is what tells ingest which pages to read.`);
  }
  try {
    return parseManifest(JSON.parse(text));
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`${path} is not valid JSON: ${err.message}`);
    throw err;
  }
}

/** Every page across every topic, deduped — one URL is fetched once. */
export function pageTargets(manifest: Manifest): Array<{ url: string; selector: string; topics: string[] }> {
  const byUrl = new Map<string, { url: string; selector: string; topics: string[] }>();

  for (const topic of manifest.topics) {
    for (const page of topic.pages) {
      const selector = page.selector ?? manifest.defaults.selector;
      const key = `${page.url}\n${selector}`;
      const existing = byUrl.get(key);
      if (existing) existing.topics.push(topic.id);
      else byUrl.set(key, { url: page.url, selector, topics: [topic.id] });
    }
  }

  return [...byUrl.values()];
}
