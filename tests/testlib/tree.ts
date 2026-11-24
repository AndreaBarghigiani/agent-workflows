/**
 * File-tree snapshot and comparison helpers shared by the Node suite.
 * Moved verbatim from `tests/parity/harness.ts` (issue #118): the harness
 * is gone with the Python sources, but `tests/test_install.test.ts` still
 * guards the comparison semantics directly.
 */
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { join } from 'node:path';

export interface TreeEntry {
  /**
   * The filesystem entry type is part of the comparison: a symlink whose
   * link text is `target` must not pass as a regular file containing
   * `target`.
   */
  kind: 'file' | 'link';
  bytes: Buffer;
}

export function fileTree(
  root: string,
  ignore?: RegExp,
  prefix = '',
): Map<string, TreeEntry> {
  const entries = new Map<string, TreeEntry>();
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const relativeName = prefix ? `${prefix}/${name}` : name;
    if (ignore?.test(relativeName)) continue;
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      // Compare link text, not target content: relative install links are
      // the product bytes, and reading through them into the repository
      // would compare the same library twice.
      entries.set(relativeName, {
        kind: 'link',
        bytes: Buffer.from(readlinkSync(path), 'utf8'),
      });
    } else if (st.isDirectory()) {
      for (const [sub, entry] of fileTree(path, ignore, relativeName)) {
        entries.set(sub, entry);
      }
    } else {
      entries.set(relativeName, { kind: 'file', bytes: readFileSync(path) });
    }
  }
  return entries;
}

export function compareTrees(
  py: Map<string, TreeEntry>,
  ts: Map<string, TreeEntry>,
): string[] {
  const diffs: string[] = [];
  for (const path of [...py.keys()].sort()) {
    if (!ts.has(path)) diffs.push(`  only in Python copy: ${path}`);
  }
  for (const path of [...ts.keys()].sort()) {
    if (!py.has(path)) diffs.push(`  only in TypeScript copy: ${path}`);
  }
  for (const [path, expected] of [...py.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const actual = ts.get(path);
    if (!actual) continue;
    if (actual.kind !== expected.kind) {
      diffs.push(
        `  ${path}: ${expected.kind} in Python copy, ` +
          `${actual.kind} in TypeScript copy`,
      );
      continue;
    }
    if (actual.bytes.equals(expected.bytes)) continue;
    const size = Math.min(actual.bytes.length, expected.bytes.length);
    let offset = 0;
    while (offset < size && actual.bytes[offset] === expected.bytes[offset]) {
      offset += 1;
    }
    diffs.push(
      `  ${path}: ${expected.bytes.length} vs ${actual.bytes.length} bytes, ` +
        `first difference at byte ${offset}`,
    );
  }
  return diffs;
}
