/**
 * Error classes named after their Python counterparts.
 *
 * The parity harness compares structured errors, not traceback text, so the
 * TypeScript port raises errors whose `name` matches the Python exception
 * class the original code would raise (`ValueError`, `KeyError`, `TypeError`,
 * the `OSError` subclasses).
 */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

export class KeyError extends Error {
  constructor(key: string) {
    super(`'${key}'`);
    this.name = 'KeyError';
  }
}

export class AttributeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttributeError';
  }
}

export class PyTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypeError';
  }
}

export class UnicodeDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnicodeDecodeError';
  }
}

export class RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

const OS_ERROR_NAMES: Record<string, string> = {
  ENOENT: 'FileNotFoundError',
  ENOTDIR: 'NotADirectoryError',
  EISDIR: 'IsADirectoryError',
  EEXIST: 'FileExistsError',
  EACCES: 'PermissionError',
  EPERM: 'PermissionError',
  EROFS: 'PermissionError',
  ELOOP: 'OSError',
  ENAMETOOLONG: 'OSError',
};

/** Map a Node errno error to the name of the OSError subclass Python raises. */
export function osErrorName(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (code && OS_ERROR_NAMES[code]) || 'OSError';
}
