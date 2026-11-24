/**
 * Adopt third-party skill copies into a single `.agents/skills` location.
 *
 * Vendor installers (for example `npx skills add ...`) copy each skill into
 * per-harness folders such as `.claude/skills`. This helper consolidates
 * identical copies into `.agents/skills/<name>` — the layout the
 * agent-workflows toolkit already uses — and leaves a relative symlink in
 * every discovered harness folder that cannot read `.agents/skills`
 * natively, reusing the same link_status/make_relative_link helpers as
 * `install.py --claude-skills`. Copies are compared by content and are
 * never removed before the canonical skill exists; differing copies,
 * toolkit name clashes and unsafe entries are refused and reported. The
 * default mode is a dry run; pass --apply to write. Provenance is recorded
 * in `.agents/adopted-skills.json`. The helper never runs vendor
 * installers. See docs/skill-distribution.md.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  link_status,
  make_relative_link,
  pyResolve,
  toolkit,
} from './install.ts';
import { osErrorName, UnicodeDecodeError, ValueError } from './lib/pyerrors.ts';
import { readText } from './lib/pyio.ts';
import { pyJson } from './lib/pyjson.ts';
import {
  jsonLoadsError,
  jsonLoadsErrorMessage,
  PyFloat,
  pyJsonLoads,
} from './lib/pyloads.ts';
import { pyFloatRepr, pyRepr } from './lib/pyrepr.ts';

export const CANONICAL = '.agents/skills';
export const MANIFEST = '.agents/adopted-skills.json';
const EXCLUDED = ['.agents', '.agent-workflows', '.git'];

// Harnesses that already read .agents/skills: a copied skill in their folder
// is removed without a replacement link. Every other discovered folder,
// including unknown ones, gets a link so an adopted skill keeps loading.
const NATIVE_AGENTS_SKILLS: Record<string, string> = {
  '.codex': 'Codex discovers the .agents/skills installation' +
    ' (docs/codex.md, verified on Codex CLI 0.165.0)',
  '.opencode': 'OpenCode discovers .agents/skills/<name>/SKILL.md' +
    ' (docs/opencode.md; https://opencode.ai/docs/skills/)',
};

// re.compile(r"token|key|secret|password|credential|auth", re.IGNORECASE).
// CPython IGNORECASE additionally maps i to İ/ı, s to ſ and k to K; the
// JavaScript `iu` flag folds ſ and K but not the two dotted-`i` forms, so
// the name is normalized through CPython's four extra equivalences first.
const SECRET_NAME = /token|key|secret|password|credential|auth/iu;
const SECRET_EXTRA_CASES: Record<string, string> = {
  'İ': 'i',
  'ı': 'i',
  'ſ': 's',
  'K': 'k',
};

// ---------------------------------------------------------------------------
// Python-semantics path and error helpers — the same private set
// scripts/install.ts carries; they stay local so this port does not widen
// the install module's exported surface.
// ---------------------------------------------------------------------------

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** `Path.is_symlink()` — lstat, false on a missing path. */
function isSymlink(path: string): boolean {
  return lstatOrNull(path)?.isSymbolicLink() ?? false;
}

/** `Path.is_file()` — follows links, false on error. */
function isFile(path: string): boolean {
  return statOrNull(path)?.isFile() ?? false;
}

/** `Path.is_dir()` — follows links, false on error. */
function isDir(path: string): boolean {
  return statOrNull(path)?.isDirectory() ?? false;
}

/** `PurePath.is_relative_to` — a lexical component-prefix check. */
function isRelativeTo(target: string, root: string): boolean {
  return (
    target === root ||
    target.startsWith(root.endsWith('/') ? root : `${root}/`)
  );
}

/**
 * `sorted(...)` on names — Python compares strings by code point; the
 * default JavaScript sort uses UTF-16 code units, which inverts BMP
 * characters at or above U+E000 against astral characters.
 */
function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done) return r.done ? 0 : -1;
    if (r.done) return 1;
    if (l.value !== r.value) {
      return (l.value.codePointAt(0) ?? 0) - (r.value.codePointAt(0) ?? 0);
    }
  }
}

/**
 * `sorted(...)` on `Path` objects — CPython compares `parts` tuples, so
 * each `/`-separated component is compared by code point and a shorter
 * tuple sorts first on a shared prefix. `'/'` sorts after `'-'` in a
 * raw string compare, which wrongly puts `.a-b/skills/x` before
 * `.a/skills/x`; `sorted(iterdir())` calls stay on the string compare
 * because a shared parent reduces the parts compare to the name.
 */
function comparePathParts(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const order = compareCodePoints(left[index], right[index]);
    if (order !== 0) return order;
  }
  return left.length - right.length;
}

const OS_ERRNO: Record<string, [number, string]> = {
  EPERM: [1, 'Operation not permitted'],
  ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'],
  EBUSY: [16, 'Device or resource busy'],
  EEXIST: [17, 'File exists'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  EROFS: [30, 'Read-only file system'],
  ENAMETOOLONG: [36, 'File name too long'],
  ENOTEMPTY: [39, 'Directory not empty'],
  ELOOP: [40, 'Too many levels of symbolic links'],
};

const OS_ERROR_NAMES = [
  'OSError',
  'FileNotFoundError',
  'NotADirectoryError',
  'IsADirectoryError',
  'FileExistsError',
  'PermissionError',
];

/** `isinstance(error, OSError)` over the names pyOsError assigns. */
function isOSError(error: unknown): boolean {
  return OS_ERROR_NAMES.includes((error as Error).name);
}

/**
 * `str(OSError)` for a Node errno error: `[Errno N] {strerror}: '{path}'`,
 * named after the OSError subclass CPython raises for the same code.
 */
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

/** Run an fs call, translating errno failures into Python OSError text. */
function tryFs<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw pyOsError(error);
  }
}

