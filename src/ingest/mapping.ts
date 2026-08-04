import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Rule {
  id: string;
  label: string;
  serves: string[];
  all: string[];
  any: string[];
}

export interface MappablePost {
  slug: string;
  title: string;
  categories: string[];
}

export async function loadRules(path = join(HERE, 'rules.json')): Promise<Rule[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { rules: Rule[] };
  return parsed.rules;
}

/**
 * Everything about a post that hints at what it is for, in one lowercase
 * string. Slug and title carry the subject far more reliably than the blog's
 * own categories, which tend to be broad.
 */
export function haystack(post: MappablePost): string {
  return [post.slug.replace(/-/g, ' '), post.title, ...post.categories].join(' ').toLowerCase();
}

/**
 * First matching rule wins, so `rules.json` is ordered specific to general —
 * "birthday wishes for mom" has to reach the family rule before the catch-all
 * birthday one.
 */
export function matchRule(post: MappablePost, rules: Rule[]): Rule | null {
  const text = haystack(post);
  for (const rule of rules) {
    const allOk = rule.all.every((k) => text.includes(k));
    const anyOk = rule.any.length === 0 || rule.any.some((k) => text.includes(k));
    if (allOk && anyOk) return rule;
  }
  return null;
}
