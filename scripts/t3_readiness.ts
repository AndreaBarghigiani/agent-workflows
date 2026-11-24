/**
 * TypeScript port of `scripts/t3_readiness.py` (issue #117): configure
 * optional T3 readiness and verify a consumer's declared checkout inputs.
 *
 * Runtime helpers (`install`, `memory_connections`, `setup_memory`) load
 * from the consumer's pinned library, the TypeScript module first: a pin
 * carrying only `*.py` helpers is reported as needing migration instead of
 * crashing. The generated bootstrap is the Node `.mjs` launcher and the
 * readiness action runs `node .agent-workflows-t3.mjs`; a Python-era
 * `.agent-workflows-t3.py` bootstrap or action is reported as needing
 * migration, never regenerated.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  closeSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGit } from './lib/git.ts';
import { pyDecodeUtf8 } from './lib/pyio.ts';
import {
  pyJsonLoads,
  jsonLoadsError,
  jsonLoadsErrorMessage,
  PyFloat,
} from './lib/pyloads.ts';
import {
  UnicodeDecodeError,
  ValueError,
  osErrorName,
} from './lib/pyerrors.ts';
import { pyRepr, pyStrRepr } from './lib/pyrepr.ts';
import { pyResolve } from './install.ts';

export const CONFIG = '.agent-workflows-t3.json';
export const BOOTSTRAP = '.agent-workflows-t3.py';
export const BOOTSTRAP_MJS = '.agent-workflows-t3.mjs';
export const ACTION_ID = 'agent-workflows-checkout-readiness';
const REQUIRED = ['base', 'choice', 'library', 'memory', 'profiles'];
const REQUIRED_SET = new Set(REQUIRED);
// Older configurations carried an explicit consumer skill selection and/or a
// memory enabled flag; the versioned toolkit model replaces both, so legacy
// "skills" arrays and legacy memory "enabled" booleans are accepted and
// ignored. The Basic Memory capability choice lives only in the installer's
// capabilities file; this configuration keeps preparation mechanics only.
const LEGACY_SET = new Set([...REQUIRED, 'skills']);
// Deterministic relocation target for a recorded routing source that cannot
// hold the tracked copy. Matches the established consumer convention: a
// Markdown copy of the generated routing outside the generated directory.
export const RELOCATED_ROUTING_SOURCE = '.agents/memory-routing.md';
const RESERVED_ROUTING_PATHS = new Set([
  '.agents/memory/config.md',     // the generated routing destination itself
  '.agents/memory/config.toml',   // the reviewed routing input
  '.agents/memory.toml',          // retired v1 routing artifacts
  '.agents/memory.local.toml',
]);

// --- Python value semantics ----------------------------------------------------

type Dict = Record<string, unknown> | Map<string, unknown>;

function isDict(value: unknown): value is Dict {
  if (value instanceof Map) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat)
  );
}

/** `key in mapping` over either dict shape. */
function dictHas(mapping: Dict, key: string): boolean {
  return mapping instanceof Map
    ? mapping.has(key)
    : Object.hasOwn(mapping, key);
}

/** `mapping[key]` without the KeyError — callers check `dictHas` first. */
function dictGet(mapping: Dict, key: string): unknown {
  return mapping instanceof Map ? mapping.get(key) : mapping[key];
}

/** `mapping.get(key, default)`. */
function dictGetOr(mapping: Dict, key: string, fallback: unknown): unknown {
  return dictHas(mapping, key) ? dictGet(mapping, key) : fallback;
}

/** `mapping[key] = value` — insert or keep position, like Python dicts. */
function dictSet(mapping: Dict, key: string, value: unknown): void {
  if (mapping instanceof Map) mapping.set(key, value);
  else mapping[key] = value;
}

/** `for key in mapping` — insertion order like Python dicts. */
function dictKeys(mapping: Dict): string[] {
  return mapping instanceof Map ? [...mapping.keys()] : Object.keys(mapping);
}

/** `for key, value in mapping.items()` — insertion order. */
function dictItems(mapping: Dict): [string, unknown][] {
  return mapping instanceof Map
    ? [...mapping.entries()]
    : Object.keys(mapping).map((key) => [key, mapping[key]]);
}

/**
 * `{**mapping, key: value}` — a copy of `mapping` with `key` set; an
 * existing key keeps its position like Python's dict spread.
 */
function dictSpread(mapping: Dict, key: string, value: unknown): Dict {
  const copy = new Map<string, unknown>();
  for (const [k, member] of dictItems(mapping)) {
    copy.set(k, k === key ? value : member);
  }
  if (!copy.has(key)) copy.set(key, value);
  return copy;
}

// Python `str.strip()` whitespace: CPython's set includes \x1c-\x1f and
// \x85 (which JavaScript `\s` lacks) plus the Unicode separators — minus
// U+FEFF, which Python does not count as whitespace.
const PY_WS =
  '\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004' +
  '\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
const PY_WS_CLASS =
  '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029' +
  '\\u202f\\u205f\\u3000';
const PY_WS_RE = new RegExp(`[${PY_WS_CLASS}]+`, 'u');

/** Python `str.strip()` over the CPython whitespace set. */
function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WS.includes(text[start])) start += 1;
  while (end > start && PY_WS.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `text.split()` with no separator — runs of whitespace, ends stripped. */
function pySplit(text: string): string[] {
  const stripped = pyStrip(text);
  return stripped === '' ? [] : stripped.split(PY_WS_RE);
}

/** `text.splitlines()` — universal newlines, no keepends. */
function pySplitlines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Python `sorted()` over strings — code-point order. */
function pySortedStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => {
    const pa = [...a].map((c) => c.codePointAt(0)!);
    const pb = [...b].map((c) => c.codePointAt(0)!);
    const len = Math.min(pa.length, pb.length);
    for (let i = 0; i < len; i += 1) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return pa.length - pb.length;
  });
}

/**
 * The numeric tower Python's `==` shares across `bool`, `int` and `float`.
 */
function pyNumeric(value: unknown): bigint | number | undefined {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'bigint') return value;
  if (value instanceof PyFloat) value = value.value;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value) : value;
  }
  return undefined;
}

/** `mapping == mapping` — key sets equal and each value `==`. */
function pyDictEq(a: Dict, b: Dict): boolean {
  const aKeys = dictKeys(a);
  if (aKeys.length !== dictKeys(b).length) return false;
  return aKeys.every(
    (key) => dictHas(b, key) && pyEq(dictGet(a, key), dictGet(b, key)),
  );
}

/** Python `==` over the JSON-shaped values this module compares. */
function pyEq(a: unknown, b: unknown): boolean {
  const na = pyNumeric(a);
  const nb = pyNumeric(b);
  if (na !== undefined && nb !== undefined) return na === nb;
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((member, index) => pyEq(member, b[index]))
    );
  }
  if (isDict(a) || isDict(b)) {
    return isDict(a) && isDict(b) && pyDictEq(a, b);
  }
  if (a === null || a === undefined || b === null || b === undefined) {
    return (
      (a === null || a === undefined) &&
      (b === null || b === undefined)
    );
  }
  return false;
}

// `shlex.split` — CPython 3.12 state machine with posix=True,
// punctuation_chars off, whitespace_split=True and commenters=''.
const SHLEX_WHITESPACE = ' \t\r\n';
const SHLEX_QUOTES = '\'"';

function shlexSplit(text: string): string[] {
  const words: string[] = [];
  let token = '';
  let state = ' '; // ' ' | 'a' | "'" | '"' | '\\'
  let escapedstate = ' ';
  let quoted = false;
  for (const nextchar of text) {
    if (state === ' ') {
      if (SHLEX_WHITESPACE.includes(nextchar)) {
        if (token !== '' || quoted) {
          words.push(token);
          token = '';
          quoted = false;
        }
        continue;
      }
      if (nextchar === '\\') {
        escapedstate = 'a';
        state = '\\';
      } else if (SHLEX_QUOTES.includes(nextchar)) {
        state = nextchar;
      } else {
        token += nextchar;
        state = 'a';
      }
      continue;
    }
    if (state === "'" || state === '"') {
      quoted = true;
      if (nextchar === state) {
        state = 'a';
      } else if (nextchar === '\\' && state === '"') {
        escapedstate = state;
        state = '\\';
      } else {
        token += nextchar;
      }
      continue;
    }
    if (state === '\\') {
      if (escapedstate !== 'a' && nextchar !== '\\' &&
          nextchar !== escapedstate) {
        token += '\\';
      }
      token += nextchar;
      state = escapedstate;
      continue;
    }
    // state 'a'
    if (SHLEX_WHITESPACE.includes(nextchar)) {
      state = ' ';
      if (token !== '' || quoted) {
        words.push(token);
        token = '';
        quoted = false;
      }
    } else if (SHLEX_QUOTES.includes(nextchar)) {
      state = nextchar;
    } else if (nextchar === '\\') {
      escapedstate = 'a';
      state = '\\';
    } else {
      token += nextchar;
    }
  }
  if (state === "'" || state === '"') {
    throw new ValueError('No closing quotation');
  }
  if (state === '\\') {
    throw new ValueError('No escaped character');
  }
  if (token !== '' || quoted) words.push(token);
  return words;
}

