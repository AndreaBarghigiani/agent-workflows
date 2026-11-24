/**
 * TypeScript port of `scripts/t3_bootstrap.py` (issue #117): bootstrap the
 * pinned agent-workflows submodule in a fresh worktree.
 *
 * The pinned readiness helper is `scripts/t3_readiness.ts` run with Node;
 * a pin carrying only `scripts/t3_readiness.py` is reported as needing
 * migration instead of being executed.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { constants as osConstants } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGit } from './lib/git.ts';
import { pyDecodeUtf8 } from './lib/pyio.ts';
import { pyJsonLoads, jsonLoadsError, jsonLoadsErrorMessage } from './lib/pyloads.ts';
import { UnicodeDecodeError, ValueError, osErrorName } from './lib/pyerrors.ts';
import { pyRepr, pyStrRepr } from './lib/pyrepr.ts';
import { pyResolve } from './install.ts';

const CONFIG = '.agent-workflows-t3.json';
const HELPER = 'scripts/t3_readiness.py';
const HELPER_TS = 'scripts/t3_readiness.ts';
const FIELDS = new Set(['choice', 'library', 'base', 'profiles', 'memory']);
// Legacy files may still carry an ignored consumer skill selection.
const LEGACY_FIELDS = new Set([...FIELDS, 'skills']);

// --- Python value semantics ----------------------------------------------------

type Dict = Record<string, unknown> | Map<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dictHas(mapping: Dict, key: string): boolean {
  return mapping instanceof Map
    ? mapping.has(key)
    : Object.hasOwn(mapping, key);
}

function dictGet(mapping: Dict, key: string): unknown {
  return mapping instanceof Map ? mapping.get(key) : mapping[key];
}

function dictGetOr(mapping: Dict, key: string, fallback: unknown): unknown {
  return dictHas(mapping, key) ? dictGet(mapping, key) : fallback;
}

function dictKeys(mapping: Dict): string[] {
  return mapping instanceof Map ? [...mapping.keys()] : Object.keys(mapping);
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
const PY_WS_ONE = new RegExp(`[${PY_WS_CLASS}]`, 'u');

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

/** `text.split(None, 1)` — first field, then the remainder left-stripped. */
function pySplit1(text: string): string[] {
  const stripped = pyStrip(text);
  const match = PY_WS_ONE.exec(stripped);
  if (match === null) return [stripped];
  return [stripped.slice(0, match.index), pyStrip(stripped.slice(match.index))];
}

/** `text.splitlines()` — universal newlines, no keepends. */
function pySplitlines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
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

/**
 * Raised for the pinned-helper migration path: the message reaches stderr
 * verbatim — one line, no `T3 bootstrap:` prefix, no traceback.
 */
class MigrationError extends Error {}

// --- PurePosixPath subset --------------------------------------------------------

/**
 * `PurePosixPath(value)` parts: absolute flag, the components with `.` and
 * empty segments dropped (`..` kept), and the `as_posix()` spelling.
 */
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

function _git(
  cwd: string,
  args: string[],
  check = true,
): { status: number; stdout: string; stderr: string } {
  const result = runGit(cwd, args);
  if (check && result.status) {
    throw new ValueError(
      pyStrip(result.stderr) || `git ${args.join(' ')} failed`,
    );
  }
  return result;
}

function _safe_relative(value: unknown, label: string): string[] {
  if (
    typeof value !== 'string' ||
    value === '' ||
    [...value].some((c) => c.codePointAt(0)! < 32 || c.codePointAt(0)! === 127)
  ) {
    throw new ValueError(`${label} must be a nonempty relative path`);
  }
  const path = purePath(value);
  if (
    path.absolute ||
    path.parts.includes('..') ||
    path.parts.length === 0 ||
    path.asPosix !== value
  ) {
    throw new ValueError(`Unsafe ${label}: ${pyRepr(value)}`);
  }
  return path.parts;
}

