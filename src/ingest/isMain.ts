import { pathToFileURL } from 'node:url';

/**
 * True when this module is the file node was told to run, rather than an
 * import of it.
 *
 * Must go through pathToFileURL. Concatenating "file://" onto process.argv[1]
 * looks equivalent and is not: on Windows argv[1] is "D:\path\run.ts", which
 * yields "file://D:\path\run.ts" instead of "file:///D:/path/run.ts", and the
 * comparison silently fails — the CLI then exits having printed nothing. Paths
 * containing spaces break the same way on every platform, since only
 * pathToFileURL percent-encodes them.
 */
export function isMain(importMetaUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (!argv1) return false;
  return importMetaUrl === pathToFileURL(argv1).href;
}