/** `os.rename`/`os.replace` — errors name both endpoints `'src' -> 'dst'`. */
function tryRename(source: string, destination: string): void {
  try {
    renameSync(source, destination);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    const pair = errno?.code !== undefined ? OS_ERRNO[errno.code] : undefined;
    if (pair === undefined) throw error;
    const [number, strerror] = pair;
    const renamed = new Error(
      `[Errno ${number}] ${strerror}: '${source}' -> '${destination}'`,
    );
    renamed.name = osErrorName(error);
    throw renamed;
  }
}

/** `isinstance(value, dict)` over pyJsonLoads' Map materialization. */
function isDict(value: unknown): value is Map<string, unknown> {
  return value instanceof Map;
}

/** Python `==` for the `data["schema_version"] != 1` comparison. */
function isOne(value: unknown): boolean {
  // `True == 1` and `1.0 == 1` hold in Python; `False`, `"1"` and other
  // values do not.
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value === 1n;
  if (typeof value === 'number') return value === 1;
  if (value instanceof PyFloat) return value.value === 1;
  return false;
}

/** `path.relative_to(project).as_posix()` — lexical, like the original. */
function relativeTo(path: string, project: string): string {
  const rel = relative(project, path);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
    throw new ValueError(
      `${pyRepr(path)} is not in the subpath of ${pyRepr(project)}`);
  }
  return rel;
}

// ---------------------------------------------------------------------------
// `json.dumps(manifest, indent=2) + "\n"` with Python's default
// sort_keys=False — insertion order is the byte contract, so the manifest is
// not routed through pyJson (which reproduces sort_keys=True).
// ---------------------------------------------------------------------------

const JSON_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function escapeString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const code = char.charCodeAt(0);
    const short = JSON_ESCAPES[char];
    if (short !== undefined) out += short;
    else if (code < 0x20 || code >= 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += char;
  }
  return out + '"';
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  if (Object.is(value, -0)) return '-0.0';
  if (Number.isInteger(value)) return String(value);
  return pyFloatRepr(value);
}

/** `json.dumps` for a Python `float` — always the float repr (`2.0`). */
function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  return pyFloatRepr(value);
}

function joinItems(
  open: string,
  close: string,
  items: string[],
  indent: number | undefined,
  level: number,
): string {
  if (indent === undefined) return open + items.join(',') + close;
  const pad = ' '.repeat(indent * (level + 1));
  const closing = ' '.repeat(indent * level);
  return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${closing}${close}`;
}

/** `json.dumps(..., indent)` over pyJsonLoads values without sorting keys. */
function serializeOrdered(
  value: unknown,
  indent: number | undefined,
  level: number,
): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return formatNumber(value);
  // `bigint` is a Python `int`: its digits, unbounded by 2**53.
  if (typeof value === 'bigint') return String(value);
  if (value instanceof PyFloat) return formatFloat(value.value);
  if (typeof value === 'string') return escapeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((entry) => serializeOrdered(entry, indent, level + 1));
    return joinItems('[', ']', items, indent, level);
  }
  const pair = (key: string, member: unknown): string =>
    `${escapeString(key)}${indent === undefined ? ':' : ': '}${
      serializeOrdered(member, indent, level + 1)
    }`;
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, member]) =>
      pair(key, member));
    if (entries.length === 0) return '{}';
    return joinItems('{', '}', entries, indent, level);
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value).map((key) =>
      pair(key, (value as Record<string, unknown>)[key]));
    if (entries.length === 0) return '{}';
    return joinItems('{', '}', entries, indent, level);
  }
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

/** `json.dumps(manifest, indent=2)` preserving dict insertion order. */
function dumpsOrdered(value: unknown): string {
  return serializeOrdered(value, 2, 0);
}

// ---------------------------------------------------------------------------
// `shlex.split` — CPython 3.12 state machine with posix=True,
// punctuation_chars off, whitespace_split=True and commenters=''.
// ---------------------------------------------------------------------------

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
        // `if self.token or (self.posix and quoted): break`
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
        // whitespace_split: every other character is a word character.
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
      // `escapedstate in self.quotes and nextchar != self.state
      //  and nextchar != escapedstate`
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
  // `posix and not quoted and result == ''` produces no final token.
  if (token !== '' || quoted) words.push(token);
  return words;
}

// ---------------------------------------------------------------------------
// adopt_skills.py — the port.
// ---------------------------------------------------------------------------

export function redact_command(text: string): string {
  /** Normalize shell words and redact secret-bearing options/assignments.
   *
   * This is provenance text, never an executable command. Unparseable shell
   * input is withheld entirely rather than risking partial secret
   * disclosure. */
  let words: string[];
  try {
    words = shlexSplit(text);
  } catch (error) {
    if (error instanceof ValueError) return '<redacted: unparseable command>';
    throw error;
  }
  const result: string[] = [];
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    const eq = word.indexOf('=');
    const name = eq < 0 ? word : word.slice(0, eq);
    const separator = eq < 0 ? '' : '=';
    if (
      SECRET_NAME.test(
        name.replace(/İ|ı|ſ|K/g, (char) => SECRET_EXTRA_CASES[char]),
      ) &&
      (name.startsWith('-') || separator !== '')
    ) {
      result.push(`${name}=<redacted>`);
      if (separator === '' && index + 1 < words.length) index += 1;
    } else {
      result.push(word);
    }
    index += 1;
  }
  return result.join(' ');
}