function _load(root: string): Dict {
  const config = join(root, CONFIG);
  if (isSym(config) || !isFile(config)) {
    throw new ValueError(
      `Missing or unsafe ${CONFIG}; make an explicit T3 choice first`,
    );
  }
  let text: string;
  try {
    // `pyDecodeUtf8` over the raw bytes — like `readText`, but the errno
    // error reaching `pyOsError` keeps its code/path, so `str(error)`
    // keeps CPython's `[Errno N]` wording.
    text = pyDecodeUtf8(readFileSync(config));
  } catch (error) {
    if (error instanceof UnicodeDecodeError) throw error;
    throw new ValueError(
      `Cannot read ${CONFIG}: ${errorText(pyOsError(error))}`,
    );
  }
  // Text mode's universal newlines: `\r\n` and a bare `\r` both read `\n`.
  text = text.replace(/\r\n?/g, '\n');
  const decode = jsonLoadsError(text);
  if (decode !== null) {
    throw new ValueError(
      `Cannot read ${CONFIG}: ${jsonLoadsErrorMessage(text, decode)}`,
    );
  }
  const data = pyJsonLoads(text);
  const keys = isDict(data) ? dictKeys(data) : [];
  const fieldSet = new Set(keys);
  const exact = (wanted: Set<string>) =>
    fieldSet.size === wanted.size && [...wanted].every((k) => fieldSet.has(k));
  if (!isDict(data) || (!exact(FIELDS) && !exact(LEGACY_FIELDS))) {
    throw new ValueError(
      `${CONFIG} must declare exactly ` +
        `['base', 'choice', 'library', 'memory', 'profiles'] ` +
        `(a legacy skills array is ignored)`,
    );
  }
  const choice = dictGet(data, 'choice');
  if (choice !== 'enabled' && choice !== 'declined') {
    throw new ValueError('choice must be enabled or declined');
  }
  if (choice === 'declined') return data;
  _safe_relative(dictGet(data, 'library'), 'library');
  const base = dictGet(data, 'base');
  if (
    typeof base !== 'string' ||
    base === '' ||
    base.startsWith('-') ||
    [...base].some((c) => c.codePointAt(0)! < 32)
  ) {
    throw new ValueError('base must be a nonempty resolvable ref');
  }
  const profiles = dictGet(data, 'profiles');
  if (!Array.isArray(profiles)) {
    throw new ValueError('profiles must be an array');
  }
  for (const name of profiles) {
    const last = typeof name === 'string' ? basename(name) : name;
    if (
      typeof name !== 'string' ||
      name === '' ||
      last !== name ||
      !name.endsWith('.toml')
    ) {
      throw new ValueError('Invalid profile selection');
    }
  }
  if (profiles.length !== new Set(profiles).size) {
    throw new ValueError('Duplicate profile selection');
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
  if (dictHas(memory, 'enabled') && typeof dictGet(memory, 'enabled') !== 'boolean') {
    throw new ValueError('memory enabled must be a boolean');
  }
  if (dictGet(memory, 'routing_source') !== null) {
    _safe_relative(dictGet(memory, 'routing_source'), 'memory.routing_source');
  }
  if (
    dictGetOr(memory, 'enabled', undefined) === false &&
    dictGet(memory, 'routing_source') !== null
  ) {
    throw new ValueError(
      'Memory-disabled consumers must not declare a routing source',
    );
  }
  return data;
}

function _worktree_root(root: string): void {
  const top = pyResolve(pyStrip(_git(root, ['rev-parse', '--show-toplevel']).stdout));
  if (top !== root) {
    throw new ValueError(`Bootstrap must run at the worktree root (${top})`);
  }
}

function _base(root: string, base: string): void {
  const resolved = _git(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    false,
  );
  if (resolved.status) {
    throw new ValueError(
      `Base ${pyStrRepr(base)} does not resolve to a commit; no submodule was initialized`,
    );
  }
  const ancestor = _git(
    root,
    ['merge-base', '--is-ancestor', pyStrip(resolved.stdout), 'HEAD'],
    false,
  );
  if (ancestor.status) {
    throw new ValueError(
      `Base ${pyStrRepr(base)} is not an ancestor of HEAD; no submodule was initialized`,
    );
  }
}

function _gitlink(root: string, rel: string[]): string {
  const path = rel.join('/');
  const indexed = _git(root, ['ls-files', '-s', '-z', '--', path], false);
  if (indexed.status) {
    throw new ValueError('Cannot inspect the library index entry');
  }
  const lines = indexed.stdout.split('\0').filter((line) => line !== '');
  if (lines.length !== 1 || !/^160000 ([0-9a-f]+) 0\t/.test(lines[0])) {
    throw new ValueError(
      'Declared library must have one stage-0 gitlink index entry; resolve conflicts first',
    );
  }
  const committed = _git(root, ['ls-tree', '-z', 'HEAD', '--', path]).stdout
    .split('\0')
    .filter((line) => line !== '');
  if (committed.length !== 1 || !committed[0].startsWith('160000 commit ')) {
    throw new ValueError('Declared library is not a committed submodule gitlink');
  }
  const index_pin = pySplit(lines[0])[1];
  const head_pin = pySplit(committed[0])[2].split('\t', 1)[0];
  if (index_pin !== head_pin) {
    throw new ValueError(
      'Submodule index pin differs from committed HEAD; review the pin',
    );
  }
  if (
    lines[0].slice(lines[0].indexOf('\t') + 1) !== path ||
    committed[0].slice(committed[0].indexOf('\t') + 1) !== path
  ) {
    throw new ValueError('Declared path must match the exact gitlink');
  }
  const modules = join(root, '.gitmodules');
  if (isSym(modules) || !isFile(modules)) {
    throw new ValueError('Tracked .gitmodules is missing or unsafe');
  }
  for (const diffArgs of [
    ['diff', '--quiet', '--', '.gitmodules'],
    ['diff', '--cached', '--quiet', 'HEAD', '--', '.gitmodules'],
  ]) {
    if (_git(root, diffArgs, false).status) {
      throw new ValueError(
        '.gitmodules differs from committed HEAD; review before initializing',
      );
    }
  }
  const configured = _git(
    root,
    ['config', '--blob', 'HEAD:.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
    false,
  );
  if (configured.status) {
    throw new ValueError('Cannot read submodule paths from .gitmodules');
  }
  const paths: string[] = [];
  for (const line of pySplitlines(configured.stdout)) {
    const fields = pySplit1(line);
    if (fields.length === 2) paths.push(fields[1]);
  }
  if (!paths.includes(path)) {
    throw new ValueError(
      'Declared library path does not match a .gitmodules entry',
    );
  }
  const tracked = _git(root, ['ls-files', '--error-unmatch', '.gitmodules'], false);
  if (tracked.status) {
    throw new ValueError('.gitmodules must be tracked by the worktree');
  }
  return index_pin;
}

function _library_path(root: string, rel: string[]): string {
  let current = root;
  for (const part of rel) {
    current = join(current, part);
    if (isSym(current)) {
      throw new ValueError(`Library path contains a symlink: ${current}`);
    }
  }
  return current;
}

function _initialized(library: string): boolean {
  const dotgit = join(library, '.git');
  if (!(isFile(dotgit) || isDir(dotgit)) || isSym(dotgit)) return false;
  const top = _git(library, ['rev-parse', '--show-toplevel'], false);
  return (
    top.status === 0 && pyResolve(pyStrip(top.stdout)) === pyResolve(library)
  );
}

export function bootstrap(root: string, check = false): string {
  const resolvedRoot = pyResolve(root);
  _worktree_root(resolvedRoot);
  const data = _load(resolvedRoot);
  if (dictGet(data, 'choice') !== 'enabled') {
    throw new ValueError('T3 bootstrap requires an enabled choice');
  }
  _base(resolvedRoot, dictGet(data, 'base') as string);
  const rel = _safe_relative(dictGet(data, 'library'), 'library');
  const pin = _gitlink(resolvedRoot, rel);
  const library = _library_path(resolvedRoot, rel);
  if (check) {
    if (!_initialized(library)) {
      throw new ValueError(
        'Pinned library submodule is not initialized; run bootstrap without --check',
      );
    }
    _verify_library(library, pin);
    return 'Pinned library bootstrap prerequisites are ready';
  }
  if (!existsSync(library)) {
    mkdirSync(dirname(library), { recursive: true });
  }
  if (!_initialized(library)) {
    if (
      existsSync(library) &&
      (!isDir(library) || readdirSync(library).length !== 0)
    ) {
      throw new ValueError(
        'Library destination is nonempty and is not its own initialized submodule; preserving it',
      );
    }
    const result = _git(
      resolvedRoot,
      ['submodule', 'update', '--init', '--', rel.join('/')],
      false,
    );
    if (result.status) {
      const detail =
        pyStrip(result.stderr) ||
        pyStrip(result.stdout) ||
        'git submodule update failed';
      throw new ValueError(
        `Could not initialize the pinned library submodule: ${detail}`,
      );
    }
  }
  _verify_library(library, pin);
  const helperName = HELPER_TS;
  const helper = join(library, helperName);
  if (isSym(helper) || !isFile(helper)) {
    const legacy = join(library, HELPER);
    if (!isSym(helper) && isFile(legacy)) {
      throw new MigrationError(
        'Pinned t3_readiness.py needs migration to t3_readiness.ts',
      );
    }
    throw new ValueError(
      `Pinned ${basename(helperName)} helper is missing or unsafe`,
    );
  }
  try {
    const resolved = realpathSync(helper);
    const libraryReal = realpathSync(library);
    const inside = relative(libraryReal, resolved);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new ValueError('outside');
    }
  } catch {
    throw new ValueError('Pinned helper resolves outside the library');
  }
  const expected = _git(library, ['show', `HEAD:${helperName}`]).stdout;
  if (!readFileSync(helper).equals(Buffer.from(expected, 'utf8'))) {
    throw new ValueError('Pinned helper content differs from library HEAD');
  }
  const child = spawnSync(
    process.execPath,
    [helper, '--project', resolvedRoot, '--prepare'],
    { cwd: resolvedRoot, stdio: 'inherit' },
  );
  if (child.error) throw child.error;
  let status = child.status;
  if (status === null) {
    const signals = osConstants.signals as Record<string, number>;
    status = -(signals[child.signal ?? ''] ?? 0);
  }
  if (status) {
    throw new ValueError(
      `Pinned readiness preparation failed with exit status ${status}`,
    );
  }
  return 'Pinned library prepared the T3 checkout';
}

function _verify_library(library: string, pin: string): void {
  if (!_initialized(library)) {
    throw new ValueError('Library is not an initialized standalone submodule');
  }
  const actual = pyStrip(_git(library, ['rev-parse', 'HEAD']).stdout);
  if (actual !== pin) {
    throw new ValueError(
      'Initialized library HEAD differs from the committed gitlink pin',
    );
  }
  const status = pyStrip(_git(library, ['status', '--porcelain']).stdout);
  if (status) {
    throw new ValueError(
      'Pinned library worktree is dirty; review local changes before using it',
    );
  }
}

// --- argparse-compatible command line -------------------------------------------

function prog(): string {
  const invoked = basename(process.argv[1] ?? 'agent-workflows.ts');
  // The generated `.agent-workflows-t3.mjs` launcher keeps its own name in
  // help; dispatch through `bin/agent-workflows.ts` names the subcommand.
  return invoked === 'agent-workflows.ts'
    ? 'agent-workflows.ts t3_bootstrap'
    : invoked;
}

function usageText(progName: string): string {
  return `usage: ${progName} [-h] [--check]`;
}

function helpText(progName: string): string {
  return (
    `${usageText(progName)}\n` +
    '\n' +
    'Bootstrap the pinned agent-workflows submodule in a fresh worktree.\n' +
    '\n' +
    'options:\n' +
    '  -h, --help  show this help message and exit\n' +
    '  --check     check prerequisites without initializing or preparing\n'
  );
}

/** Raised to unwind `parser.error`/`--help` through `main`. */
class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function parserError(message: string): never {
  process.stderr.write(
    `${usageText(prog())}\n${prog()}: error: ${message}\n`,
  );
  throw new ExitError(2);
}

interface OptionSpec {
  names: string[];
  dest: 'help' | 'check';
  takesValue: boolean;
}

const OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--check'], dest: 'check', takesValue: false },
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
  values: Record<string, boolean | undefined>;
  extras: string[];
} {
  const values: Record<string, boolean | undefined> = {};
  const extras: string[] = [];
  let index = 0;
  let pastSeparator = false;
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
      if (option.dest === 'help') {
        if (explicit !== undefined) {
          parserError(
            `argument ${optionLabel(option)}: ignored explicit argument` +
              ` ${pyStrRepr(explicit)}`,
          );
        }
        process.stdout.write(helpText(prog()));
        throw new ExitError(0);
      }
      if (explicit !== undefined) {
        parserError(
          `argument ${optionLabel(option)}: ignored explicit argument` +
            ` ${pyStrRepr(explicit)}`,
        );
      }
      values[option.dest] = true;
      continue;
    }
    if (arg === '-h') {
      process.stdout.write(helpText(prog()));
      throw new ExitError(0);
    }
    if (arg.startsWith('-h')) {
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
          process.stdout.write(helpText(prog()));
          throw new ExitError(0);
        }
        explicit = explicit.slice(1);
        separated = explicit.startsWith('=');
        if (separated) explicit = explicit.slice(1);
      }
    }
    extras.push(arg);
  }
  return { values, extras };
}

export function main(
  argv: string[] = process.argv.slice(2),
  root?: string,
): number {
  try {
    const { values, extras } = parseArgs(argv);
    if (extras.length) {
      parserError(`unrecognized arguments: ${extras.join(' ')}`);
    }
    const base =
      root ??
      dirname(realpathSync(fileURLToPath(import.meta.url)));
    try {
      console.log(bootstrap(base, values.check === true));
      return 0;
    } catch (error) {
      if (error instanceof MigrationError) {
        process.stderr.write(`${error.message}\n`);
        return 1;
      }
      if (isValueOrOSError(error)) {
        process.stderr.write(`T3 bootstrap: ${errorText(error)}\n`);
        return 1;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
}

// `if __name__ == "__main__"`: Node resolves the invoked entry to its real
// path for import.meta.url while argv[1] keeps the typed spelling, so both
// spellings are compared after resolving.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(pyResolve(process.argv[1])).href
) {
  process.exitCode = main();
}
