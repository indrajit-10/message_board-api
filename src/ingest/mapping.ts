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

const patterns = new Map<string, RegExp>();

/**
 * Keywords match whole words, with an optional plural "s".
 *
 * Plain substring matching cannot tell "son" in "birthday-messages-for-son"
 * from the one in "grandson", "person" or "season", and reads "mother" inside
 * "grandmother" — which is why relations had to be lumped into one rule per
 * family. Anchoring to word edges lets each relation have its own rule and its
 * own messages. The optional "s" is there because posts are titled "for
 * friends" while the keyword reads "friend".
 */
function keywordPattern(keyword: string): RegExp {
  let pattern = patterns.get(keyword);
  if (!pattern) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}s?(?![\\p{L}\\p{N}])`, 'iu');
    patterns.set(keyword, pattern);
  }
  return pattern;
}

export function mentions(text: string, keyword: string): boolean {
  return keywordPattern(keyword).test(text);
}

/**
 * First matching rule wins, so `rules.json` is ordered specific to general —
 * "birthday messages for mom" has to reach the mom rule before the catch-all
 * birthday one.
 */
export function matchRule(post: MappablePost, rules: Rule[]): Rule | null {
  const text = haystack(post);
  for (const rule of rules) {
    const allOk = rule.all.every((k) => mentions(text, k));
    const anyOk = rule.any.length === 0 || rule.any.some((k) => mentions(text, k));
    if (allOk && anyOk) return rule;
  }
  return null;
}