function validate_skill_name(name: unknown): void {
  if (
    typeof name !== 'string' || name === '' || name === '.' || name === '..' ||
    name.includes('/') || name.includes('\\') || name.includes('\0')
  ) {
    throw new ValueError('Invalid manifest skill name; preserve and review');
  }
}

function validate_destination(project: string, path: string): void {
  /** Validate physical parent containment without following a final link. */
  if (!isRelativeTo(pyResolve(dirname(path)), project)) {
    throw new ValueError(`Destination escapes project: ${path}`);
  }
}

function preflight_storage(project: string): void {
  /** Refuse redirected canonical/provenance paths before any mutation. */
  for (const rel of ['.agents', CANONICAL]) {
    const path = join(project, rel);
    if (isSymlink(path) || (existsSync(path) && !isDir(path))) {
      throw new ValueError(
        `Unsafe storage directory: ${rel}; preserve and review`);
    }
  }
  const path = join(project, MANIFEST);
  if (isSymlink(path) || (existsSync(path) && !isFile(path))) {
    throw new ValueError(`Unsafe manifest: ${MANIFEST}; preserve and review`);
  }
}

export function skill_signature(path: string): [digest: string, unsafe: string[]] {
  /** Hash a real skill copy's contents as relative-path/file-content pairs.
   *
   * Returns (hexdigest, unsafe). Unsafe lists entries that are symlinks or
   * non-regular files; they are never followed, moved or removed, and any
   * copy containing them is refused. */
  const files: string[] = [];
  const unsafe: string[] = [];
  // `os.walk(path)`: each scandir failure silently ends that branch; the
  // caller's `dirnames.sort()` drives recursion order, and followlinks=False
  // re-checks `islink()` on each name right before descending.
  const walk = (dirpath: string): void => {
    let names: string[];
    try {
      names = readdirSync(dirpath);
    } catch {
      return;
    }
    const dirnames: string[] = [];
    const filenames: string[] = [];
    for (const name of names) {
      // `entry.is_dir()` follows links; an OSError reads "not a dir".
      if (statOrNull(join(dirpath, name))?.isDirectory() ?? false) {
        dirnames.push(name);
      } else {
        filenames.push(name);
      }
    }
    dirnames.sort(compareCodePoints);
    for (const name of [...dirnames, ...filenames].sort(compareCodePoints)) {
      const entry = join(dirpath, name);
      const rel = relativeTo(entry, path);
      if (isSymlink(entry) || !(isFile(entry) || isDir(entry))) {
        unsafe.push(rel);
      } else if (isFile(entry)) {
        files.push(rel);
      }
    }
    for (const name of dirnames) {
      const subdir = join(dirpath, name);
      if (!isSymlink(subdir)) walk(subdir);
    }
  };
  walk(path);
  const digest = createHash('sha256');
  for (const rel of files.sort(compareCodePoints)) {
    digest.update(Buffer.concat([Buffer.from(rel, 'utf8'), Buffer.from([0])]));
    digest.update(
      createHash('sha256')
        .update(tryFs(() => readFileSync(join(path, rel))))
        .digest(),
    );
  }
  return [digest.digest('hex'), unsafe];
}

function discover_folders(
  project: string,
): [folders: [display: string, resolved: string][], notes: string[]] {
  /** Find hidden first-level dot-folder `skills` folders holding
   * adoptable copies.
   *
   * Returns (folders, notes): folders are (display path, resolved path)
   * pairs retaining aliases for harness linking. Copy inspection is
   * deduplicated. Only project-contained directories are scanned —
   * `.agents`, `.agent-workflows` and `.git` are excluded, non-hidden
   * folders are never entered, hidden top-level symlinks are skipped, and a
   * `skills` entry aliasing the canonical `.agents/skills` is never scanned
   * as copies. */
  const canonical = pyResolve(join(project, CANONICAL));
  const folders: [string, string][] = [];
  const notes: string[] = [];
  for (const name of
    tryFs(() => readdirSync(project)).sort(compareCodePoints)) {
    if (!name.startsWith('.') || EXCLUDED.includes(name)) continue;
    const entry = join(project, name);
    if (isSymlink(entry)) {
      notes.push(
        `skipped ${relativeTo(entry, project)}: hidden folder is a symlink`);
      continue;
    }
    if (!isDir(entry)) continue;
    const skills = join(entry, 'skills');
    if (isSymlink(skills)) {
      const resolvedLink = pyResolve(skills);
      if (resolvedLink === canonical) {
        notes.push(
          `skipped ${relativeTo(skills, project)}: alias of .agents/skills`);
        continue;
      }
      if (!isDir(resolvedLink)) {
        notes.push(
          `skipped ${relativeTo(skills, project)}: dangling skills link`);
        continue;
      }
    } else if (!isDir(skills)) {
      continue;
    }
    const resolved = pyResolve(skills);
    if (resolved === canonical) {
      notes.push(
        `skipped ${relativeTo(skills, project)}: alias of .agents/skills`);
      continue;
    }
    if (!isRelativeTo(resolved, project)) {
      throw new ValueError(`Skills folder escapes project: ${skills}`);
    }
    if (
      EXCLUDED.some((excluded) =>
        isRelativeTo(resolved, pyResolve(join(project, excluded))))
    ) {
      throw new ValueError(`Skills folder targets excluded storage: ${skills}`);
    }
    folders.push([skills, resolved]);
  }
  return [folders, notes];
}

