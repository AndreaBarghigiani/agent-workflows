/**
 * Atomic file write matching `memory_connections.atomic` in the Python
 * original: create the parent directory, `tempfile.mkstemp` in the
 * destination directory (exclusive create, mode 0600), write the text,
 * publish it with rename, or link it for create-only writes, and unlink the
 * temporary file if it is still
 * there after a failure.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export function atomicWrite(
  path: string,
  text: string,
  options: { createOnly?: boolean } = {},
): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  let descriptor = -1;
  let temporary = '';
  for (;;) {
    temporary = join(directory, `tmp${randomBytes(8).toString('hex')}`);
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  try {
    writeSync(descriptor, text);
    closeSync(descriptor);
    descriptor = -1;
    if (options.createOnly) {
      linkSync(temporary, path);
    } else {
      renameSync(temporary, path);
    }
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