/** `str.casefold()` — full case folding for the fold-to-single mappings. */
const CASEFOLD_MULTI: Record<string, string> = {
  ß: 'ss', ẞ: 'ss', ﬀ: 'ff', ﬁ: 'fi', ﬂ: 'fl', ﬃ: 'ffi', ﬄ: 'ffl',
  ﬅ: 'st', ﬆ: 'st', և: 'եւ', ŉ: 'ʼn', ǰ: 'ǰ', ΐ: 'ΐ', ΰ: 'ΰ',
  բ: 'բ',
};

function pyCasefold(text: string): string {
  let out = '';
  for (const char of text) {
    const folded = CASEFOLD_MULTI[char];
    out += folded !== undefined ? folded : char.toLowerCase();
  }
  // Long s, Greek sigma final form and friends fold to another single char
  // that toLowerCase leaves alone.
  return out
    .replace(/ſ/g, 's')
    .replace(/ς/g, 'σ')
    .replace(/ẛ/g, 'ṡ')
    .replace(/ι/g, 'ι')
    .replace(/İ/g, 'i̇');
}

// --- Decoding -------------------------------------------------------------------

/** `json.loads` raising `ValueError` carrying the CPython error text. */
function jsonLoads(text: string): unknown {
  const error = jsonLoadsError(text);
  if (error !== null) {
    throw new ValueError(jsonLoadsErrorMessage(text, error));
  }
  return pyJsonLoads(text);
}

/** `json.detect_encoding` — BOMs, then the null-byte sniffing CPython uses. */
function detectJsonEncoding(data: Uint8Array): string {
  const starts = (bom: number[]) =>
    bom.length <= data.length && bom.every((b, i) => data[i] === b);
  if (starts([0, 0, 0xfe, 0xff]) || starts([0xff, 0xfe, 0, 0])) return 'utf-32';
  if (starts([0xfe, 0xff]) || starts([0xff, 0xfe])) return 'utf-16';
  if (starts([0xef, 0xbb, 0xbf])) return 'utf-8-sig';
  if (data.length >= 4) {
    if (data[0] === 0) {
      return data[1] === 0 ? 'utf-32-be' : 'utf-16-be';
    }
    if (data[1] === 0) {
      return data[0] === 0 ? 'utf-32-le' : 'utf-16-le';
    }
  } else if (data.length === 2) {
    if (data[0] === 0) return 'utf-16-be';
    if (data[1] === 0) return 'utf-16-le';
  }
  return 'utf-8';
}

function decodeBytes(data: Uint8Array, encoding: string): string {
  try {
    switch (encoding) {
      case 'utf-32':
      case 'utf-32-be':
      case 'utf-32-le': {
        const little =
          encoding === 'utf-32-le' ||
          (encoding === 'utf-32' && data[0] === 0xff);
        const start = encoding === 'utf-32' ? 4 : 0;
        let out = '';
        for (let i = start; i + 4 <= data.length; i += 4) {
          const code = little
            ? data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) |
              (data[i + 3] << 24)
            : (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) |
              data[i + 3];
          out += String.fromCodePoint(code >>> 0);
        }
        return out;
      }
      case 'utf-16':
      case 'utf-16-le':
      case 'utf-16-be': {
        const label =
          encoding === 'utf-16-be'
            ? 'utf-16be'
            : encoding === 'utf-16-le'
              ? 'utf-16le'
              : data[0] === 0xfe
                ? 'utf-16be'
                : 'utf-16le';
        return new TextDecoder(label, { fatal: true }).decode(
          data.subarray(encoding === 'utf-16' ? 2 : 0),
        );
      }
      case 'utf-8-sig':
        return pyDecodeUtf8(data.subarray(3));
      default:
        return pyDecodeUtf8(data);
    }
  } catch (error) {
    if (error instanceof UnicodeDecodeError) throw error;
    const renamed = new UnicodeDecodeError(
      `'${encoding}' codec can't decode bytes: ${String(error)}`,
    );
    throw renamed;
  }
}

/** `json.loads(bytes)` — encoding-detected like CPython's decoder. */
function jsonLoadsBytes(data: Uint8Array): unknown {
  const text = decodeBytes(data, detectJsonEncoding(data));
  return jsonLoads(text);
}

// --- Filesystem helpers ---------------------------------------------------------

const OS_ERRNO: Record<string, [number, string]> = {
  ENOENT: [2, 'No such file or directory'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  EEXIST: [17, 'File exists'],
  EACCES: [13, 'Permission denied'],
  EPERM: [1, 'Operation not permitted'],
  ELOOP: [40, 'Too many levels of symbolic links'],
  ENAMETOOLONG: [36, 'File name too long'],
};

/** `str(OSError)` for a Node errno error. */
function pyOsError(error: unknown): Error {
  const errno = error as NodeJS.ErrnoException;
  const pair = errno?.code !== undefined ? OS_ERRNO[errno.code] : undefined;
  if (pair === undefined) return error as Error;
  const [number, strerror] = pair;
  const suffix = errno?.path !== undefined ? `: '${errno.path}'` : '';
  const renamed = new Error(`[Errno ${number}] ${strerror}${suffix}`);
  renamed.name = osErrorName(error);
  return renamed;
}

/** Wrap a Node errno error in the CPython `OSError` text. */
function tryFs<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw pyOsError(error);
  }
}

/**
 * `Path(path).read_text()` where Python lets the `OSError` propagate —
 * like `readText`, but the raw `readFileSync` errno error reaches
 * `pyOsError` with its code/path, so `str(error)` keeps CPython's
 * `[Errno N]` wording. `readText`'s rename drops both fields.
 */