function scan_copies(
  folders: [display: string, resolved: string][],
): [copies: Map<string, string[]>, notes: string[]] {
  /** Group real skill copies by name across the discovered folders.
   *
   * An entry counts as a copy only when it is a real directory with a
   * regular SKILL.md. Entries that are already symlinks — including
   * agent-workflows library links and links this helper created — are
   * skipped. */
  const copies = new Map<string, string[]>();
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const [, resolved] of folders) {
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    for (const name of
      tryFs(() => readdirSync(resolved)).sort(compareCodePoints)) {
      const entry = join(resolved, name);
      if (isSymlink(entry) || !isDir(entry)) continue;
      const marker = join(entry, 'SKILL.md');
      if (isSymlink(marker) || !isFile(marker)) {
        notes.push(
          `skipped ${relativeTo(entry, dirname(resolved))}:` +
            ' no regular SKILL.md');
        continue;
      }
      const paths = copies.get(name);
      if (paths === undefined) copies.set(name, [entry]);
      else paths.push(entry);
    }
  }
  return [copies, notes];
}

export function read_manifest(project: string): Map<string, unknown> {
  /** Read the adoption provenance manifest, or an empty one. */
  preflight_storage(project);
  const path = join(project, MANIFEST);
  if (!isFile(path)) {
    return new Map<string, unknown>([
      ['schema_version', 1n],
      ['skills', new Map<string, unknown>()],
    ]);
  }
  const text = readText(path);
  let data: unknown;
  try {
    data = pyJsonLoads(text);
  } catch (error) {
    // `json.loads` raises JSONDecodeError — a ValueError subclass that
    // propagates to `main`, which prints str(error) verbatim.
    const decode = jsonLoadsError(text);
    if (decode !== null) {
      throw new ValueError(jsonLoadsErrorMessage(text, decode));
    }
    throw error;
  }
  if (
    !isDict(data) ||
    !isOne(data.get('schema_version')) ||
    !isDict(data.get('skills'))
  ) {
    throw new ValueError(`Unrecognized ${MANIFEST}; preserve and review`);
  }
  for (const [name, record] of data.get('skills') as Map<string, unknown>) {
    validate_skill_name(name);
    if (!isDict(record)) {
      throw new ValueError(
        'Invalid manifest skill record; preserve and review');
    }
  }
  return data;
}

function library_skill_names(source: string): Set<string> {
  /** Names the pinned agent-workflows toolkit manages (clashes refused). */
  if (!isDir(join(source, '.agents/skills'))) return new Set();
  const [installed, reference] = toolkit(source, true);
  return new Set([...installed, ...reference]);
}

function frontmatter_fields(path: string): [key: string, value: string][] {
  /** Observable source/version metadata from a skill's frontmatter. */
  let content: string;
  try {
    content = readText(path);
  } catch (error) {
    if (error instanceof UnicodeDecodeError || isOSError(error)) return [];
    throw error;
  }
  if (!content.startsWith('---\n')) return [];
  const frontmatter = content.split('---', 3)[1];
  const fields: [string, string][] = [];
  for (const key of ['source', 'version']) {
    // Python `.` excludes only '\n' — it matches '\r', U+2028 and
    // U+2029, which JavaScript `.` treats as line terminators.
    const pattern = new RegExp(`^${key}:[ \\t]*([\\s\\S]+?)[ \\t]*$`);
    for (const line of frontmatter.split('\n')) {
      const match = pattern.exec(line);
      if (match !== null) {
        fields.push([key, match[1]]);
        break;
      }
    }
  }
  return fields;
}

interface Action {
  skill: string;
  op: string | null;
  paths: string[];
  remove: string[];
  links: string[];
  conflicts: string[];
  hash: string | null;
  keep: string | null;
  reason?: string;
  canonical_hash?: string;
}

export interface AdoptionPlan {
  actions: Action[];
  notes: string[];
}

function plan_links(
  action: Action,
  folders: [display: string, resolved: string][],
  canonical: string,
): void {
  /** Plan a link in every discovered folder that cannot read .agents/skills.
   *
   * Folders in NATIVE_AGENTS_SKILLS lose their copy without a link. A copy
   * that will be moved or removed frees its path for the replacement link.
   * Entries occupied by anything else are reported as conflicts, never
   * replaced. */
  for (const [, resolved] of folders) {
    // Use physical paths for both removal and links: aliases can have
    // different depths, so relative links must be based on their real
    // parent.
    const dest = join(resolved, action.skill);
    validate_destination(dirname(dirname(dirname(canonical))), dest);
    const native = folders
      .filter(([, other]) => other === resolved)
      .every(([folder]) =>
        NATIVE_AGENTS_SKILLS[basename(dirname(folder))] !== undefined);
    if (action.links.includes(dest) || action.conflicts.includes(dest)) {
      continue;
    }
    if (action.paths.some((path) => pyResolve(path) === dest)) {
      if (!native) action.links.push(dest);
      continue;
    }
    const state = link_status(dest, canonical);
    if (state === 'missing' && !native) {
      action.links.push(dest);
    } else if (state === 'occupied' || state === 'conflict') {
      action.conflicts.push(dest);
    }
  }
}

export function plan_adoption(
  project: string,
  source: string,
): AdoptionPlan {
  /** Compute the deterministic adoption plan without touching the tree. */
  const resolvedProject = pyResolve(project);
  preflight_storage(resolvedProject);
  const [folders, notes] = discover_folders(resolvedProject);
  const [copies, scanNotes] = scan_copies(folders);
  notes.push(...scanNotes);
  const records = read_manifest(resolvedProject).get('skills') as
    Map<string, unknown>;
  const toolkitNames = library_skill_names(source);
  const canonicalRoot = join(resolvedProject, CANONICAL);
  const actions: Action[] = [];
  for (const name of [...copies.keys()].sort(compareCodePoints)) {
    const paths = [...copies.get(name)!].sort(comparePathParts);
    const action: Action = {
      skill: name, paths, remove: [], links: [], conflicts: [],
      hash: null, keep: null, op: null,
    };
    validate_skill_name(name);
    const canonical = join(canonicalRoot, name);
    validate_destination(resolvedProject, canonical);
    const signatures = new Map<string, string>();
    const unsafe: string[] = [];
    for (const path of paths) {
      const [digest, bad] = skill_signature(path);
      signatures.set(path, digest);
      for (const rel of bad) {
        unsafe.push(`${relativeTo(path, resolvedProject)}:${rel}`);
      }
    }
    if (toolkitNames.has(name)) {
      action.op = 'refuse';
      action.reason = 'clashes with the pinned agent-workflows toolkit';
    } else if (unsafe.length) {
      action.op = 'refuse';
      action.reason = `unsafe entries: ${unsafe.join(', ')}`;
    } else if (new Set(signatures.values()).size !== 1) {
      const detail = [...signatures].map(([path, digest]) =>
        `${relativeTo(path, resolvedProject)} sha256:${digest.slice(0, 12)}`,
      ).join('; ');
      action.op = 'refuse';
      action.reason = `copies differ (${detail})`;
    } else {
      action.hash = signatures.values().next().value!;
      if (isSymlink(canonical) || (existsSync(canonical) && !isDir(canonical))) {
        action.op = 'refuse';
        action.reason =
          `${join(CANONICAL, name)} exists and is not a real directory`;
      } else if (isDir(canonical)) {
        const [current, bad] = skill_signature(canonical);
        action.canonical_hash = current;
        if (bad.length) {
          action.op = 'refuse';
          action.reason =
            `canonical contains unsafe entries: ${bad.join(', ')}`;
        } else if (current === action.hash) {
          action.op = 'dedupe';
          action.remove = [...paths];
        } else if (
          (records.get(name) as Map<string, unknown> | undefined)
            ?.get('hash') === `sha256:${current}`
        ) {
          // The canonical still matches the last adoption, so the
          // identical new copies are a vendor re-install (drift).
          action.op = 'update';
          action.keep = paths[0];
          action.remove = paths.slice(1);
        } else {
          action.op = 'refuse';
          action.reason = `copies differ from existing ${join(CANONICAL, name)}`;
        }
      } else {
        action.op = 'adopt';
        action.keep = paths[0];
        action.remove = paths.slice(1);
      }
    }
    if (action.op !== null && action.op !== 'refuse') {
      plan_links(action, folders, canonical);
    }
    actions.push(action);
  }
  // Adopted skills get links in newly discovered folders too; a removed
  // canonical leaves its links reported, never silently recreated.
  for (const name of [...records.keys()].sort(compareCodePoints)) {
    if (copies.has(name)) continue;
    validate_skill_name(name);
    const canonical = join(canonicalRoot, name);
    validate_destination(resolvedProject, canonical);
    if (isSymlink(canonical) || !isDir(canonical)) {
      for (const [skillsDir] of folders) {
        const dest = join(skillsDir, name);
        if (isSymlink(dest) && pyResolve(dest) === canonical) {
          notes.push(
            `broken adopted link: ${relativeTo(dest, resolvedProject)}` +
              ` (${join(CANONICAL, name)} is missing)`);
        }
      }
      continue;
    }
    const action: Action = {
      skill: name, op: 'relink', paths: [], remove: [], links: [],
      conflicts: [], hash: null, keep: null,
    };
    plan_links(action, folders, canonical);
    if (action.links.length || action.conflicts.length) actions.push(action);
  }
  return { actions, notes };
}

export function report_plan(project: string, plan: AdoptionPlan): string[] {
  /** Describe a plan (dry run) or applied result without writing. */
  const lines: string[] = [];
  for (const action of plan.actions) {
    const name = action.skill;
    const op = action.op;
    if (op === 'refuse') {
      const paths = action.paths
        .map((path) => relativeTo(path, project)).join(', ');
      lines.push(`refused: ${name} (${paths}): ${action.reason}`);
      continue;
    }
    if (op === 'adopt') {
      const paths = action.paths
        .map((path) => relativeTo(path, project)).join(', ');
      lines.push(`adopt: ${paths} -> ${join(CANONICAL, name)}`);
    } else if (op === 'dedupe') {
      lines.push(
        `dedupe: ${name} already in ${CANONICAL}; identical copies removed`);
    } else if (op === 'update') {
      lines.push(
        `update: ${name} drifted copies re-adopted over` +
          ` ${join(CANONICAL, name)}`);
    } else if (op === 'relink') {
      lines.push(`relink: ${name} missing harness links restored`);
    }
    for (const path of action.remove) {
      lines.push(`remove: ${relativeTo(path, project)}`);
    }
    for (const dest of action.links) {
      lines.push(`link: ${relativeTo(dest, project)} -> ${join(CANONICAL, name)}`);
    }
    for (const dest of action.conflicts) {
      lines.push(
        `conflict: ${relativeTo(dest, project)} is occupied; link skipped`);
    }
  }
  for (const note of plan.notes) lines.push(`note: ${note}`);
  return lines.length ? lines : ['nothing to do'];
}