function readTextErrno(path: string): string {
  let text: string;
  try {
    text = pyDecodeUtf8(readFileSync(path));
  } catch (error) {
    if (error instanceof UnicodeDecodeError) throw error;
    throw pyOsError(error);
  }
  return text.replace(/\r\n?/g, '\n');
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSym(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `error` lands in Python's `except (ValueError, OSError)`. */
function isValueOrOSError(error: unknown): boolean {
  const named = error as Error | undefined;
  return (
    error instanceof ValueError ||
    named?.name === 'UnicodeDecodeError' ||
    named?.name === 'OSError' ||
    named?.name === 'FileNotFoundError' ||
    named?.name === 'NotADirectoryError' ||
    named?.name === 'IsADirectoryError' ||
    named?.name === 'FileExistsError' ||
    named?.name === 'PermissionError'
  );
}

/** `str(error)` for embedding in diagnostic messages. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- PurePosixPath subset --------------------------------------------------------

function purePath(value: string): {
  absolute: boolean;
  parts: string[];
  asPosix: string;
} {
  const absolute = value.startsWith('/');
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  let asPosix = (absolute ? '/' : '') + parts.join('/');
  if (asPosix === '') asPosix = absolute ? '/' : '.';
  return { absolute, parts, asPosix };
}

// --- Port ------------------------------------------------------------------------

function git(root: string, args: string[]): string {
  const result = runGit(root, args);
  if (result.status) {
    throw new ValueError(
      pyStrip(result.stderr) || `git ${args.join(' ')} failed`,
    );
  }
  return pyStrip(result.stdout);
}

export function relative_path(relative_: unknown): string[] {
  if (
    typeof relative_ !== 'string' ||
    relative_ === '' ||
    [...relative_].some((c) => c.codePointAt(0)! < 32)
  ) {
    throw new ValueError(`Invalid relative path: ${pyRepr(relative_)}`);
  }
  const path = purePath(relative_);
  if (
    path.absolute ||
    path.parts.length === 0 ||
    path.parts.includes('..') ||
    path.asPosix !== relative_
  ) {
    throw new ValueError(`Unsafe or non-normalized path: ${relative_}`);
  }
  return path.parts;
}

export function safe_path(
  root: string,
  relative_: unknown,
  options: { allowMissing?: boolean; allowLeafSymlink?: boolean } = {},
): string {
  const { allowMissing = false, allowLeafSymlink = false } = options;
  const parts = relative_path(relative_);
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index]);
    if (
      isSym(cursor) &&
      !(allowLeafSymlink && index === parts.length - 1)
    ) {
      throw new ValueError(`Symlink path is not allowed: ${cursor}`);
    }
    if (index < parts.length - 1 && existsSync(cursor) && !isDir(cursor)) {
      throw new ValueError(`Parent path is not a directory: ${cursor}`);
    }
  }
  if (!allowMissing && !existsSync(cursor)) {
    throw new ValueError(`Missing path: ${cursor}`);
  }
  return cursor;
}

export function validate_config(data: unknown): Dict {
  const keys = isDict(data) ? new Set(dictKeys(data)) : new Set<string>();
  const exact = (wanted: Set<string>) =>
    keys.size === wanted.size && [...wanted].every((k) => keys.has(k));
  const choice = isDict(data) ? dictGetOr(data, 'choice', null) : null;
  if (
    !isDict(data) ||
    (!exact(REQUIRED_SET) && !exact(LEGACY_SET)) ||
    (choice !== 'enabled' && choice !== 'declined')
  ) {
    throw new ValueError(
      `${CONFIG} must declare exactly ` +
        `['base', 'choice', 'library', 'memory', 'profiles'] ` +
        `(a legacy skills array is ignored) and an enabled/declined choice`,
    );
  }
  if (choice === 'declined') return data;
  // Validate every selected input before recording a choice or preparing
  // assets.
  relative_path(dictGet(data, 'library'));
  const base = dictGet(data, 'base');
  if (
    typeof base !== 'string' ||
    base === '' ||
    base.startsWith('-')
  ) {
    throw new ValueError(
      'Enabled configuration needs an explicit base ref or commit',
    );
  }
  const profiles = dictGet(data, 'profiles');
  if (!Array.isArray(profiles)) {
    throw new ValueError('profiles must be an explicit array');
  }
  for (const name of profiles) {
    const last = typeof name === 'string' ? basename(name) : name;
    if (
      typeof name !== 'string' ||
      name === '' ||
      last !== name ||
      !name.endsWith('.toml')
    ) {
      throw new ValueError(`Invalid selected profile: ${pyRepr(name)}`);
    }
  }
  if (profiles.length !== new Set(profiles).size) {
    throw new ValueError('Duplicate selected profile');
  }
  const memory = dictGet(data, 'memory');
  const memoryKeys = isDict(memory) ? new Set(dictKeys(memory)) : new Set();
  const memoryOk =
    (memoryKeys.size === 1 && memoryKeys.has('routing_source')) ||
    (memoryKeys.size === 2 &&
      memoryKeys.has('enabled') &&
      memoryKeys.has('routing_source'));
  if (!isDict(memory) || !memoryOk) {
    throw new ValueError(
      'memory must declare routing_source (a legacy enabled boolean is tolerated)',
    );
  }
  if (
    dictHas(memory, 'enabled') &&
    typeof dictGet(memory, 'enabled') !== 'boolean'
  ) {
    throw new ValueError('memory enabled must be a boolean');
  }
  if (dictGet(memory, 'routing_source') !== null) {
    relative_path(dictGet(memory, 'routing_source'));
  }
  if (
    dictGetOr(memory, 'enabled', undefined) === false &&
    dictGet(memory, 'routing_source') !== null
  ) {
    throw new ValueError(
      'Memory-disabled configuration must set routing_source to null',
    );
  }
  return data;
}

export function load(root: string): Dict {
  const path = safe_path(root, CONFIG);
  if (!isFile(path)) {
    throw new ValueError(
      `Missing or unsafe ${CONFIG}; make an explicit T3 choice first`,
    );
  }
  return validate_config(jsonLoads(readTextErrno(path)));
}

function check_base(root: string, data: Dict): void {
  if (pyResolve(git(root, ['rev-parse', '--show-toplevel'])) !== root) {
    throw new ValueError('Use the active consumer worktree root');
  }
  const base = dictGet(data, 'base') as string;
  try {
    const resolved = git(root, [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${base}^{commit}`,
    ]);
    git(root, ['merge-base', '--is-ancestor', resolved, 'HEAD']);
  } catch (error) {
    if (error instanceof ValueError) {
      throw new ValueError(
        `Expected base ${pyStrRepr(base)} is unavailable or not an ancestor; ` +
          'review local/remote or stack base',
      );
    }
    throw error;
  }
}

export function pinned_library(root: string, data: Dict): string {
  const library = safe_path(root, dictGet(data, 'library'));
  const modules = safe_path(root, '.gitmodules');
  if (!isFile(modules)) {
    throw new ValueError('Missing consumer .gitmodules');
  }
  for (const args of [
    ['diff', '--quiet', '--', '.gitmodules'],
    ['diff', '--cached', '--quiet', 'HEAD', '--', '.gitmodules'],
  ]) {
    git(root, args);
  }
  const rel = dictGet(data, 'library') as string;
  const entries = git(root, ['ls-files', '-s', '-z', '--', rel])
    .split('\0')
    .filter((line) => line !== '');
  const headEntries = git(root, ['ls-tree', '-z', 'HEAD', '--', rel])
    .split('\0')
    .filter((line) => line !== '');
  if (entries.length !== 1 || headEntries.length !== 1) {
    throw new ValueError(
      "Declared library must be the checkout's tracked gitlink",
    );
  }
  const tab1 = entries[0].indexOf('\t');
  const tab2 = headEntries[0].indexOf('\t');
  if (tab1 < 0 || tab2 < 0) {
    throw new ValueError('not enough values to unpack (expected 2, got 1)');
  }
  const indexInfo = entries[0].slice(0, tab1);
  const indexPath = entries[0].slice(tab1 + 1);
  const headInfo = headEntries[0].slice(0, tab2);
  const headPath = headEntries[0].slice(tab2 + 1);
  if (
    pySplit(indexInfo)[0] !== '160000' ||
    pySplit(headInfo)[0] !== '160000' ||
    pySplit(indexInfo)[2] !== '0' ||
    indexPath !== rel ||
    headPath !== rel
  ) {
    throw new ValueError(
      'Declared library must be a committed, unconflicted gitlink',
    );
  }
  const pin = pySplit(headInfo)[2];
  if (pySplit(indexInfo)[1] !== pin) {
    throw new ValueError(
      'Library index pin differs from committed HEAD; review the pin',
    );
  }
  if (
    !existsSync(join(library, '.git')) ||
    pyResolve(git(library, ['rev-parse', '--show-toplevel'])) !== library
  ) {
    throw new ValueError(
      'Declared library is uninitialized; run the generated root bootstrap',
    );
  }
  if (git(library, ['rev-parse', 'HEAD']) !== pin) {
    throw new ValueError(
      'Library HEAD differs from the committed gitlink; preserve and review',
    );
  }
  if (git(library, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new ValueError(
      'Pinned library is dirty; preserve and review local changes',
    );
  }
  // Also reject unresolved pins elsewhere; never repair another submodule
  // implicitly.
  const status = runGit(root, ['submodule', 'status', '--recursive']);
  if (
    status.status ||
    pySplitlines(status.stdout).some((line) =>
      ['-', '+', 'U'].includes(line.slice(0, 1)),
    )
  ) {
    throw new ValueError(
      'A pinned submodule is uninitialized, mismatched or conflicted; ' +
        'review the declared pins',
    );
  }
  return library;
}

type HelperModule = Record<string, unknown>;

/**
 * `load_helper(library, name)` — the pinned `scripts/<stem>.ts` module.
 * `name` stays the Python filename so call sites match the Python port; a
 * pin carrying only `scripts/<name>` is a caught `ValueError` naming the
 * needed migration, never an uncaught exception or a traceback.
 */
async function load_helper(
  library: string,
  name: string,
): Promise<HelperModule> {
  const stem = name.replace(/\.py$/, '');
  const tsCandidate = safe_path(library, `scripts/${stem}.ts`, {
    allowMissing: true,
  });
  if (!existsSync(tsCandidate)) {
    // Raises `Missing path:` for a missing helper or the same safe_path
    // diagnostics for an unsafe `.py` file.
    safe_path(library, `scripts/${name}`);
    throw new ValueError(
      `Pinned ${name} needs migration to ${stem}.ts`,
    );
  }
  if (!isFile(tsCandidate)) {
    const renamed = new Error(
      `[Errno 21] Is a directory: '${tsCandidate}'`,
    );
    renamed.name = 'IsADirectoryError';
    throw renamed;
  }
  return (await import(pathToFileURL(tsCandidate).href)) as HelperModule;
}

function installer(library: string): Promise<HelperModule> {
  return load_helper(library, 'install.py');
}

/**
 * `json.dumps(value, indent=2)` — the sibling `memory_connections.ts`
 * resolved lazily through the `load_helper` checks. A serializing path on
 * a pin missing the helper reports `Missing path:` or the needed migration
 * instead of `ERR_MODULE_NOT_FOUND`; a `--check` that never serializes
 * never evaluates the import.
 */
async function jsonDumps(value: unknown): Promise<string> {
  const pin = dirname(dirname(fileURLToPath(import.meta.url)));
  const module = await load_helper(pin, 'memory_connections.py');
  if (typeof module.jsonDumps !== 'function') {
    throw new ValueError(
      'Pinned memory_connections.ts lacks jsonDumps; review the library pin',
    );
  }
  return (module.jsonDumps as (member: unknown) => string)(value);
}

/**
 * Load the pinned `setup_memory.ts` for shared generated-routing checks.
 * The pinned `setup_memory.ts` resolves `memory_connections.ts` itself at
 * import time; loading that helper first reports a `.py`-only pin as a
 * needed migration and a pin missing both files as the `safe_path`
 * missing-path error, never a module resolution crash.
 */
async function memory_helper(
  library: string,
  install: HelperModule,
): Promise<HelperModule> {
  void install;
  // The pinned `setup_memory.ts` resolves `memory_connections.ts` at
  // import time; loading it through the helper path first reports a
  // missing or Python-only pin as a caught `ValueError`, never a module
  // resolution crash.
  await load_helper(library, 'memory_connections.py');
  const module = await load_helper(library, 'setup_memory.py');
  if (typeof module.expected_instructions !== 'function') {
    throw new ValueError(
      'Pinned setup_memory.py cannot classify generated routing; ' +
        'review the library pin',
    );
  }
  return module;
}

type WriteEntry = [string, 'link' | 'file', string | Buffer];

/**
 * Preflight the complete derived toolkit; return only missing asset writes.
 */
async function prerequisites(
  root: string,
  data: Dict,
  allowMissing = false,
): Promise<[string, WriteEntry[]]> {
  check_base(root, data);
  const library = pinned_library(root, data);
  const install = await installer(library);
  const instructions = safe_path(root, 'AGENTS.md');
  if (!isFile(instructions)) {
    throw new ValueError('Missing consumer AGENTS.md');
  }
  // The installer's capabilities file is the only record of the Basic Memory
  // choice; the T3 configuration carries preparation mechanics only. An
  // unknown choice cannot derive the expected toolkit, so refuse it.
  const recorded = (
    install.read_capabilities as (project: string) => string | null
  )(root);
  if (recorded === null) {
    throw new ValueError(
      `Memory choice not recorded in ${install.CAPABILITIES_FILE};` +
        ' record it with node .agent-workflows/bin/agent-workflows.ts' +
        ' install --memory enabled or --memory declined' +
        ' before T3 preparation',
    );
  }
  const enabled = recorded === 'enabled';
  const legacyEnabled = dictGetOr(
    dictGet(data, 'memory') as Dict,
    'enabled',
    null,
  );
  if (legacyEnabled !== null && legacyEnabled !== enabled) {
    throw new ValueError(
      `Legacy memory enabled flag in ${CONFIG} conflicts with the` +
        ` recorded choice in ${install.CAPABILITIES_FILE}; review the choice`,
    );
  }
  const [installedNames, referenceNames] = (
    install.toolkit as (source: string, memory?: boolean) => [string[], string[]]
  )(library, enabled);
  const writes: WriteEntry[] = [];
  for (const name of installedNames) {
    const src = safe_path(library, `.agents/skills/${name}`);
    if (!isFile(join(src, 'SKILL.md'))) {
      throw new ValueError(`Pinned skill metadata missing: ${name}`);
    }
    const dest = safe_path(root, `.agents/skills/${name}`, {
      allowMissing: true,
      allowLeafSymlink: true,
    });
    if (isSym(dest)) {
      if (!existsSync(dest) || pyResolve(dest) !== src) {
        throw new ValueError(
          `Selected skill link points to the wrong source: ${dest}`,
        );
      }
    } else if (existsSync(dest)) {
      throw new ValueError(
        `Local skill override: ${dest}; exclude it from the managed selection`,
      );
    } else {
      writes.push([dest, 'link', src]);
    }
  }
  if (referenceNames.length) {
    // The installer owns this format; do not duplicate its managed template.
    const block = (
      install.reference_block as (
        source: string,
        project: string,
        names: string[],
      ) => string
    )(library, root, pySortedStrings(referenceNames));
    if (!readTextErrno(instructions).includes(block)) {
      throw new ValueError(
        'Reference-only pointer differs; review AGENTS.md using the normal installer',
      );
    }
  }
  for (const name of dictGet(data, 'profiles') as string[]) {
    const src = safe_path(library, `.codex/agents/${name}`);
    if (!isFile(src)) {
      throw new ValueError(`Pinned profile missing: ${name}`);
    }
    const dest = safe_path(root, `.codex/agents/${name}`, {
      allowMissing: true,
      allowLeafSymlink: true,
    });
    if (isSym(dest)) {
      if (!existsSync(dest) || pyResolve(dest) !== src) {
        throw new ValueError(
          `Selected profile link points to the wrong source: ${dest}`,
        );
      }
    } else if (existsSync(dest)) {
      if (!isFile(dest)) {
        throw new ValueError(
          `Selected profile conflicts with a non-file: ${dest}`,
        );
      }
      // Regular local profile overrides are explicitly preserved.
    } else {
      writes.push([dest, 'link', src]);
    }
  }
  if (enabled) {
    const target = safe_path(root, '.agents/memory/config.md', {
      allowMissing: true,
    });
    const sourceName = dictGet(
      dictGet(data, 'memory') as Dict,
      'routing_source',
    ) as string | null;
    let content: Buffer | null = null;
    if (sourceName !== null) {
      const source = safe_path(root, sourceName, { allowMissing: true });
      const reconcile = (
        install.repair_command as (
          source: string,
          project: string,
          script?: string,
          options?: string[],
        ) => string
      )(library, root, 't3_readiness.py', ['--reconcile-routing-source']);
      if (!existsSync(source)) {
        let remedy: string;
        if (existsSync(target)) {
          remedy =
            'repair from the consumer root: ' +
            `\`${reconcile}\`; it` +
            ' writes the tracked source with the current' +
            ' generated routing bytes';
        } else {
          const memoryRepair = (
            install.repair_command as (
              source: string,
              project: string,
              script?: string,
              options?: string[],
            ) => string
          )(library, root, 'setup_memory.py');
          remedy =
            'restore the generated routing first with' +
            ` \`${memoryRepair}\` (reviewed --portable input` +
            ' when routing is unconfigured), then reconcile';
        }
        throw new ValueError(
          `Routing source ${sourceName} recorded in ${CONFIG}` +
            ' memory.routing_source is missing;' +
            ` ${remedy}`,
        );
      }
      if (source === target) {
        throw new ValueError(
          `Routing source ${sourceName} recorded in ${CONFIG}` +
            ' memory.routing_source conflicts with the generated destination;' +
            ` repair from the consumer root: \`${reconcile}\``,
        );
      }
      if (!isFile(source)) {
        throw new ValueError(
          `Routing source ${sourceName} recorded in ${CONFIG}` +
            ' memory.routing_source must be a separate, reviewed' +
            ' non-secret file',
        );
      }
      content = tryFs(() => readFileSync(source));
    }
    if (existsSync(target)) {
      if (!isFile(target)) {
        throw new ValueError('Memory routing conflicts with a non-file');
      }
      if (
        content !== null &&
        !tryFs(() => readFileSync(target)).equals(content)
      ) {
        const reconcile = (
          install.repair_command as (
            source: string,
            project: string,
            script?: string,
            options?: string[],
          ) => string
        )(library, root, 't3_readiness.py', ['--reconcile-routing-source']);
        throw new ValueError(
          'Generated routing .agents/memory/config.md differs from' +
            ` source ${sourceName} recorded in ${CONFIG}` +
            ' memory.routing_source; repair from the consumer root:' +
            ` \`${reconcile}\`; it rewrites the tracked source with the` +
            ' generated bytes and refuses customized generated' +
            ' routing, which stays reviewed setup_memory territory',
        );
      }
    } else if (content === null) {
      throw new ValueError(
        'Memory routing missing and memory.routing_source is null in' +
          ` ${CONFIG}; declare an explicit reviewed non-secret` +
          ' routing_source (see docs/t3-checkout-readiness.md)',
      );
    } else {
      writes.push([target, 'file', content]);
    }
  }
  if (writes.length && !allowMissing) {
    throw new ValueError(
      `Declared prerequisite missing: ${relative(root, writes[0][0])}; ` +
        'run the generated launcher or --prepare',
    );
  }
  return [library, writes];
}

export function action(): Dict {
  const command = `node ${BOOTSTRAP_MJS}`;
  return new Map<string, unknown>([
    ['id', ACTION_ID],
    ['name', 'Agent workflows checkout readiness'],
    ['command', command],
    ['icon', 'configure'],
    ['runOnWorktreeCreate', true],
    ['runOnSettle', false],
    ['async', false],
  ]);
}

/**
 * Whether a t3.json script entry is the managed readiness action still
 * carrying the Python-era launcher command — the exact entry
 * ``--configure-action`` rewrites in place. An unrelated script that
 * happens to use the same command does not qualify.
 */
export function python_era_action(item: unknown): boolean {
  if (!isDict(item)) return false;
  const expected = action();
  return (
    dictGetOr(item as Dict, 'command', null) === `python3 ${BOOTSTRAP}` &&
    pyEq(
      dictSpread(item as Dict, 'command', dictGet(expected, 'command')),
      expected,
    )
  );
}

function validate_t3(data: unknown): void {
  /** Validate known fields of the T3 0.1.2 t3ProjectFile contract.

    Unknown fields are retained, like T3's forward-compatible object
    decoding. Source: packages/contracts/src/t3ProjectFile.ts at tag
    v0.1.2. */
  if (!isDict(data)) {
    throw new ValueError('t3.json must be an object');
  }
  if (dictHas(data, '$schema') && typeof dictGet(data, '$schema') !== 'string') {
    throw new ValueError('t3.json $schema must be a string');
  }
  if (dictHas(data, 'iconPath')) {
    const value = dictGet(data, 'iconPath');
    if (
      typeof value !== 'string' ||
      pyStrip(value) === '' ||
      value.length > 512
    ) {
      throw new ValueError(
        't3.json iconPath must be a nonempty string of at most 512 characters',
      );
    }
  }
  for (const [field, choices] of [
    ['defaultThreadEnvMode', ['local', 'worktree']],
    ['worktreeSubmodules', ['recursive', 'top-level', 'none']],
  ] as [string, string[]][]) {
    if (dictHas(data, field) && !choices.includes(dictGet(data, field) as string)) {
      throw new ValueError(
        `t3.json ${field} must be one of ('${choices.join("', '")}')`,
      );
    }
  }
  const scripts = dictGetOr(data, 'scripts', []);
  if (!Array.isArray(scripts) || scripts.length > 50) {
    throw new ValueError(
      't3.json scripts must be an array of at most 50 scripts',
    );
  }
  for (const item of scripts) {
    if (!isDict(item)) {
      throw new ValueError('t3.json scripts must contain objects');
    }
    for (const field of ['name', 'command']) {
      const value = dictGetOr(item, field, null);
      if (typeof value !== 'string' || pyStrip(value) === '') {
        throw new ValueError(
          `Every t3.json script requires a nonempty ${field}`,
        );
      }
    }
    if (
      dictHas(item, 'icon') &&
      !['play', 'test', 'lint', 'configure', 'build', 'debug'].includes(
        dictGet(item, 'icon') as string,
      )
    ) {
      throw new ValueError('Invalid t3.json script icon');
    }
    for (const field of [
      'runOnWorktreeCreate',
      'runOnSettle',
      'async',
      'autoOpenPreview',
    ]) {
      if (dictHas(item, field) && typeof dictGet(item, field) !== 'boolean') {
        throw new ValueError(`t3.json script ${field} must be a boolean`);
      }
    }
    if (
      dictHas(item, 'previewUrl') &&
      (typeof dictGet(item, 'previewUrl') !== 'string' ||
        pyStrip(dictGet(item, 'previewUrl') as string) === '')
    ) {
      throw new ValueError(
        't3.json script previewUrl must be a nonempty string',
      );
    }
  }
}

type Plan = [string, Buffer | null, Buffer | null];

async function action_plan(root: string): Promise<Plan> {
  const path = safe_path(root, 't3.json', { allowMissing: true });
  const previous = existsSync(path) ? tryFs(() => readFileSync(path)) : null;
  const current = previous !== null ? jsonLoadsBytes(previous) : new Map();
  validate_t3(current);
  const scripts = dictGetOr(current as Dict, 'scripts', []);
  if (
    Array.isArray(scripts) &&
    scripts.some((item) => !isDict(item))
  ) {
    throw new ValueError('t3.json scripts must contain objects');
  }
  const expected = action();
  const matches: Dict[] = [];
  for (const item of Array.isArray(scripts) ? scripts : []) {
    for (const key of ['id', 'name', 'command']) {
      if (dictHas(item as Dict, key) && typeof dictGet(item as Dict, key) !== 'string') {
        throw new ValueError(`Invalid t3.json script ${key}`);
      }
    }
    if (
      dictGetOr(item as Dict, 'id', null) === ACTION_ID ||
      pyCasefold(pyStrip(String(dictGetOr(item as Dict, 'name', '')))) ===
        pyCasefold(dictGet(expected, 'name') as string) ||
      pyStrip(String(dictGetOr(item as Dict, 'command', ''))) ===
        dictGet(expected, 'command') ||
      dictGetOr(item as Dict, 'runOnWorktreeCreate', null) === true
    ) {
      matches.push(item as Dict);
    }
  }
  // A consumer may explicitly compose additional setup after the bootstrap.
  // Preserve its bytes; do not execute or claim to validate the appended work.
  if (matches.length === 1) {
    const candidate = matches[0];
    let tokens: string[];
    try {
      tokens = shlexSplit(String(dictGetOr(candidate, 'command', '')));
    } catch (error) {
      if (error instanceof ValueError) tokens = [];
      else throw error;
    }
    const prefix = shlexSplit(dictGet(expected, 'command') as string);
    const composed =
      prefix.every((token, i) => tokens[i] === token) &&
      tokens.length > prefix.length + 1 &&
      tokens[prefix.length] === '&&';
    if (
      composed &&
      pyEq(
        dictSpread(candidate, 'command', dictGet(expected, 'command')),
        expected,
      )
    ) {
      return [path, previous, previous];
    }
  }
  // An exact Python-era action is updated in place — the generated
  // `.mjs` command replaces `python3 .agent-workflows-t3.py`.
  if (matches.length === 1) {
    const item = matches[0];
    if (
      dictGetOr(item, 'command', null) === `python3 ${BOOTSTRAP}` &&
      pyEq(dictSpread(item, 'command', dictGet(expected, 'command')), expected)
    ) {
      const updated = dictSpread(
        item,
        'command',
        dictGet(expected, 'command'),
      );
      const next = dictSpread(
        current as Dict,
        'scripts',
        (scripts as unknown[]).map((entry) =>
          entry === item ? updated : entry,
        ),
      );
      validate_t3(next);
      return [
        path,
        previous,
        Buffer.from(`${await jsonDumps(next)}\n`, 'utf8'),
      ];
    }
  }
  if (matches.length && !pyEq(matches, [expected])) {
    throw new ValueError(
      'Existing action identity, command or creation role conflicts; ' +
        'review and compose explicitly',
    );
  }
  if (matches.length) {
    return [path, previous, previous];
  }
  dictSet(current as Dict, 'scripts', [
    ...(scripts as unknown[]),
    expected,
  ]);
  validate_t3(current);
  return [
    path,
    previous,
    Buffer.from(`${await jsonDumps(current)}\n`, 'utf8'),
  ];
}

async function generated_plan(
  root: string,
  library: string,
): Promise<Plan[]> {
  const templateName = 'scripts/t3_bootstrap.mjs';
  const templateCandidate = safe_path(library, templateName, {
    allowMissing: true,
  });
  let template: Buffer;
  if (isFile(templateCandidate)) {
    template = tryFs(() => readFileSync(templateCandidate));
  } else if (isFile(join(library, 'scripts/t3_bootstrap.py'))) {
    throw new ValueError(
      'Pinned t3_bootstrap.py needs migration to t3_bootstrap.mjs',
    );
  } else {
    template = tryFs(() => readFileSync(safe_path(library, templateName)));
  }
  const target = safe_path(root, BOOTSTRAP_MJS, { allowMissing: true });
  const previous = existsSync(target)
    ? tryFs(() => readFileSync(target))
    : null;
  if (previous !== null && !previous.equals(template)) {
    throw new ValueError(
      'Generated root launcher is customized or stale; preserve and ' +
        'review an explicit refresh',
    );
  }
  return [[target, previous, template], await action_plan(root)];
}

export async function check_action(
  root: string,
  library?: string,
): Promise<void> {
  const data = load(root);
  if (dictGet(data, 'choice') === 'declined') return;
  const resolved = library || pinned_library(root, data);
  for (const [path, previous, expected] of await generated_plan(
    root,
    resolved,
  )) {
    if (
      previous === null ||
      expected === null ||
      !previous.equals(expected)
    ) {
      // The Python-era bootstrap is recognized, not broken: report the
      // explicit migration, never a missing/corrupt file or a traceback.
      if (
        basename(path) === BOOTSTRAP_MJS &&
        existsSync(join(root, BOOTSTRAP))
      ) {
        throw new ValueError(
          `Generated bootstrap ${BOOTSTRAP} needs migration to ${BOOTSTRAP_MJS}`,
        );
      }
      throw new ValueError(
        `Generated asset missing: ${basename(path)}; run --configure-action`,
      );
    }
  }
}

function create_missing(root: string, writes: WriteEntry[]): void {
  for (const [dest, kind, content] of writes) {
    const rel = relative(root, dest);
    safe_path(root, rel, { allowMissing: true });
    mkdirSync(dirname(dest), { recursive: true });
    safe_path(root, rel, { allowMissing: true });
    if (kind === 'link') {
      tryFs(() =>
        symlinkSync(relative(dirname(dest), content as string), dest),
      );
    } else {
      // Exclusive creation refuses a late-arriving file or dangling symlink.
      tryFs(() => writeFileSync(dest, content as Buffer, { flag: 'wx' }));
    }
  }
}

/**
 * Atomically replace a file with an optimistic unchanged-content check.
 */
function replace_bytes(
  root: string,
  path: string,
  previous: Buffer | null,
  expected: Buffer,
): void {
  const current = tryFs(() => readFileSync(path));
  if (previous === null || !current.equals(previous)) {
    throw new ValueError(`${basename(path)} changed before writing; review and retry`);
  }
  const temporary = join(
    root,
    `.t3-readiness-${randomBytes(8).toString('hex')}`,
  );
  try {
    const handle = tryFs(() => openSync(temporary, 'wx', 0o600));
    try {
      writeSync(handle, expected);
    } finally {
      closeSync(handle);
    }
    tryFs(() => renameSync(temporary, path));
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // missing_ok=True
    }
  }
}

export async function assess(root: string): Promise<string[]> {
  const resolved = pyResolve(root);
  const data = load(resolved);
  if (dictGet(data, 'choice') === 'declined') {
    return [
      'T3 readiness declined; no T3 configuration or connectivity required',
    ];
  }
  await prerequisites(resolved, data);
  return [
    'Checkout prerequisites ready; action registration, execution, ' +
      'discovery and MCP are separate observations',
  ];
}

export async function configure(root: string): Promise<void> {
  const resolved = pyResolve(root);
  const data = load(resolved);
  if (dictGet(data, 'choice') !== 'enabled') {
    throw new ValueError('Action configuration requires enabled T3 readiness');
  }
  const [library] = await prerequisites(resolved, data, true);
  const plans = await generated_plan(resolved, library);
  // Capture every baseline and preflight every conflict before writing
  // either asset.
  for (const [path, previous] of plans) {
    safe_path(resolved, relative(resolved, path), { allowMissing: true });
    const now = existsSync(path) ? tryFs(() => readFileSync(path)) : null;
    if (
      (now === null) !== (previous === null) ||
      (now !== null && previous !== null && !now.equals(previous))
    ) {
      throw new ValueError(
        `${basename(path)} changed during preflight; review and retry`,
      );
    }
  }
  for (const [path, previous, expected] of plans) {
    if (
      previous !== null &&
      expected !== null &&
      previous.equals(expected)
    ) {
      continue;
    }
    if (previous === null) {
      create_missing(resolved, [[path, 'file', expected as Buffer]]);
    } else {
      // Preserve unrelated t3.json data, with a final optimistic change
      // check.
      replace_bytes(resolved, path, previous, expected as Buffer);
    }
  }
}

export async function restore_missing(root: string): Promise<void> {
  const resolved = pyResolve(root);
  const data = load(resolved);
  if (dictGet(data, 'choice') !== 'enabled') {
    throw new ValueError('Preparation requires enabled T3 readiness');
  }
  const [library, writes] = await prerequisites(resolved, data, true);
  await check_action(resolved, library);
  create_missing(resolved, writes);
  await assess(resolved);
}

export function source_must_move(root: string, source: string[]): boolean {
  /** Whether the recorded source path cannot hold the tracked routing copy. */
  const name = source.join('/');
  if (RESERVED_ROUTING_PATHS.has(name)) return true;
  const result = runGit(root, ['check-ignore', '-q', '--', name]);
  return result.status !== 1;
}

export async function routing_source_status(
  root: string,
): Promise<string[]> {
  /** Read-only drift check of the recorded routing source; never writes. */
  const resolved = pyResolve(root);
  if (!isFile(join(resolved, CONFIG))) {
    return [`No ${CONFIG}; routing-source check not applicable`];
  }
  const data = load(resolved);
  if (dictGet(data, 'choice') !== 'enabled') {
    return ['T3 readiness declined; routing-source check not applicable'];
  }
  let library: string;
  try {
    library = pinned_library(resolved, data);
  } catch (error) {
    if (error instanceof ValueError) {
      throw new ValueError(
        `Declared library ${dictGet(data, 'library')} is unavailable for the` +
          ` routing-source check: ${error.message}`,
      );
    }
    throw error;
  }
  const install = await installer(library);
  const recorded = (
    install.read_capabilities as (project: string) => string | null
  )(resolved);
  if (recorded !== 'enabled') {
    return [
      'Basic Memory is not enabled in the recorded choice;' +
        ' routing-source check not applicable',
    ];
  }
  const reconcile = (
    install.repair_command as (
      source: string,
      project: string,
      script?: string,
      options?: string[],
    ) => string
  )(library, resolved, 't3_readiness.py', ['--reconcile-routing-source']);
  const memoryRepair = (
    install.repair_command as (
      source: string,
      project: string,
      script?: string,
      options?: string[],
    ) => string
  )(library, resolved, 'setup_memory.py');
  const [, state] = await (
    (await memory_helper(library, install)).expected_instructions as (
      project: string,
    ) => [string, string]
  )(resolved);
  if (state === 'missing') {
    throw new ValueError(
      'Generated routing .agents/memory/config.md is absent; restore it' +
        ` first with \`${memoryRepair}\` (reviewed --portable input when` +
        ' routing is unconfigured) before reconciling the recorded source',
    );
  }
  if (state === 'stale') {
    throw new ValueError(
      'Generated routing .agents/memory/config.md is stale; refresh it' +
        ` first with \`${memoryRepair}\``,
    );
  }
  if (state === 'customized') {
    throw new ValueError(
      'Generated routing .agents/memory/config.md is customized;' +
        ' preserve and review an explicit edit before reconciling the' +
        ' recorded source',
    );
  }
  const generated = tryFs(() =>
    readFileSync(safe_path(resolved, '.agents/memory/config.md')),
  );
  const sourceName = dictGet(
    dictGet(data, 'memory') as Dict,
    'routing_source',
  ) as string | null;
  if (sourceName === null) {
    throw new ValueError(
      `memory.routing_source is null in ${CONFIG}; fresh checkouts` +
        ' cannot restore .agents/memory/config.md. Declaring a reviewed' +
        ' non-secret routing_source is an explicit setup choice (see' +
        ' docs/t3-checkout-readiness.md), never implicit reconciliation',
    );
  }
  const source = safe_path(resolved, sourceName, { allowMissing: true });
  if (existsSync(source) && !isFile(source)) {
    throw new ValueError(
      `Routing source ${sourceName} recorded in ${CONFIG}` +
        ' memory.routing_source is not a file; preserve and review',
    );
  }
  const drift: string[] = [];
  if (source_must_move(resolved, relative_path(sourceName))) {
    drift.push('the recorded path cannot hold the tracked routing copy');
  }
  if (!existsSync(source)) {
    drift.push('the named file is missing');
  } else if (!tryFs(() => readFileSync(source)).equals(generated)) {
    drift.push('the named file differs from .agents/memory/config.md');
  }
  if (drift.length) {
    throw new ValueError(
      `Routing source ${sourceName} recorded in ${CONFIG}` +
        ` memory.routing_source drifted: ${drift.join('; ')}; repair from` +
        ` the consumer root: \`${reconcile}\`; it writes the exact generated` +
        ' routing bytes and repoints the manifest only when the path must' +
        ' move',
    );
  }
  return [
    `Routing source ${sourceName} matches .agents/memory/config.md;` +
      ' no reconciliation needed',
  ];
}

export async function reconcile_routing_source(
  root: string,
): Promise<string[]> {
  /** Reconcile manifest, tracked source and generated routing explicitly. */
  const resolved = pyResolve(root);
  const data = load(resolved);
  if (dictGet(data, 'choice') !== 'enabled') {
    throw new ValueError(
      'Routing-source reconciliation requires enabled T3 readiness',
    );
  }
  const library = pinned_library(resolved, data);
  const install = await installer(library);
  const recorded = (
    install.read_capabilities as (project: string) => string | null
  )(resolved);
  if (recorded === null) {
    throw new ValueError(
      `Memory choice not recorded in ${install.CAPABILITIES_FILE};` +
        ' record it before reconciling a routing source',
    );
  }
  if (recorded !== 'enabled') {
    throw new ValueError(
      'Basic Memory is declined in the recorded choice; there is no' +
        ' routing source to reconcile',
    );
  }
  const sourceName = dictGet(
    dictGet(data, 'memory') as Dict,
    'routing_source',
  ) as string | null;
  if (sourceName === null) {
    throw new ValueError(
      `memory.routing_source is null in ${CONFIG}; declaring a reviewed` +
        ' non-secret routing source is an explicit setup choice (see' +
        ' docs/t3-checkout-readiness.md), never implicit reconciliation',
    );
  }
  const memoryRepair = (
    install.repair_command as (
      source: string,
      project: string,
      script?: string,
      options?: string[],
    ) => string
  )(library, resolved, 'setup_memory.py');
  const [, state] = await (
    (await memory_helper(library, install)).expected_instructions as (
      project: string,
    ) => [string, string]
  )(resolved);
  if (state === 'missing') {
    throw new ValueError(
      'Generated routing .agents/memory/config.md is absent; restore it' +
        ` first with \`${memoryRepair}\` (reviewed --portable input when` +
        ' routing is unconfigured); reconciliation never invents routing',
    );
  }
  if (state === 'stale') {
    throw new ValueError(
      'Generated routing .agents/memory/config.md is stale; refresh it' +
        ` first with \`${memoryRepair}\``,
    );
  }
  if (state === 'customized') {
    throw new ValueError(
      'Generated routing .agents/memory/config.md is customized;' +
        ' preserve and review an explicit edit; reconciliation never' +
        ' overwrites reviewed routing',
    );
  }
  const generated = tryFs(() =>
    readFileSync(safe_path(resolved, '.agents/memory/config.md')),
  );
  const recordedParts = relative_path(sourceName);
  let destParts: string[];
  let repoint: boolean;
  if (source_must_move(resolved, recordedParts)) {
    destParts = purePath(RELOCATED_ROUTING_SOURCE).parts;
    repoint =
      destParts.length !== recordedParts.length ||
      destParts.some((part, i) => part !== recordedParts[i]);
  } else {
    destParts = recordedParts;
    repoint = false;
  }
  if (source_must_move(resolved, destParts)) {
    throw new ValueError(
      `Routing source destination ${destParts.join('/')} cannot hold the` +
        ' tracked copy; preserve and review .gitignore or the recorded' +
        ' routing_source before reconciliation',
    );
  }
  const dest = safe_path(resolved, destParts.join('/'), {
    allowMissing: true,
  });
  if (existsSync(dest) && !isFile(dest)) {
    throw new ValueError(
      `Routing source destination ${destParts.join('/')} is not a file; ` +
        'preserve and review',
    );
  }
  const previous = existsSync(dest) ? tryFs(() => readFileSync(dest)) : null;
  if (
    repoint &&
    previous !== null &&
    !previous.equals(generated)
  ) {
    throw new ValueError(
      `Relocation target ${destParts.join('/')} exists with different ` +
        'content; preserve and review',
    );
  }
  const reports: string[] = [];
  if (previous === null || !previous.equals(generated)) {
    if (previous === null) {
      create_missing(resolved, [[dest, 'file', generated]]);
      reports.push(
        `Wrote tracked routing source ${destParts.join('/')}` +
          ' with the generated routing',
      );
    } else {
      replace_bytes(resolved, dest, previous, generated);
      reports.push(
        `Rewrote tracked routing source ${destParts.join('/')}` +
          ' with the generated routing',
      );
    }
  }
  if (repoint) {
    const updated = dictSpread(
      data,
      'memory',
      dictSpread(
        dictGet(data, 'memory') as Dict,
        'routing_source',
        destParts.join('/'),
      ),
    );
    validate_config(updated);
    const configPath = safe_path(resolved, CONFIG);
    const prior = tryFs(() => readFileSync(configPath));
    const expectedConfig = Buffer.from(
      `${await jsonDumps(updated)}\n`,
      'utf8',
    );
    if (!prior.equals(expectedConfig)) {
      try {
        replace_bytes(resolved, configPath, prior, expectedConfig);
      } catch (error) {
        if (isValueOrOSError(error)) {
          throw new ValueError(
            `Routing source writes completed (${reports.join('; ')});` +
              ` manifest update failed: ${errorText(error)}; review and rerun`,
          );
        }
        throw error;
      }
    }
    reports.push(
      `Repointed memory.routing_source in ${CONFIG}:` +
        ` ${sourceName} -> ${destParts.join('/')}`,
    );
    if (existsSync(join(resolved, ...recordedParts))) {
      reports.push(
        `Left ${sourceName} untouched; retire it through` +
          ' the normal reviewed migration',
      );
    }
  }
  if (!reports.length) {
    reports.push(
      `Routing source ${destParts.join('/')} already matches` +
        ' the generated routing',
    );
  }
  const touched = [destParts.join('/'), CONFIG];
  if (repoint) touched.push(recordedParts.join('/'));
  const status = runGit(resolved, [
    'status',
    '--porcelain',
    '--',
    ...touched,
  ]);
  if (status.status === 0) {
    reports.push(
      ...pySplitlines(status.stdout).map((line) => `git status: ${line}`),
    );
  }
  try {
    reports.push(...(await assess(resolved)));
    await check_action(resolved);
  } catch (error) {
    if (isValueOrOSError(error)) {
      throw new ValueError(
        `Routing source reconciled (${reports.join('; ')}); readiness` +
          ` still reports: ${errorText(error)}`,
      );
    }
    throw error;
  }
  return reports;
}

export async function record_choice(
  root: string,
  choice: string,
  configFile?: string,
  replace = false,
): Promise<void> {
  const resolved = pyResolve(root);
  const path = safe_path(resolved, CONFIG, { allowMissing: true });
  let data: Dict;
  if (choice === 'declined') {
    data = new Map<string, unknown>([
      ['choice', 'declined'],
      ['library', '.agent-workflows'],
      ['base', ''],
      ['profiles', []],
      ['memory', new Map([['routing_source', null]])],
    ]);
  } else {
    if (configFile === undefined) {
      throw new ValueError(
        'Enabling requires --config-file with reviewed consumer inputs',
      );
    }
    const parsed = jsonLoads(readTextErrno(configFile));
    if (!isDict(parsed)) {
      throw new ValueError('Reviewed configuration must be an object');
    }
    data = parsed;
    dictSet(data, 'choice', choice);
  }
  validate_config(data);
  const previous = existsSync(path) ? tryFs(() => readFileSync(path)) : null;
  if (previous !== null) {
    const old = load(resolved);
    if (pyEq(old, data)) return;
    if (!replace) {
      throw new ValueError(
        'Choice already recorded; review an explicit --replace-choice transition',
      );
    }
  }
  if (choice === 'enabled') {
    const [library] = await prerequisites(resolved, data, true);
    await generated_plan(resolved, library);
  }
  const content = Buffer.from(`${await jsonDumps(data)}\n`, 'utf8');
  if (previous === null) {
    create_missing(resolved, [[path, 'file', content]]);
  } else {
    if (!tryFs(() => readFileSync(path)).equals(previous)) {
      throw new ValueError('Choice changed during preflight; review and retry');
    }
    // Only an explicitly requested reviewed choice transition replaces this
    // file.
    tryFs(() => writeFileSync(path, content));
  }
}

// --- argparse-compatible command line. -------------------------------------------

const PROG = 'agent-workflows.ts t3_readiness';
const USAGE =
  `usage: ${PROG} [-h] --project PROJECT\n` +
  '                       (--check | --prepare | --configure-action | --record-choice {enabled,declined} | --check-routing-source | --reconcile-routing-source)\n' +
  '                       [--config-file CONFIG_FILE] [--replace-choice]';

const HELP_TEXT =
  `${USAGE}\n` +
  '\n' +
  'Configure optional T3 readiness and verify a consumer\'s declared checkout\n' +
  'inputs.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --project PROJECT\n' +
  '  --check\n' +
  '  --prepare\n' +
  '  --configure-action\n' +
  '  --record-choice {enabled,declined}\n' +
  '  --check-routing-source\n' +
  '  --reconcile-routing-source\n' +
  '  --config-file CONFIG_FILE\n' +
  '  --replace-choice\n';

/** Raised to unwind `parser.error`/`--help` through `main`. */
class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function parserError(message: string): never {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${message}\n`);
  throw new ExitError(2);
}

interface OptionSpec {
  names: string[];
  dest:
    | 'help'
    | 'project'
    | 'check'
    | 'prepare'
    | 'configure_action'
    | 'record_choice'
    | 'check_routing_source'
    | 'reconcile_routing_source'
    | 'config_file'
    | 'replace_choice';
  takesValue: boolean;
  mutex: boolean;
}

const OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false, mutex: false },
  { names: ['--project'], dest: 'project', takesValue: true, mutex: false },
  { names: ['--check'], dest: 'check', takesValue: false, mutex: true },
  { names: ['--prepare'], dest: 'prepare', takesValue: false, mutex: true },
  {
    names: ['--configure-action'],
    dest: 'configure_action',
    takesValue: false,
    mutex: true,
  },
  {
    names: ['--record-choice'],
    dest: 'record_choice',
    takesValue: true,
    mutex: true,
  },
  {
    names: ['--check-routing-source'],
    dest: 'check_routing_source',
    takesValue: false,
    mutex: true,
  },
  {
    names: ['--reconcile-routing-source'],
    dest: 'reconcile_routing_source',
    takesValue: false,
    mutex: true,
  },
  { names: ['--config-file'], dest: 'config_file', takesValue: true, mutex: false },
  {
    names: ['--replace-choice'],
    dest: 'replace_choice',
    takesValue: false,
    mutex: false,
  },
];

const MODES = [
  '--check',
  '--prepare',
  '--configure-action',
  '--record-choice',
  '--check-routing-source',
  '--reconcile-routing-source',
];

function isOptionLike(token: string): boolean {
  if (!token.startsWith('-') || token === '-') return false;
  if (/^-\d+$|^-\d*\.\d+$/.test(token)) return false;
  if (token.includes(' ')) return false;
  return true;
}

function optionLabel(option: OptionSpec): string {
  return option.names.join('/');
}

function parseArgs(argv: string[]): {
  values: Record<string, string | boolean | undefined>;
  extras: string[];
} {
  const values: Record<string, string | boolean | undefined> = {};
  const extras: string[] = [];
  let index = 0;
  let pastSeparator = false;
  let seenMutex: OptionSpec | undefined;
  while (index < argv.length) {
    const arg = argv[index];
    index += 1;
    if (pastSeparator) {
      extras.push(arg);
      continue;
    }
    if (arg === '--') {
      // Python 3.12 reports the separator itself among the extras.
      extras.push(arg);
      pastSeparator = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const optName = eq < 0 ? arg : arg.slice(0, eq);
      const explicit = eq < 0 ? undefined : arg.slice(eq + 1);
      let option = OPTIONS.find((o) => o.names.includes(optName));
      if (option === undefined) {
        // allow_abbrev: an unambiguous prefix resolves; more than one
        // candidate is an ambiguous-option error, zero is an extra.
        const matched = OPTIONS.flatMap((o) =>
          o.names.filter((name) => name.startsWith(optName)),
        );
        const candidates = OPTIONS.filter((o) =>
          o.names.some((name) => matched.includes(name)),
        );
        if (candidates.length === 1) {
          option = candidates[0];
        } else if (candidates.length > 1) {
          parserError(
            `ambiguous option: ${arg} could match ${matched.join(', ')}`,
          );
        } else {
          extras.push(arg);
          continue;
        }
      }
      const label = optionLabel(option);
      if (option.dest === 'help') {
        if (explicit !== undefined) {
          parserError(
            `argument ${label}: ignored explicit argument` +
              ` ${pyStrRepr(explicit)}`,
          );
        }
        process.stdout.write(HELP_TEXT);
        throw new ExitError(0);
      }
      if (!option.takesValue && explicit !== undefined) {
        parserError(
          `argument ${label}: ignored explicit argument` +
            ` ${pyStrRepr(explicit)}`,
        );
      }
      let value: string | undefined = explicit;
      if (option.takesValue && value === undefined) {
        const next = argv[index];
        if (next === undefined || next === '--' || isOptionLike(next)) {
          parserError(`argument ${label}: expected one argument`);
        }
        value = next;
        index += 1;
      }
      if (option.dest === 'record_choice') {
        // `_check_value` runs inside `take_action`, before the mutually
        // exclusive conflict check.
        if (!['enabled', 'declined'].includes(value as string)) {
          parserError(
            `argument ${label}: invalid choice: ${pyRepr(value)} ` +
              '(choose from enabled, declined)',
          );
        }
      }
      if (
        option.mutex &&
        seenMutex !== undefined &&
        seenMutex !== option
      ) {
        parserError(
          `argument ${label}: not allowed with argument ` +
            `${optionLabel(seenMutex)}`,
        );
      }
      if (option.mutex) seenMutex = option;
      values[option.dest] = option.takesValue ? value : true;
      continue;
    }
    if (arg === '-h') {
      process.stdout.write(HELP_TEXT);
      throw new ExitError(0);
    }
    if (arg.startsWith('-h')) {
      // `consume_optional`: a no-argument single-dash option re-reads the
      // tail as more short options.
      let explicit = arg.slice(2);
      let separated = explicit.startsWith('=');
      if (separated) explicit = explicit.slice(1);
      for (;;) {
        if (separated || explicit.startsWith('-')) {
          parserError(
            `argument ${optionLabel(OPTIONS[0])}: ignored explicit argument` +
              ` ${pyStrRepr(explicit)}`,
          );
        }
        if (explicit === '' || explicit[0] !== 'h') {
          process.stdout.write(HELP_TEXT);
          throw new ExitError(0);
        }
        explicit = explicit.slice(1);
        separated = explicit.startsWith('=');
        if (separated) explicit = explicit.slice(1);
      }
    }
    extras.push(arg);
  }
  if (values.project === undefined) {
    parserError('the following arguments are required: --project');
  }
  if (seenMutex === undefined) {
    parserError(
      `one of the arguments ${MODES.join(' ')} is required`,
    );
  }
  return { values, extras };
}

async function runMain(argv: string[]): Promise<number> {
  const { values, extras } = parseArgs(argv);
  if (extras.length) {
    parserError(`unrecognized arguments: ${extras.join(' ')}`);
  }
  try {
    const root = pyResolve(values.project as string);
    if (values.replace_choice === true && values.record_choice === undefined) {
      throw new ValueError('--replace-choice requires --record-choice');
    }
    if (values.record_choice !== undefined) {
      await record_choice(
        root,
        values.record_choice as string,
        values.config_file as string | undefined,
        values.replace_choice === true,
      );
      console.log(
        `Recorded T3 choice: ${values.record_choice}; ` +
          'readiness has not been inferred',
      );
    } else if (values.configure_action === true) {
      await configure(root);
      console.log(
        'Generated launcher and t3.json candidate; action registered: ' +
          'unverified; setup executed: unverified',
      );
    } else if (values.prepare === true) {
      await restore_missing(root);
      console.log(
        'Checkout prerequisites prepared; fresh-session discovery and ' +
          'MCP connectivity: unverified',
      );
    } else if (values.check_routing_source === true) {
      for (const message of await routing_source_status(root)) {
        console.log(message);
      }
    } else if (values.reconcile_routing_source === true) {
      for (const message of await reconcile_routing_source(root)) {
        console.log(message);
      }
    } else {
      for (const message of await assess(root)) {
        console.log(message);
      }
      await check_action(root);
    }
    return 0;
  } catch (error) {
    if (isValueOrOSError(error)) {
      console.error(errorText(error));
      return 1;
    }
    throw error;
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  try {
    return await runMain(argv);
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
}

// `if __name__ == "__main__"`: Node resolves the invoked entry to its real
// path for import.meta.url while argv[1] keeps the typed spelling.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(pyResolve(process.argv[1])).href
) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      throw error;
    },
  );
}