function unchanged_copy(
  path: string,
  expectedHash: string | null | undefined,
): boolean {
  /** Check that a real copy still has the content observed during
   * planning. */
  if (isSymlink(path) || !isDir(path)) return false;
  let digest: string;
  let unsafe: string[];
  try {
    [digest, unsafe] = skill_signature(path);
  } catch (error) {
    if (isOSError(error)) return false;
    throw error;
  }
  return !unsafe.length && digest === expectedHash;
}

function safe_remove(
  path: string,
  expectedHash: string | null,
): string | null {
  /** Remove a real copy only while it still matches the planned content. */
  if (isSymlink(path) || !isDir(path)) {
    return !existsSync(path)
      ? null
      : `skipped: ${path} is not a real directory`;
  }
  const [digest, unsafe] = skill_signature(path);
  if (unsafe.length || digest !== expectedHash) {
    return `skipped: ${path} changed since planning; preserved`;
  }
  tryFs(() => rmSync(path, { recursive: true }));
  return null;
}

function provenance_record(
  project: string,
  action: Action,
  existing: Map<string, unknown> | undefined,
  command: string | null,
  today: string | null,
): Map<string, unknown> {
  /** Observable provenance for one adopted skill. */
  const record = new Map<string, unknown>(existing);
  record.set('hash', `sha256:${action.hash}`);
  if (!record.has('adopted')) record.set('adopted', today);
  if (action.op === 'update') record.set('updated', today);
  if (action.paths.length) {
    record.set(
      'paths', action.paths.map((path) => relativeTo(path, project)));
  }
  for (const [key, value] of frontmatter_fields(
    join(project, CANONICAL, action.skill, 'SKILL.md'),
  )) {
    record.set(key, value);
  }
  if (command !== null) record.set('command', command);
  return record;
}

export function apply_adoption(
  project: string,
  plan: AdoptionPlan,
  command: string | null = null,
  today: string | null = null,
): string[] {
  /** Perform the plan; no copy is removed before its canonical exists. */
  const resolvedProject = pyResolve(project);
  const canonicalRoot = join(resolvedProject, CANONICAL);
  const manifest = read_manifest(resolvedProject);
  const records = manifest.get('skills') as Map<string, unknown>;
  const before = pyJson(manifest);
  const lines: string[] = [];
  for (const action of plan.actions) {
    const name = action.skill;
    const op = action.op;
    if (op === 'refuse') {
      const paths = action.paths
        .map((path) => relativeTo(path, resolvedProject)).join(', ');
      lines.push(`refused: ${name} (${paths}): ${action.reason}`);
      continue;
    }
    validate_skill_name(name);
    const canonical = join(canonicalRoot, name);
    validate_destination(resolvedProject, canonical);
    // Planned sources use physical paths. Refuse any subsequent parent
    // redirection instead of following it into a different directory.
    const sources = action.paths;
    if (
      sources.some((path) =>
        pyResolve(dirname(path)) !== dirname(path) ||
        !isRelativeTo(dirname(path), resolvedProject) ||
        EXCLUDED.some((excluded) =>
          isRelativeTo(dirname(path), join(resolvedProject, excluded))))
    ) {
      lines.push(`skipped: ${name} source location changed; preserved`);
      continue;
    }
    if (
      action.links.some((dest) =>
        pyResolve(dirname(dest)) !== dirname(dest) ||
        !isRelativeTo(dirname(dest), resolvedProject) ||
        EXCLUDED.some((excluded) =>
          isRelativeTo(dirname(dest), join(resolvedProject, excluded))))
    ) {
      lines.push(`skipped: ${name} link location changed; preserved`);
      continue;
    }
    for (const dest of action.links) {
      validate_destination(resolvedProject, dest);
    }
    const expected = action.canonical_hash;
    if (
      (op === 'dedupe' || op === 'update') &&
      !unchanged_copy(canonical, expected)
    ) {
      lines.push(
        `skipped: ${name} canonical changed since planning; preserved`);
      continue;
    }
    if (
      (op === 'adopt' || op === 'update') &&
      !unchanged_copy(action.keep!, action.hash)
    ) {
      lines.push(
        `skipped: ${name} selected copy changed since planning; preserved`);
      continue;
    }
    if (op === 'adopt' && (existsSync(canonical) || isSymlink(canonical))) {
      lines.push(
        `skipped: ${name} canonical appeared since planning; preserved`);
      continue;
    }
    if (op === 'adopt') {
      tryFs(() => mkdirSync(canonicalRoot, { recursive: true }));
      tryRename(action.keep!, canonical);
      lines.push(
        `adopted: ${relativeTo(canonical, resolvedProject)}` +
          ` (from ${relativeTo(action.keep!, resolvedProject)})`);
    } else if (op === 'update') {
      const backup = join(canonicalRoot, `.${name}.adopt-backup`);
      if (existsSync(backup) || isSymlink(backup)) {
        lines.push(`skipped: ${name} backup path occupied; preserved`);
        continue;
      }
      tryRename(canonical, backup);
      if (!unchanged_copy(backup, expected)) {
        tryRename(backup, canonical);
        lines.push(`skipped: ${name} canonical changed; preserved`);
        continue;
      }
      try {
        tryRename(action.keep!, canonical);
      } catch (error) {
        if (isOSError(error)) tryRename(backup, canonical);
        throw error;
      }
      const [appliedDigest, appliedUnsafe] = skill_signature(canonical);
      if (appliedUnsafe.length || appliedDigest !== action.hash) {
        tryRename(canonical, join(canonicalRoot, `.${name}.adopt-failed`));
        tryRename(backup, canonical);
        throw new ValueError(
          `Adopted copy changed during apply: ${canonical};` +
            ' the previous canonical was restored');
      }
      if (!unchanged_copy(backup, expected)) {
        throw new ValueError(`Canonical backup changed; preserved at ${backup}`);
      }
      tryFs(() => rmSync(backup, { recursive: true }));
      lines.push(
        `updated: ${relativeTo(canonical, resolvedProject)}` +
          ' (drift re-adoption)');
    } else if (op === 'dedupe') {
      lines.push(
        `deduped: ${name} already in ${CANONICAL}; identical copies removed`);
    }
    if (
      (op === 'adopt' || op === 'update' || op === 'dedupe') &&
      !unchanged_copy(canonical, action.hash)
    ) {
      lines.push(
        `skipped: ${name} canonical changed during apply;` +
          ' copies preserved');
      continue;
    }
    for (const path of action.remove) {
      if (!unchanged_copy(canonical, action.hash)) {
        throw new ValueError(
          `Canonical changed during apply: ${canonical}; copies preserved`);
      }
      const skipped = safe_remove(path, action.hash);
      lines.push(skipped ?? `removed: ${relativeTo(path, resolvedProject)}`);
    }
    for (const dest of action.links) {
      const state = link_status(dest, canonical);
      if (state === 'missing') {
        make_relative_link(dest, canonical);
        lines.push(`linked: ${relativeTo(dest, resolvedProject)}`);
      } else if (state !== 'linked') {
        lines.push(
          `conflict: ${relativeTo(dest, resolvedProject)} is` +
            ' occupied; link skipped');
      }
    }
    for (const dest of action.conflicts) {
      lines.push(
        `conflict: ${relativeTo(dest, resolvedProject)} is occupied;` +
          ' link skipped');
    }
    if (op === 'adopt' || op === 'update' || op === 'dedupe') {
      records.set(
        name,
        provenance_record(
          resolvedProject, action,
          records.get(name) as Map<string, unknown> | undefined,
          command, today,
        ),
      );
    }
  }
  if (pyJson(manifest) !== before) {
    const manifestPath = join(resolvedProject, MANIFEST);
    tryFs(() => mkdirSync(dirname(manifestPath), { recursive: true }));
    preflight_storage(resolvedProject);
    // tempfile.NamedTemporaryFile(dir=..., prefix=".adoption-",
    // delete=False) then os.replace; a leftover candidate is removed either
    // way.
    let temporary: string | null = null;
    try {
      const text = dumpsOrdered(manifest) + '\n';
      for (;;) {
        temporary = join(
          dirname(manifestPath),
          `.adoption-${randomBytes(8).toString('hex')}`,
        );
        let fd: number;
        try {
          fd = openSync(temporary, 'wx', 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
          throw pyOsError(error);
        }
        try {
          writeSync(fd, text);
        } finally {
          closeSync(fd);
        }
        break;
      }
      tryRename(temporary, manifestPath);
    } finally {
      if (temporary !== null && existsSync(temporary)) {
        tryFs(() => unlinkSync(temporary!));
      }
    }
    lines.push(`recorded: ${MANIFEST}`);
  }
  for (const note of plan.notes) lines.push(`note: ${note}`);
  return lines.length ? lines : ['nothing to do'];
}

/** `date.today().isoformat()` — the local calendar date. */
function todayIso(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(now.getFullYear()).padStart(4, '0')}` +
    `-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface AdoptOptions {
  apply?: boolean;
  command?: string | null;
  today?: string | null;
}

export function adopt(
  project: string,
  source: string,
  options: AdoptOptions = {},
): string[] {
  /** Plan, and optionally perform, skill adoption for a consumer project. */
  const resolvedProject = pyResolve(project);
  const command = options.command ?? null;
  const redacted = command !== null ? redact_command(command) : null;
  const plan = plan_adoption(resolvedProject, source);
  if (options.apply !== true) return report_plan(resolvedProject, plan);
  return apply_adoption(
    resolvedProject, plan, redacted, options.today || todayIso());
}

// ---------------------------------------------------------------------------
// argparse-compatible command line.
// ---------------------------------------------------------------------------

const PROG = 'agent-workflows.ts adopt_skills';
const USAGE =
  `usage: ${PROG} [-h] [--project PROJECT] [--apply | --check]\n` +
  '                       [--command COMMAND]';

const HELP_TEXT =
  `${USAGE}\n` +
  '\n' +
  'Adopt third-party skill copies into a single `.agents/skills` location. Vendor\n' +
  'installers (for example `npx skills add ...`) copy each skill into per-harness\n' +
  'folders such as `.claude/skills`. This helper consolidates identical copies\n' +
  'into `.agents/skills/<name>` — the layout the agent-workflows toolkit already\n' +
  'uses — and leaves a relative symlink in every discovered harness folder that\n' +
  'cannot read `.agents/skills` natively, reusing the same\n' +
  'link_status/make_relative_link helpers as `agent-workflows.ts install\n' +
  '--claude-skills`. Copies\n' +
  'are compared by content and are never removed before the canonical skill\n' +
  'exists; differing copies, toolkit name clashes and unsafe entries are refused\n' +
  'and reported. The default mode is a dry run; pass --apply to write. Provenance\n' +
  'is recorded in `.agents/adopted-skills.json`. The helper never runs vendor\n' +
  'installers. See docs/skill-distribution.md.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help         show this help message and exit\n' +
  '  --project PROJECT\n' +
  '  --apply            Perform the planned adoption (default is a dry run)\n' +
  '  --check            Explicit dry run (already the default)\n' +
  '  --command COMMAND  Optional provenance: the vendor install command; secret-\n' +
  '                     looking values are redacted before recording\n';

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
  dest: 'help' | 'project' | 'apply' | 'check' | 'command';
  takesValue: boolean;
  mutex?: 'apply' | 'check';
}

const OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--project'], dest: 'project', takesValue: true },
  { names: ['--apply'], dest: 'apply', takesValue: false, mutex: 'check' },
  { names: ['--check'], dest: 'check', takesValue: false, mutex: 'apply' },
  { names: ['--command'], dest: 'command', takesValue: true },
];

/**
 * argparse's `_parse_optional` classification: a `-`-leading token is a
 * value when it is `-` alone, a negative number (this parser has no
 * negative-number options) or contains a space.
 */
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
  while (index < argv.length) {
    const arg = argv[index];
    index += 1;
    if (pastSeparator) {
      extras.push(arg);
      continue;
    }
    if (arg === '--') {
      // A parser with no positional arguments never consumes `--`; on
      // CPython 3.12 it lands in the unrecognized-arguments tail with
      // everything after it.
      pastSeparator = true;
      extras.push(arg);
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const optName = eq < 0 ? arg : arg.slice(0, eq);
      const explicit = eq < 0 ? undefined : arg.slice(eq + 1);
      let option = OPTIONS.find((o) => o.names.includes(optName));
      if (option === undefined) {
        // allow_abbrev: an unambiguous prefix of one option resolves; more
        // than one is an ambiguous-option error, zero is an extra.
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
              ` ${pyRepr(explicit)}`,
          );
        }
        process.stdout.write(HELP_TEXT);
        throw new ExitError(0);
      }
      if (!option.takesValue) {
        if (explicit !== undefined) {
          parserError(
            `argument ${optionLabel(option)}: ignored explicit argument` +
              ` ${pyRepr(explicit)}`,
          );
        }
        // `take_action` checks the mutually exclusive group after the
        // option's own value validation.
        if (option.mutex !== undefined && values[option.mutex] === true) {
          const other = OPTIONS.find((o) => o.dest === option.mutex)!;
          parserError(
            `argument ${optionLabel(option)}: not allowed with` +
              ` argument ${optionLabel(other)}`,
          );
        }
        values[option.dest] = true;
        continue;
      }
      let value = explicit;
      if (value === undefined) {
        const next = argv[index];
        if (next === undefined || next === '--' || isOptionLike(next)) {
          parserError(
            `argument ${optionLabel(option)}: expected one argument`,
          );
        }
        value = next;
        index += 1;
      }
      values[option.dest] = value;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // `_parse_optional` for the parser's only short option: an exact
      // `-h`, the `=`-split `-h=...`, or a `-h<tail>` cluster reaches the
      // help action; anything else is an unrecognized optional.
      let explicit: string | undefined;
      let sep = '';
      if (arg === '-h') {
        // The plain flag reaches the help action without an argument.
      } else if (arg.slice(0, 2) === '-h') {
        if (arg[2] === '=') {
          sep = '=';
          explicit = arg.slice(3);
        } else {
          explicit = arg.slice(2);
        }
      } else {
        extras.push(arg);
        continue;
      }
      // `consume_optional`: a no-argument single-dash option re-reads an
      // explicit tail as more short options. Only `-h` exists, so a run
      // of `h`s is consumed and an unknown tail lands in extras — but
      // the queued help action still fires first — while a `=`-separated
      // or `-`-leading remainder is an ignored-explicit-argument error.
      const help = OPTIONS.find((o) => o.dest === 'help')!;
      while (explicit !== undefined) {
        if (explicit === '' || sep === '=' || explicit[0] === '-') {
          parserError(
            `argument ${optionLabel(help)}: ignored explicit argument` +
              ` ${pyRepr(explicit)}`,
          );
        }
        if (explicit[0] === 'h') {
          const tail = explicit.slice(1);
          if (tail === '') explicit = undefined;
          else if (tail[0] === '=') {
            sep = '=';
            explicit = tail.slice(1);
          } else {
            sep = '';
            explicit = tail;
          }
        } else {
          break;
        }
      }
      process.stdout.write(HELP_TEXT);
      throw new ExitError(0);
    }
    extras.push(arg);
  }
  return { values, extras };
}

function libraryRoot(): string {
  return dirname(dirname(pyResolve(fileURLToPath(import.meta.url))));
}

function isReportable(error: unknown): boolean {
  // `except (ValueError, OSError)` — UnicodeDecodeError is a ValueError
  // subclass, and the OS-error names come out of pyio/tryFs wrappers.
  return (
    error instanceof ValueError ||
    (error as Error).name === 'UnicodeDecodeError' ||
    isOSError(error)
  );
}

function runMain(argv: string[]): number {
  const { values, extras } = parseArgs(argv);
  if (extras.length) {
    parserError(`unrecognized arguments: ${extras.join(' ')}`);
  }
  let lines: string[];
  try {
    lines = adopt((values.project as string | undefined) ?? '.', libraryRoot(), {
      apply: values.apply === true,
      command: (values.command as string | undefined) ?? null,
    });
  } catch (error) {
    if (isReportable(error)) {
      console.error((error as Error).message);
      return 1;
    }
    throw error;
  }
  for (const line of lines) console.log(line);
  if (values.apply !== true) {
    console.log('dry run: rerun with --apply to perform these changes');
  }
  return 0;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    return runMain(argv);
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
}

// `if __name__ == "__main__"`: Node resolves the invoked entry to its
// real path for import.meta.url while argv[1] keeps the typed spelling,
// so an invocation through a symlink must be resolved before comparing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(pyResolve(process.argv[1])).href
) {
  process.exitCode = main();
}
