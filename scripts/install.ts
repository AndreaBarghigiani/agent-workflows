/**
 * Install the versioned toolkit and optional Codex profiles.
 *
 * Every consumer receives the standard toolkit derived from the pinned
 * library version: installed links and reference-only pointers follow each
 * skill's `distribution` frontmatter. Basic Memory is one optional
 * capability; its setup skill is installed only through the setup_memory
 * command after an explicit recorded choice. Basic Memory's own skills are not
 * shipped here: consumers install them from upstream at the release
 * matching their server (docs/memory/upstream-skills.md). Claude Code
 * discovers project skills only from `.claude/skills`, so the same
 * installed links are mirrored there only with the opt-in
 * `--claude-skills` flag (see docs/claude.md). The opt-in
 * `--delivery-profiles` flag creates an empty consumer-owned
 * `.agents/delivery-profiles.json` only when missing; an existing file is
 * preserved byte-for-byte and never populated, replaced or repaired.
 * Refreshing a consumer also retires proven toolkit-owned links and exact
 * copies of skills the pinned toolkit no longer ships; same-name content
 * that is not proven toolkit-owned is preserved and reported, never
 * removed by name alone (see docs/integrations.md). When the source is a
 * registered submodule of the project, the helper also keeps it detached
 * at the consumer's recorded pin (see consumer_pin).
 */
import { antigravitySetupNotice } from './lib/antigravity_setup.ts';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runGit } from './lib/git.ts';
import type { GitResult } from './lib/git.ts';
import {
  osErrorName,
  RuntimeError,
  UnicodeDecodeError,
  ValueError,
} from './lib/pyerrors.ts';
import { pyDecodeUtf8, readText } from './lib/pyio.ts';
import {
  jsonLoadsError,
  jsonLoadsErrorMessage,
  PyFloat,
  pyJsonLoads,
} from './lib/pyloads.ts';
import { pyRepr } from './lib/pyrepr.ts';

export const MEMORY_SKILLS = ['setup-basic-memory'];
// Upstream skills this library vendored until 0.3.0. Links to them dangle
// after an update; only those exact broken links are retired automatically.
export const RETIRED_MEMORY_SKILLS = [
  'memory-notes', 'memory-capture', 'memory-continue', 'memory-schema',
];
// Toolkit skills the library itself shipped until 0.4.1, with the sha256 of
// each file they shipped at that revision. On refresh, a broken consumer
// link resolving to the retired path inside the pinned library, or a real
// directory whose complete file set matches these recorded hashes, is
// proven toolkit-owned and retired. A matching name alone never proves
// ownership, so no equivalent retirement exists for the third-party memory
// skills above.
export const RETIRED_TOOLKIT_SKILLS: Record<string, Record<string, string>> = {
  'add-integration': {
    'SKILL.md': '793d19738cd7484892df6cff74c84f00bc581518502550c78564e6289deed99e',
  },
  'use-integration': {
    'SKILL.md': 'f69cb576f072c67ea8dc3c4932f840d40b2e2b9ee407f190d6d30ad277d804f9',
  },
};
export const SKILLS_LOCK = 'skills-lock.json';
export const CAPABILITIES_FILE = '.agent-workflows-capabilities.json';
export const CLAUDE_SKILLS = '.claude/skills';
export const CLAUDE_INSTRUCTIONS = 'CLAUDE.md';
export const DELIVERY_PROFILES = '.agents/delivery-profiles.json';
export const SKILLS_MIGRATION =
  '--skills was removed: consumers install the standard toolkit derived from' +
  ' the pinned library version instead of a skill selection. Rerun without' +
  ' --skills; unexpected local files are reported, never removed. See' +
  ' docs/skill-distribution.md and docs/memory/migration.md.';

export const START = '<!-- agent-workflows:worktrees:start -->';
export const END = '<!-- agent-workflows:worktrees:end -->';
export const REF_START = '<!-- agent-workflows:reference-only:start -->';
export const REF_END = '<!-- agent-workflows:reference-only:end -->';
export const COLLAB_START = '<!-- agent-workflows:collaboration:start -->';
export const COLLAB_END = '<!-- agent-workflows:collaboration:end -->';
export const COLLAB_BLOCK =
  `${COLLAB_START}\n## Working with the owner\n\n` +
  'The owner is a software engineer who edits the working tree and commits\n' +
  'concurrently.\n\n' +
  '- Re-check `git status` and `git log` before verifying or completing\n' +
  '  anything; treat committed owner changes as the design contract, not drift.\n' +
  '- Keep tests green as the contract for owner edits: update tests to the\n' +
  '  new design when intent is clear, and ask targeted questions when it is not.\n' +
  '- Challenge the owner when evidence contradicts a decision. Agreement is\n' +
  '  not the goal; disagreement is a learning signal for both sides.\n' +
  '- Default to the repository\'s integration branch only for mechanical\n' +
  '  chores (submodule bumps, generated-file re-syncs, lockfile refreshes);\n' +
  '  use a branch and pull request for anything else, and state the\n' +
  '  branching choice before committing when it was not explicitly\n' +
  '  requested.\n' +
  '- Before extending work into another project, identify the destination and\n' +
  '  benefit, then offer both a handoff prompt for a dedicated session (the usual\n' +
  '  preference) and continuing here with explicit authorization for that project\n' +
  '  and change. Wait for the owner\'s choice before editing there or launching\n' +
  '  another session or delegate to do so; preserve authorization already given.\n' +
  '- Use the harness\'s selected project, or the session\'s starting repository and\n' +
  '  agreed task scope, to identify the project boundary. Access, shared memory,\n' +
  '  similar structure, and changing directories do not expand authorization.\n' +
  '  Respect the harness\'s workspace binding and preserve existing work.\n' +
  '  Editing a submodule\'s source is distinct from updating its consumer pin.\n' +
  '  When cross-project work is authorized, read the destination\'s instructions\n' +
  '  and check whether the change fits its implementation.\n' +
  `${COLLAB_END}`;

// ---------------------------------------------------------------------------
// Python-semantics path and string helpers (Path, os.path, str).
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

/**
 * CPython 3.12 `posixpath._joinrealpath` (`strict=False`): walk `rest`
 * component by component onto `path`, resolving each symlink against the
 * already-resolved prefix (link targets may carry `..`). A symlink loop
 * returns the resolved prefix plus the unresolved rest (`ok: false`); the
 * `seen` map caches each link's resolution like the original.
 */
function joinRealpath(
  path: string,
  rest: string,
  seen: Map<string, string | null>,
): { path: string; ok: boolean } {
  if (isAbsolute(rest)) {
    rest = rest.slice(1);
    path = sep;
  }
  while (rest !== '') {
    const index = rest.indexOf(sep);
    const name = index < 0 ? rest : rest.slice(0, index);
    rest = index < 0 ? '' : rest.slice(index + 1);
    if (name === '' || name === '.') continue;
    if (name === '..') {
      if (path !== '') {
        const tail = basename(path);
        path = dirname(path);
        if (tail === '..') path = join(path, '..', '..');
      } else {
        path = '..';
      }
      continue;
    }
    const newpath = path === '' ? name : join(path, name);
    const st = lstatOrNull(newpath);
    // Any lstat failure (the non-strict ignored OSError) reads "not a link".
    if (st === null || !st.isSymbolicLink()) {
      path = newpath;
      continue;
    }
    if (seen.has(newpath)) {
      const cached = seen.get(newpath);
      if (cached != null) {
        path = cached;
        continue;
      }
      // The symlink is not resolved, so we must have a symlink loop.
      return { path: join(newpath, rest), ok: false };
    }
    seen.set(newpath, null);
    const resolved = joinRealpath(path, readlinkSync(newpath), seen);
    path = resolved.path;
    if (!resolved.ok) return { path: join(path, rest), ok: false };
    seen.set(newpath, path);
  }
  return { path, ok: true };
}

/**
 * `Path.resolve(strict=False)` — `realpath` then `abspath`, then the
 * `stat()` non-strict resolve runs on the result: a symlink loop that
 * `realpath` quietly returned raises `RuntimeError("Symlink loop from
 * %r" % filename)`, while other stat failures (a missing path included)
 * are ignored like the original.
 */
export function pyResolve(path: string): string {
  const resolved = joinRealpath('', path, new Map());
  const result = isAbsolute(resolved.path)
    ? normalize(resolved.path)
    : resolve(resolved.path);
  try {
    statSync(result);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new RuntimeError(`Symlink loop from ${pyRepr(result)}`);
    }
  }
  return result;
}

/** `os.path.relpath` — lexical; `'.'` where `path.relative` yields `''`. */
function pyRelpath(target: string, start: string): string {
  const rel = relative(start, target);
  return rel === '' ? '.' : rel;
}

/** `PurePath.is_relative_to` — a lexical component-prefix check. */
function isRelativeTo(target: string, root: string): boolean {
  return (
    target === root ||
    target.startsWith(root.endsWith('/') ? root : `${root}/`)
  );
}

/** `root in target.parents` — a proper ancestor only. */
function inParents(target: string, root: string): boolean {
  return target !== root && isRelativeTo(target, root);
}

/**
 * Python `str.strip()`/`\s` whitespace: the ASCII controls Python counts
 * (including \x1c-\x1f and \x85 that JavaScript `\s` lacks), the space, and
 * the Unicode separators — minus U+FEFF, which Python is not whitespace.
 */
const PY_WS =
  '\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004' +
  '\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';

/** `str.strip()` over Python's whitespace set. */
function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WS.includes(text[start])) start += 1;
  while (end > start && PY_WS.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `str.rstrip("\r\n")` — strip only those two characters. */
function pyRstripNewline(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === '\r' || text[end - 1] === '\n')) {
    end -= 1;
  }
  return text.slice(0, end);
}

// The PY_WS set as a regex character class (escaped once for reuse).
const PY_WS_CLASS =
  '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029' +
  '\\u202f\\u205f\\u3000';
const PY_WS_RE = new RegExp(`[${PY_WS_CLASS}]+`, 'u');

/** `str.split()` — runs of Python whitespace, edges stripped. */
function pySplit(text: string): string[] {
  const stripped = pyStrip(text);
  if (stripped === '') return [];
  return stripped.split(PY_WS_RE);
}

const LINE_BREAK = /\r\n|[\n\v\f\x1c\x1d\x1e\x85\u2028\u2029\r]/g;

/** `str.splitlines(keepends=True)` over Python's full line-break set. */
function pySplitlines(text: string, keepends: boolean): string[] {
  const lines: string[] = [];
  let last = 0;
  LINE_BREAK.lastIndex = 0;
  for (let match = LINE_BREAK.exec(text); match !== null;
    match = LINE_BREAK.exec(text)) {
    const end = keepends ? match.index + match[0].length : match.index;
    lines.push(text.slice(last, end));
    last = match.index + match[0].length;
  }
  if (last < text.length) lines.push(text.slice(last));
  return lines;
}

/**
 * `sorted(...)` on names — Python compares strings by code point; the
 * default JavaScript sort uses UTF-16 code units, which inverts BMP
 * characters at or above U+E000 against astral characters.
 */
export function compareCodePoints(a: string, b: string): number {
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

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** `json.loads(path.read_text())` — pyJsonLoads over a readText string. */
function jsonFile(path: string): unknown {
  return pyJsonLoads(readText(path));
}

/**
 * The `str(JSONDecodeError)` CPython embeds in diagnostics, or the thrown
 * error's own message when `jsonLoadsError` cannot re-derive it.
 */
function decodeReason(text: string, error: unknown): string {
  try {
    const decodeError = jsonLoadsError(text);
    if (decodeError !== null) {
      return jsonLoadsErrorMessage(text, decodeError);
    }
  } catch {
    // A non-decode failure keeps the thrown error's own message.
  }
  return error instanceof Error ? error.message : String(error);
}

/** `isinstance(value, dict)` over pyJsonLoads' Map materialization. */
function isDict(value: unknown): value is Map<string, unknown> {
  return value instanceof Map;
}

/** Python `==` for the `data["schema_version"] != 1` comparisons. */
function isOne(value: unknown): boolean {
  // `True == 1` and `1.0 == 1` hold in Python; `False`, `"1"` and other
  // values do not.
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value === 1n;
  if (typeof value === 'number') return value === 1;
  if (value instanceof PyFloat) return value.value === 1;
  return false;
}

// ---------------------------------------------------------------------------
// install.py — the port.
// ---------------------------------------------------------------------------

export function block_state(
  text: string,
  start: string,
  end: string,
  expected: string,
): string {
  /** Classify a managed block as missing, malformed, customized or current. */
  if (!text.includes(start) && !text.includes(end)) return 'missing';
  if (
    text.split(start).length - 1 !== 1 ||
    text.split(end).length - 1 !== 1 ||
    text.indexOf(start) > text.indexOf(end)
  ) {
    return 'malformed';
  }
  const current = text.slice(
    text.indexOf(start),
    text.indexOf(end) + end.length,
  );
  return current === expected ? 'current' : 'customized';
}

type ManagedBlock = [start: string, end: string, name: string, block: string];

export function apply_policy_blocks(
  existing: string,
  blocks: ManagedBlock[],
  path = 'AGENTS.md',
): string {
  /** Merge persistent policy blocks into consumer instructions. */
  let updated = existing;
  for (const [start, end, name, block] of blocks) {
    const state = block_state(updated, start, end, block);
    if (state === 'malformed') {
      throw new ValueError(
        `Malformed ${name} block in ${path} (markers \`${start}\`/\`${end}\`);` +
          ' preserve and review',
      );
    }
    if (state === 'customized') {
      throw new ValueError(
        `Customized ${name} block in ${path} (markers \`${start}\`/\`${end}\`);` +
          ' preserve and review an explicit edit',
      );
    }
    if (state === 'missing') {
      updated =
        updated + (updated.endsWith('\n') ? '\n' : '\n\n') + block + '\n';
    }
  }
  return updated;
}

const SHLEX_UNSAFE = /[^\w@%+=:,./-]/;

/** `shlex.quote` — safe strings verbatim, else single-quoted. */
export function shlexQuote(text: string): string {
  if (text === '') return "''";
  if (!SHLEX_UNSAFE.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

export function repair_command(
  source: string,
  project: string,
  script = 'install.py',
  options: string[] = [],
): string {
  /** Suggested repair command using the actual library path, run from the
   * consumer root. */
  const launcher = pyRelpath(
    join(pyResolve(source), 'bin', 'agent-workflows.ts'),
    pyResolve(project),
  );
  const stem = script.replace(/\.py$/, '');
  let command = `node ${shlexQuote(launcher)} ${stem} --project .`;
  if (options.length) command += ` ${options.join(' ')}`;
  return command;
}

export function install_command_options(
  codex_agents = false,
  claude_skills = false,
  delivery_profiles = false,
): string[] {
  /** Requested setup flags to preserve verbatim in repair commands. */
  const options: string[] = [];
  if (codex_agents) options.push('--codex-agents');
  if (claude_skills) options.push('--claude-skills');
  if (delivery_profiles) options.push('--delivery-profiles');
  return options;
}

export function remove_legacy_worktree_block(
  existing: string,
  source: string,
  project: string,
  path = 'AGENTS.md',
): string {
  /** Remove only the exact worktree block generated by older installers. */
  if (!existing.includes(START) && !existing.includes(END)) return existing;
  if (
    existing.split(START).length - 1 !== 1 ||
    existing.split(END).length - 1 !== 1 ||
    existing.indexOf(START) > existing.indexOf(END)
  ) {
    throw new ValueError(
      `Malformed or duplicated legacy worktree block in ${path}` +
        ` (markers \`${START}\`/\`${END}\`); preserve and review`,
    );
  }
  const policy = pyRelpath(join(source, 'docs/worktrees.md'), project);
  const block =
    `${START}\n## Worktrees\n\n` +
    'Create a worktree only when requested by the user or selected through the harness.\n' +
    'Keep linked worktrees under `<main-checkout-parent>/worktrees/<project>/<task>/`.\n' +
    `Read \`${policy}\` before creating, moving or removing a worktree.\n` +
    'After a verified PR merge, remove its task worktree once preservation checks pass;\n' +
    'submodules alone do not prevent cleanup. Preserve existing work and authorization.\n' +
    `${END}`;
  const start = existing.indexOf(START);
  const end = existing.indexOf(END) + END.length;
  if (existing.slice(start, end) !== block) {
    throw new ValueError(
      `Customized legacy worktree block in ${path}` +
        ` (markers \`${START}\`/\`${END}\`); preserve and review an explicit edit`,
    );
  }
  return existing.slice(0, start) + existing.slice(end);
}

export function is_reference_only_text(content: string): boolean {
  /** `is_reference_only` over SKILL.md text already in hand. */
  if (!content.startsWith('---\n')) return false;
  const frontmatter = content.split('---', 3)[1];
  // `re.search(r"^distribution:\s*reference-only\s*$", ..., re.MULTILINE)`:
  // Python `^`/`$` honour only `\n` boundaries, so each `\n` segment is
  // tested with an anchored match instead of a JavaScript `m` flag (which
  // would also split on \r, U+2028 and U+2029).
  return frontmatter
    .split('\n')
    .some((line) => PY_WS_ANCHORED_DISTRIBUTION.test(line));
}

export function is_reference_only(skill: string): boolean {
  /** Report whether a skill's frontmatter marks it shared, not installed. */
  return is_reference_only_text(readText(skill));
}

const PY_WS_ANCHORED_DISTRIBUTION = new RegExp(
  `^distribution:[${PY_WS_CLASS}]*reference-only[${PY_WS_CLASS}]*$`,
  'u',
);

export function third_party_skills(root: string): Set<string> {
  /** Names a third-party skill installer recorded in the root lock file.
   *
   * Skills another tool installed into `.agents/skills` (for example the
   * upstream Basic Memory skills in the library's own checkout) are never
   * part of this library's toolkit. An unreadable lock is preserved for
   * review. */
  const path = join(root, SKILLS_LOCK);
  if (!isFile(path)) return new Set();
  // `except json.JSONDecodeError` only: a `read_text()` failure
  // (UnicodeDecodeError, OSError) propagates out of the function.
  return third_party_skills_text(readText(path));
}

export function third_party_skills_text(
  text: string,
  origin: string = SKILLS_LOCK,
): Set<string> {
  /** `third_party_skills` over lock-file text already in hand. */
  let data: unknown;
  try {
    data = pyJsonLoads(text);
  } catch (error) {
    throw new ValueError(
      `Unreadable ${origin}; preserve and review: ` +
        decodeReason(text, error),
    );
  }
  const skills = isDict(data) ? data.get('skills') : undefined;
  return isDict(skills) ? new Set(skills.keys()) : new Set();
}

function _retired_links(
  source: string,
  directories: string[],
  names: Iterable<string>,
): string[] {
  /** Broken consumer links whose target is a retired library skill path.
   *
   * A link qualifies only when it is a symlink, its target no longer
   * exists, and that target is the retired skill's path inside the pinned
   * library. Real directories and links elsewhere never qualify. */
  const skill_root = join(pyResolve(source), '.agents/skills');
  const found: string[] = [];
  const seen = new Set<string>();
  for (const directory of directories) {
    for (const name of names) {
      const entry = join(directory, name);
      // Two directory paths can be one folder (a linked .claude/skills).
      const identity = join(pyResolve(directory), name);
      if (
        !seen.has(identity) &&
        isSymlink(entry) &&
        !existsSync(entry) &&
        pyResolve(entry) === join(skill_root, name)
      ) {
        seen.add(identity);
        found.push(entry);
      }
    }
  }
  return found;
}

export function retired_memory_links(
  source: string,
  project: string,
  directories: string[],
): string[] {
  /** Find broken links to the upstream skills this library used to vendor.
   *
   * A link qualifies only when it is a symlink, its target no longer
   * exists, and that target is the retired skill's path inside the pinned
   * library. Real directories (an upstream install) and links elsewhere
   * never qualify. */
  const resolvedSource = pyResolve(source);
  const resolvedProject = pyResolve(project);
  if (resolvedSource === resolvedProject) {
    // The library never linked to itself; broken links in its own checkout
    // belong to whichever tool created them.
    return [];
  }
  return _retired_links(resolvedSource, directories, RETIRED_MEMORY_SKILLS);
}

function _retired_copy(entry: string, name: string): boolean {
  /** Whether a real directory is a byte-exact copy of a retired toolkit
   * skill.
   *
   * The proof is the complete file set and content recorded in
   * RETIRED_TOOLKIT_SKILLS, never the name alone: a symlink, a special
   * entry, or any added, missing or differing file makes the directory
   * ambiguous consumer content. */
  const expected = RETIRED_TOOLKIT_SKILLS[name];
  if (expected === undefined || isSymlink(entry) || !isDir(entry)) {
    return false;
  }
  // os.walk puts every subdirectory in `dirnames`, where the original's
  // `not path.is_file()` check fails it — so every entry must be a regular
  // non-symlink file and a flat scan is sufficient.
  const contents = new Map<string, string>();
  for (const item of tryFs(() => readdirSync(entry)).sort(compareCodePoints)) {
    const path = join(entry, item);
    const st = lstatOrNull(path);
    if (st === null || st.isSymbolicLink() || !st.isFile()) return false;
    if (!(item in expected)) return false;
    contents.set(item, path);
  }
  const expectedNames = Object.keys(expected);
  return (
    contents.size === expectedNames.length &&
    [...contents.keys()].every(
      (relativeName) =>
        sha256File(contents.get(relativeName)!) === expected[relativeName],
    )
  );
}

function _same_name_reason(
  source: string,
  entry: string,
  name: string,
): string {
  /** Why a same-name entry is not recognized as toolkit-owned. */
  const skill_root = join(pyResolve(source), '.agents/skills');
  if (isSymlink(entry)) {
    const target = pyResolve(entry);
    if (target === join(skill_root, name)) {
      // Reachable only while the target still exists, for example a
      // consumer-side copy inside a standalone library checkout.
      return (
        `link still resolves to ${target}; retarget it or remove` +
        ' the library-side copy after review'
      );
    }
    return `same-name link outside the retired toolkit path (${target})`;
  }
  if (isDir(entry)) {
    const marker = join(entry, 'SKILL.md');
    if (isSymlink(marker) || !isFile(marker)) {
      return 'same-name directory without a regular SKILL.md';
    }
    return 'same-name directory whose content differs from the retired toolkit skill';
  }
  return 'same-name entry that is neither a link nor a directory';
}

export function retirement_folders(
  project: string,
  directories: string[],
): string[] {
  /** Include contained harness skill folders without entering library
   * storage. */
  const folders = [...directories];
  const excluded = new Set(['.agents', '.agent-workflows', '.git']);
  for (const harness of tryFs(() => readdirSync(project))
    .sort(compareCodePoints)) {
    if (
      !harness.startsWith('.') ||
      excluded.has(harness) ||
      isSymlink(join(project, harness)) ||
      !isDir(join(project, harness))
    ) {
      continue;
    }
    const folder = join(project, harness, 'skills');
    const resolved = pyResolve(folder);
    if (
      isDir(folder) &&
      isRelativeTo(resolved, project) &&
      !['.agent-workflows', '.git'].some((name) =>
        isRelativeTo(resolved, pyResolve(join(project, name)))
      )
    ) {
      folders.push(folder);
    }
  }
  return folders;
}

export function retired_copy_protection(
  project: string,
  entry: string,
  name: string,
  directories: string[],
): string | null {
  /** Consumer provenance or incoming links override a content match. */
  const manifest = join(project, '.agents/adopted-skills.json');
  if (existsSync(manifest) || isSymlink(manifest)) {
    try {
      if (isSymlink(manifest) || !isFile(manifest)) {
        throw new ValueError('unsafe manifest');
      }
      const data = jsonFile(manifest);
      if (
        !isDict(data) ||
        !isOne(data.get('schema_version')) ||
        !isDict(data.get('skills'))
      ) {
        throw new ValueError('unrecognized manifest');
      }
      if ((data.get('skills') as Map<string, unknown>).has(name)) {
        return 'consumer adoption record in .agents/adopted-skills.json';
      }
    } catch {
      return 'unreadable or unrecognized .agents/adopted-skills.json; review provenance';
    }
  }
  const target = pyResolve(entry);
  for (const folder of directories) {
    if (!isDir(folder)) continue;
    for (const linkName of tryFs(() => readdirSync(folder))
      .sort(compareCodePoints)) {
      const link = join(folder, linkName);
      if (isSymlink(link) && isRelativeTo(pyResolve(link), target)) {
        return (
          `incoming harness link ${relative(project, link)};` +
          ' review the linked copy together'
        );
      }
    }
  }
  return null;
}

export function retired_skill_entries(
  source: string,
  project: string,
  directories: string[],
): [removable: string[], preserved: [entry: string, reason: string][]] {
  /** Classify entries under retired toolkit skill names for a refresh.
   *
   * Returns (removable, preserved). Removable entries are proven
   * toolkit-owned: a broken link resolving to the retired path inside the
   * pinned library, or a real directory matching the recorded retired
   * content exactly. Preserved entries are (path, reason) pairs for
   * same-name content whose ownership is ambiguous or unrelated; they are
   * reported with a diagnostic and never removed by name alone. */
  const resolvedSource = pyResolve(source);
  const resolvedProject = pyResolve(project);
  if (resolvedSource === resolvedProject) {
    // The library's own checkout is content, not consumer state.
    return [[], []];
  }
  const allDirectories = retirement_folders(resolvedProject, directories);
  const contained = (directory: string): boolean => {
    const resolved = pyResolve(directory);
    return (
      isRelativeTo(resolved, resolvedProject) &&
      ![resolvedSource, join(resolvedProject, '.git')].some((root) =>
        isRelativeTo(resolved, root)
      )
    );
  };

  const safeDirectories = allDirectories.filter(contained);
  const removable = _retired_links(
    resolvedSource,
    safeDirectories,
    Object.keys(RETIRED_TOOLKIT_SKILLS),
  );
  const seen = new Set(
    removable.map((entry) => join(pyResolve(dirname(entry)), basename(entry))),
  );
  const preserved: [entry: string, reason: string][] = [];
  for (const directory of allDirectories) {
    for (const name of Object.keys(RETIRED_TOOLKIT_SKILLS)) {
      const entry = join(directory, name);
      const identity = join(pyResolve(directory), name);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (!contained(directory)) {
        if (isSymlink(entry) || existsSync(entry)) {
          preserved.push([
            entry,
            'folder outside the consumer project or inside library/Git storage; review in its owning project',
          ]);
        }
        continue;
      }
      if (_retired_copy(entry, name)) {
        const protection = retired_copy_protection(
          resolvedProject,
          entry,
          name,
          allDirectories,
        );
        if (protection) {
          preserved.push([entry, protection]);
        } else {
          removable.push(entry);
        }
      } else if (isSymlink(entry) || existsSync(entry)) {
        preserved.push([
          entry,
          _same_name_reason(resolvedSource, entry, name),
        ]);
      }
    }
  }
  return [removable, preserved];
}

export function toolkit(
  source: string,
  memory = false,
): [installed: string[], referenceOnly: string[]] {
  /** Derive (installed, reference_only) names from library frontmatter.
   *
   * This is the versioned toolkit contract: the expected skill set comes
   * from the pinned library's distribution metadata, never from a consumer
   * selection. Memory skills join the installed set only when the optional
   * Basic Memory capability is enabled. */
  const root = join(source, '.agents/skills');
  const installed: string[] = [];
  const referenceOnly: string[] = [];
  const thirdParty = third_party_skills(source);
  const names = tryFs(() => readdirSync(root))
    .filter((name) => isFile(join(root, name, 'SKILL.md')))
    .sort(compareCodePoints);
  for (const name of names) {
    if (MEMORY_SKILLS.includes(name) && !memory) continue;
    if (thirdParty.has(name)) continue;
    if (is_reference_only(join(root, name, 'SKILL.md'))) {
      referenceOnly.push(name);
    } else {
      installed.push(name);
    }
  }
  return [installed, referenceOnly];
}

export function read_capabilities(project: string): string | null {
  /** Return the recorded memory choice ("enabled"/"declined") or None. */
  const path = join(project, CAPABILITIES_FILE);
  if (!isFile(path)) return null;
  // `except json.JSONDecodeError` only: a `read_text()` failure
  // (UnicodeDecodeError, OSError) propagates out of the function.
  const text = readText(path);
  let data: unknown;
  try {
    data = pyJsonLoads(text);
  } catch (error) {
    throw new ValueError(
      `Unreadable ${CAPABILITIES_FILE}; preserve and review: ` +
        decodeReason(text, error),
    );
  }
  if (
    !isDict(data) ||
    data.size !== 2 ||
    !data.has('schema_version') ||
    !data.has('memory') ||
    !isOne(data.get('schema_version')) ||
    !['enabled', 'declined'].includes(data.get('memory') as string)
  ) {
    throw new ValueError(
      `Unrecognized ${CAPABILITIES_FILE}; preserve and review`,
    );
  }
  return data.get('memory') as string;
}

export function write_capabilities(project: string, choice: string): void {
  /** Record a capability choice. This is not a skill-selection manifest. */
  const path = join(project, CAPABILITIES_FILE);
  // `json.dumps({"schema_version": 1, "memory": choice}, indent=2) + "\n"`
  // keeps dict insertion order (sort_keys=False), unlike pyJson's sorted
  // output: schema_version first, `,`/`: ` separators, ensure_ascii
  // escaping (ASCII-only values here) and the trailing newline.
  tryFs(() =>
    writeFileSync(
      path,
      `{\n  "schema_version": 1,\n  "memory": ${JSON.stringify(choice)}\n}\n`,
      'utf8',
    ),
  );
}

export function resolve_memory_choice(
  project: string,
  requested: string | null = null,
  check = false,
  source: string | null = null,
  options: string[] = [],
): string | null {
  /** Reconcile an explicit --memory request with the recorded choice.
   *
   * Read-only: it never writes the capabilities file, so a failed
   * preflight leaves no recorded side effect. Callers record the choice
   * only after preflight succeeds. */
  let recorded = read_capabilities(project);
  if (requested !== null) {
    if (recorded !== null && recorded !== requested) {
      throw new ValueError(
        `Recorded capability choice ${pyRepr(recorded)} conflicts with` +
          ` --memory ${requested}; edit ${CAPABILITIES_FILE} deliberately`,
      );
    }
    if (check && recorded !== requested) {
      let command: string;
      if (source !== null) {
        command = repair_command(source, project, 'install.py', [
          ...options,
          `--memory ${requested}`,
        ]);
      } else if (options.length) {
        command =
          'node .agent-workflows/bin/agent-workflows.ts install' +
          ` --project . ${options.join(' ')} --memory ${requested}`;
      } else {
        command =
          'node .agent-workflows/bin/agent-workflows.ts install' +
          ` --project . --memory ${requested}`;
      }
      throw new ValueError(
        `Capability choice ${pyRepr(requested)} not recorded in` +
          ` ${CAPABILITIES_FILE}; repair from the consumer root:` +
          ` \`${command}\``,
      );
    }
    recorded = requested;
  } else if (recorded === null) {
    let record: string;
    if (source !== null) {
      record = repair_command(source, project, 'install.py', options);
    } else if (options.length) {
      record =
        'node .agent-workflows/bin/agent-workflows.ts install' +
        ` --project . ${options.join(' ')}`;
    } else {
      record =
        'node .agent-workflows/bin/agent-workflows.ts install --project .';
    }
    console.log(
      'Basic Memory choice not recorded; the issue-only toolkit applies.' +
        ` Record it with \`${record} --memory enabled\` (then` +
        ' node .agent-workflows/bin/agent-workflows.ts setup_memory) or' +
        ` \`${record} --memory declined\`; the choice is written to` +
        ` ${CAPABILITIES_FILE}.`,
    );
  }
  return recorded;
}

export function reference_block(
  source: string,
  project: string,
  names: string[],
): string {
  /** Build the managed pointer block for reference-only skills. */
  const reference = pyRelpath(source, project);
  const prefix = reference === '.' ? '' : `${reference}/`;
  const lines = [
    REF_START,
    '## Shared, not installed',
    '',
    'Some one-shot setup skills stay in the library instead of being installed',
    'into `.agents/skills`. Discovery depends on this pointer existing. Read',
    'their instructions at the pinned revision; the library\'s',
    '`docs/skill-distribution.md` defines the distribution policy.',
    '',
  ];
  for (const name of names) {
    lines.push(`- ${name}: \`${prefix}.agents/skills/${name}/SKILL.md\``);
  }
  lines.push(REF_END);
  return lines.join('\n');
}

const CONTAINER_FENCE = new RegExp(
  `^[${PY_WS_CLASS}]*(?:>|[-+*][${PY_WS_CLASS}]|[\\p{Nd}]+[.)][${PY_WS_CLASS}])`,
  'u',
);
const FENCE_RUN = /(`{3,}|~{3,})/;
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})([\s\S]*)$/;
const INDENTED_CODE = new RegExp(
  `^(?: {4}| {0,3}\\t)[^${PY_WS_CLASS}]|^(?: {4}| {0,3}\\t)[${PY_WS_CLASS}]*[^${PY_WS_CLASS}]`,
  'u',
);
const PARAGRAPH_CONTAINER = new RegExp(
  `^[${PY_WS_CLASS}]*(?:>|[-+*][${PY_WS_CLASS}]|[\\p{Nd}]+[.)][${PY_WS_CLASS}]|#|-{3,}$)`,
  'u',
);
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})\r?$/;
const IMPORT_TOKEN = new RegExp(
  `(?<![\\p{L}\\p{N}_@\\\\])@((?:\\\\ |[^${PY_WS_CLASS}` + '`' + `"'])+)`,
  'gu',
);

/** `re.search` for a `(?m)^...` pattern — Python `^` honours only `\n`. */
function multilineSearch(paragraph: string, pattern: RegExp): boolean {
  return paragraph.split('\n').some((line) => pattern.test(line));
}

export function claude_imports(content: string): string[] {
  /** Find imports outside code; preserve ambiguous Markdown for owner
   * review.
   *
   * This is deliberately a bounded scanner, not a full Markdown renderer.
   * Container syntax is rejected rather than guessing which instructions
   * load. */
  const visible: string[] = [];
  let fence: string | null = null;
  for (const line of pySplitlines(content, true)) {
    // Containers require block-level parsing (including lazy
    // continuation). Refuse before any writes rather than treating nested
    // examples as imports.
    if (CONTAINER_FENCE.test(line) && FENCE_RUN.test(line)) {
      throw new ValueError(
        'Container-nested Markdown fence in CLAUDE.md; preserve and review',
      );
    }
    const marker = FENCE_MARKER.exec(pyRstripNewline(line));
    if (fence !== null) {
      if (
        marker !== null &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        pyStrip(marker[2]) === ''
      ) {
        fence = null;
      }
      continue;
    }
    if (marker !== null) {
      visible.push('\n\n');
      fence = marker[1];
      continue;
    }
    if (INDENTED_CODE.test(line)) {
      throw new ValueError(
        'Indented Markdown fence or code in CLAUDE.md; preserve and review',
      );
    }
    visible.push(line);
  }
  if (fence !== null) {
    throw new ValueError(
      'Unclosed Markdown fence in CLAUDE.md; preserve and review',
    );
  }
  const imports: string[] = [];
  for (const paragraph of visible.join('').split(/\n[ \t\r]*\n/)) {
    // Inline code cannot cross block boundaries. Preserve uncertain
    // blocks.
    if (
      paragraph.includes('`') &&
      (multilineSearch(paragraph, PARAGRAPH_CONTAINER) ||
        multilineSearch(paragraph, THEMATIC_BREAK))
    ) {
      throw new ValueError(
        'Ambiguous Markdown code span in CLAUDE.md; preserve and review',
      );
    }
    const runs = [...paragraph.matchAll(/`+/g)];
    let masked = paragraph;
    let index = 0;
    while (index < runs.length) {
      const opener = runs[index];
      const prefix = paragraph.slice(0, opener.index);
      if ((prefix.length - pyRstripBackslashes(prefix).length) % 2) {
        if (opener[0].length > 1) {
          throw new ValueError(
            'Ambiguous escaped backticks in CLAUDE.md; preserve and review',
          );
        }
        index += 1;
        continue;
      }
      let closer = -1;
      for (let j = index + 1; j < runs.length; j += 1) {
        if (runs[j][0].length === opener[0].length) {
          closer = j;
          break;
        }
      }
      if (closer === -1) {
        index += 1;
        continue;
      }
      const end = runs[closer].index + runs[closer][0].length;
      masked =
        masked.slice(0, opener.index) +
        ' '.repeat(end - opener.index) +
        masked.slice(end);
      index = closer + 1;
    }
    for (const match of masked.matchAll(IMPORT_TOKEN)) {
      imports.push(match[1]);
    }
  }
  return imports;
}

/** `len(prefix) - len(prefix.rstrip("\\"))`, expressed as the stripped copy. */
function pyRstripBackslashes(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\\') end -= 1;
  return text.slice(0, end);
}

export type ClaudeImport = [path: string, existing: string, updated: string];

export function prepare_claude_import(project: string): ClaudeImport | null {
  /** Plan an AGENTS.md import for an existing root CLAUDE.md, if needed.
   *
   * CLAUDE.md remains consumer-owned: never create it, follow a symlink,
   * or rewrite a file whose import path is ambiguous. The import is
   * interpreted relative to CLAUDE.md, so the root instruction file uses
   * ``@AGENTS.md``. */
  for (const alternate of [
    '.claude/CLAUDE.md',
    'CLAUDE.local.md',
    '.claude/CLAUDE.local.md',
  ]) {
    const other = join(project, alternate);
    if (existsSync(other) || isSymlink(other)) {
      throw new ValueError(
        `Alternate Claude instructions require review; preserve: ${other}`,
      );
    }
  }
  const path = join(project, CLAUDE_INSTRUCTIONS);
  if (!existsSync(path) && !isSymlink(path)) return null;
  if (!isFile(path)) {
    throw new ValueError(
      `Ambiguous Claude instruction setup; preserve and review: ${path}`,
    );
  }
  // `path.read_bytes().decode("utf-8")` — strict UTF-8 without the
  // universal-newline translation readText applies (CRLF is detected
  // below), with the BOM left as U+FEFF like the plain codec.
  let content: string;
  try {
    content = pyDecodeUtf8(readFileSync(path));
  } catch (error) {
    if (error instanceof UnicodeDecodeError) {
      throw error;
    }
    throw pyOsError(error);
  }
  const imports = claude_imports(content);
  const resolved: string[] = [];
  for (const imported of imports) {
    // `path.parent / imported` — an absolute import replaces the parent
    // directory entirely instead of joining under it.
    const cleaned = imported.replace(/\\ /g, ' ');
    const candidate = pyResolve(
      isAbsolute(cleaned) ? cleaned : join(dirname(path), cleaned),
    );
    if (candidate === pyResolve(join(project, 'AGENTS.md'))) {
      resolved.push(imported);
    }
  }
  if (resolved.length) {
    if (resolved.length > 1) {
      throw new ValueError(
        `Duplicate AGENTS.md imports in ${path}; preserve and review`,
      );
    }
    return [path, content, content];
  }
  if (isSymlink(path)) {
    throw new ValueError(
      `Linked Claude instructions need an AGENTS.md import; preserve and` +
        ` review: ${path}`,
    );
  }
  let updated = content;
  if (updated !== '' && !updated.endsWith('\n')) updated += '\n';
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  updated += `@AGENTS.md${newline}`;
  return [path, content, updated];
}

export function report_unmanaged_links(
  destination: string,
  skill_root: string,
  managed: Set<string>,
  memory_enabled: boolean,
  retired: string[] = [],
): void {
  /** Refuse library-owned consumer links the pinned toolkit does not
   * manage.
   *
   * Only links pointing into the library source are inspected: they were
   * created by an installer, so ownership is established. Consumer-authored
   * files and links to other locations are unrelated work and stay
   * untouched. Nothing is removed automatically; the error asks for a
   * reviewed decision. */
  if (!isDir(destination)) return;
  // Compare by real folder: .claude/skills may be the same folder as
  // .agents/skills under another path.
  const retiring = new Set(
    retired.map((entry) => join(pyResolve(dirname(entry)), basename(entry))),
  );
  for (const name of tryFs(() => readdirSync(destination))
    .sort(compareCodePoints)) {
    const entry = join(destination, name);
    if (
      managed.has(name) ||
      !isSymlink(entry) ||
      retiring.has(join(pyResolve(destination), name))
    ) {
      continue;
    }
    const target = pyResolve(entry);
    if (target !== join(skill_root, name) && !inParents(target, skill_root)) {
      continue;
    }
    if (MEMORY_SKILLS.includes(name) && !memory_enabled) {
      throw new ValueError(
        `Unexpected memory skill link: ${entry} (resolves to` +
          ` ${pyResolve(entry)}); no \`enabled\` Basic Memory` +
          ` choice is recorded in ${CAPABILITIES_FILE}. To enable it,` +
          ' record the reviewed choice with `--memory enabled` and run' +
          ' node .agent-workflows/bin/agent-workflows.ts setup_memory;' +
          ' otherwise remove the link only after a' +
          ' reviewed decision (see docs/memory/migration.md)',
      );
    }
    throw new ValueError(
      `Stale library skill link: ${entry} (resolves to` +
        ` ${pyResolve(entry)}); the pinned toolkit does not` +
        ' include it; remove it only after a reviewed decision',
    );
  }
}

export interface ConsumerPin {
  path: string;
  pin: string;
  head: string;
  branch: string | null;
}

export function consumer_pin(
  source: string,
  project: string,
  runGitImpl: (root: string, args: string[]) => GitResult = runGit,
): ConsumerPin | null {
  /** Inspect the library checkout the consumer pins as a submodule.
   *
   * ``source`` counts as a pinned submodule when the consumer index
   * records a gitlink at the source path; a nested Git consumer root is
   * rejected; standalone checkouts, copied libraries and self-installation
   * return ``None`` and keep their checkout state. For a registered
   * submodule the intended pin is the index gitlink, so a staged pin
   * adoption is explicit reviewed intent. Unsafe states are reported
   * before any mutation: an uninitialized or unreadable checkout, a
   * conflicted index entry, dirty files, local commits ahead of the
   * recorded pin, or a HEAD that differs from the pin without a staged
   * adoption. */
  const resolvedSource = pyResolve(source);
  const resolvedProject = pyResolve(project);
  if (resolvedSource === resolvedProject || !inParents(resolvedSource, resolvedProject)) {
    return null;
  }
  let top: GitResult;
  try {
    top = runGitImpl(resolvedProject, ['rev-parse', '--show-toplevel']);
  } catch (error) {
    // FileNotFoundError — no git executable at all.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (top.status) return null;
  if (pyResolve(pyStrip(top.stdout)) !== resolvedProject) {
    throw new ValueError(
      'Consumer --project must be the Git worktree root;' +
        ' rerun from the owning repository root',
    );
  }
  const rel = relative(resolvedProject, resolvedSource);
  const listing = runGitImpl(resolvedProject, [
    'ls-files', '-s', '-z', '--', rel,
  ]);
  if (listing.status) {
    throw new ValueError(
      `Could not read the consumer's index for ${rel};` +
        ' preserve and review',
    );
  }
  const matches: string[][] = [];
  for (const record of listing.stdout.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const info = tab < 0 ? record : record.slice(0, tab);
    const path = tab < 0 ? '' : record.slice(tab + 1);
    if (path === rel) matches.push(pySplit(info));
  }
  if (!matches.length) return null;
  if (
    matches.length !== 1 ||
    matches[0].length !== 3 ||
    matches[0][0] !== '160000' ||
    matches[0][2] !== '0'
  ) {
    throw new ValueError(
      `Unresolved library pin for ${rel}; the consumer's index` +
        ' entry is missing, duplicated or conflicted; review the' +
        ' declared submodule pin',
    );
  }
  const pin = matches[0][1];

  const run = (...args: string[]) => runGitImpl(resolvedSource, args);

  if (!existsSync(join(resolvedSource, '.git'))) {
    throw new ValueError(
      `Pinned library ${rel} is registered but uninitialized;` +
        ` initialize it with \`git submodule update --init -- ${rel}\``,
    );
  }
  const probe = run('rev-parse', '--show-toplevel');
  if (probe.status || pyResolve(pyStrip(probe.stdout)) !== resolvedSource) {
    throw new ValueError(
      `Pinned library ${rel} is not a readable Git checkout;` +
        ' preserve and review',
    );
  }
  const status = run('status', '--porcelain', '--untracked-files=all');
  if (status.status) {
    throw new ValueError(
      `Could not inspect pinned library ${rel} status;` +
        ' preserve and repair the Git checkout',
    );
  }
  if (pyStrip(status.stdout)) {
    throw new ValueError(
      `Pinned library ${rel} is dirty; preserve and review local` +
        ' changes before installation',
    );
  }
  const headResult = run('rev-parse', '--verify', 'HEAD');
  if (headResult.status) {
    throw new ValueError(
      `Could not inspect pinned library ${rel} HEAD;` +
        ' preserve and repair the Git checkout',
    );
  }
  const head = pyStrip(headResult.stdout);
  if (head !== pin) {
    if (run('merge-base', '--is-ancestor', pin, head).status === 0) {
      throw new ValueError(
        `Pinned library ${rel} is ahead of the recorded pin` +
          ` ${pin}; stage a reviewed pin adoption` +
          ` (\`git add ${rel}\`) or preserve the local commits` +
          ' (for example push them or record them on a branch) and' +
          ' restore the recorded pin before installation',
      );
    }
    throw new ValueError(
      `Pinned library ${rel} is at ${head}, which differs from the` +
        ` consumer's recorded pin ${pin}; stage the reviewed pin` +
        ` (\`git add ${rel}\`) or restore the recorded pin` +
        ` (\`git submodule update -- ${rel}\`)`,
    );
  }
  const ref = run('symbolic-ref', '-q', 'HEAD');
  if (ref.status !== 0 && ref.status !== 1) {
    throw new ValueError(
      `Could not inspect pinned library ${rel} branch;` +
        ' preserve and repair the Git checkout',
    );
  }
  const refOut = pyStrip(ref.stdout);
  const branch = ref.status === 0
    ? (refOut.startsWith('refs/heads/') ? refOut.slice(11) : refOut)
    : null;
  return { path: rel, pin, head, branch };
}

export function link_status(destination: string, target: string): string {
  /** Classify a managed link destination against its expected target.
   *
   * Shared with scripts/adopt_skills.py: "linked" already resolves to
   * target, "conflict" is a symlink resolving elsewhere, "occupied" is a
   * real file or directory, and "missing" is free. This is the same
   * classification the ``--claude-skills`` link mirroring relies on. */
  if (isSymlink(destination)) {
    return pyResolve(destination) === target ? 'linked' : 'conflict';
  }
  if (existsSync(destination)) return 'occupied';
  return 'missing';
}

export function make_relative_link(destination: string, target: string): void {
  /** Create destination as a relative symlink to target.
   *
   * Shared with scripts/adopt_skills.py so adopted third-party skills get
   * the same relative links the ``--claude-skills`` mirror uses. */
  tryFs(() => mkdirSync(dirname(destination), { recursive: true }));
  tryFs(() =>
    symlinkSync(pyRelpath(target, dirname(destination)), destination),
  );
}

export type Plan = [destination: string, target: string, allowLocal: boolean];

export interface PrepareOptions {
  codex_agents?: boolean;
  check?: boolean;
  memory_enabled?: boolean | null;
  claude_skills?: boolean;
  memory_options?: string[];
  install_options?: string[];
  runGitImpl?: (root: string, args: string[]) => GitResult;
}

export function prepare_install(
  source: string,
  project: string,
  skills: string[] | null = null,
  options: PrepareOptions = {},
): [plans: Plan[], agents: string, existing: string, updated: string,
    claudeImport: ClaudeImport | null] {
  /** Preflight all links and persistent instructions without writing
   * files.
   *
   * ``skills=None`` selects the derived versioned toolkit excluding memory
   * skills; setup_memory.py passes the library-defined memory set
   * explicitly. No caller accepts a consumer skill selection anymore.
   * ``memory_enabled`` reports the reconciled Basic Memory capability
   * choice; it defaults to True for the explicit memory set (the
   * enablement path). ``claude_skills`` mirrors the same non-reference
   * links into ``.claude/skills``; without it that directory is neither
   * written nor checked, except for retired entries: broken links to the
   * vendored memory skills and proven toolkit-owned links/copies of
   * retired toolkit skills. ``memory_options`` carries the
   * setup_memory.py flags to preserve in the suggested memory repair
   * command (the caller knows --share-config). ``install_options`` carries
   * the requested install.py setup flags so suggested repair commands
   * preserve the requested setup scope. A registered submodule source is
   * validated against the consumer's recorded pin first; unsafe states
   * stop before mutation and --check also reports an attached checkout
   * without changing it. */
  const {
    codex_agents = false,
    check = false,
    memory_enabled = null,
    claude_skills = false,
    memory_options = [],
    install_options = [],
    runGitImpl = runGit,
  } = options;
  const resolvedSource = pyResolve(source);
  const resolvedProject = pyResolve(project);
  const install_repair = repair_command(
    resolvedSource,
    resolvedProject,
    'install.py',
    install_options,
  );
  const memory_repair = repair_command(
    resolvedSource,
    resolvedProject,
    'setup_memory.py',
    memory_options.length ? memory_options : (claude_skills ? ['--claude-skills'] : []),
  );
  const pin = consumer_pin(resolvedSource, resolvedProject, runGitImpl);
  if (check && pin !== null && pin.branch !== null) {
    throw new ValueError(
      `Pinned library ${pin.path} is attached to branch` +
        ` ${pyRepr(pin.branch)} at the recorded pin; the pinned toolkit` +
        ' keeps the library checkout detached. Repair from the consumer' +
        ` root: \`${install_repair}\`; it detaches at the same commit` +
        ' without moving or deleting the branch',
    );
  }
  const agents = join(resolvedProject, 'AGENTS.md');
  if (!isFile(agents)) {
    throw new ValueError(`Missing consumer contract: ${agents}`);
  }
  if (isSymlink(agents)) {
    throw new ValueError(
      `Linked consumer instructions; preserve and review: ${agents}`,
    );
  }
  const existing = readText(agents);
  const migrated = remove_legacy_worktree_block(
    existing,
    resolvedSource,
    resolvedProject,
    agents,
  );
  const managed_blocks: ManagedBlock[] = [
    [COLLAB_START, COLLAB_END, 'collaboration policy', COLLAB_BLOCK],
  ];
  let updated = apply_policy_blocks(migrated, managed_blocks, agents);
  const skill_root = join(resolvedSource, '.agents/skills');
  const [installed, reference] = toolkit(resolvedSource);
  const names = skills === null ? [...installed, ...reference] : [...skills];
  const plans: Plan[] = [];
  const reference_only: string[] = [];
  const claudeImport = claude_skills
    ? prepare_claude_import(resolvedProject)
    : null;
  if (check && claudeImport !== null && claudeImport[2] !== claudeImport[1]) {
    throw new ValueError(
      `Missing @AGENTS.md import in ${join(resolvedProject, CLAUDE_INSTRUCTIONS)}:` +
        ' the consumer-owned file is expected to import the root contract' +
        ' when --claude-skills is selected. Repair from the consumer root:' +
        ` \`${install_repair}\``,
    );
  }
  for (const name of names) {
    if (basename(name) !== name || name === '.' || name === '..') {
      throw new ValueError(`Invalid skill name: ${name}`);
    }
    const target = join(skill_root, name);
    if (!isFile(join(target, 'SKILL.md'))) {
      throw new ValueError(`Unknown skill: ${name}`);
    }
    if (is_reference_only(join(target, 'SKILL.md'))) {
      reference_only.push(name);
      continue;
    }
    plans.push([join(resolvedProject, '.agents/skills', name), target, false]);
  }
  const link_dirs = [join(resolvedProject, '.agents/skills')];
  if (claude_skills) {
    const claude_root = join(resolvedProject, CLAUDE_SKILLS);
    for (const directory of [join(resolvedProject, '.claude'), claude_root]) {
      if (
        (existsSync(directory) || isSymlink(directory)) &&
        !isDir(directory)
      ) {
        throw new ValueError(
          `Local skill conflict: ${directory}; preserve and review`,
        );
      }
    }
    link_dirs.push(claude_root);
    plans.push(
      ...names
        .filter((name) => !reference_only.includes(name))
        .map((name): Plan => [
          join(claude_root, name),
          join(skill_root, name),
          false,
        ]),
    );
  }
  // Memory-enabled installations keep their separately managed memory
  // links; the toolkit itself never installs them (setup_memory.py owns
  // that). Another installer's skills in the library's own checkout are
  // not ours to report, including its links that resolve into this skill
  // root.
  const managed = new Set([
    ...names,
    ...installed,
    ...reference,
    ...third_party_skills(resolvedSource),
  ]);
  if (skills !== null || memory_enabled === true) {
    for (const name of MEMORY_SKILLS) managed.add(name);
  }
  const memory_flag = memory_enabled !== null ? memory_enabled : skills !== null;
  // Retired entries are ours: broken links, and for toolkit skills also
  // copies proven by the recorded content. They are reported with a repair
  // in --check and removed by install(); .claude/skills is covered
  // whenever it exists because an older installer may have mirrored them
  // there. Same-name entries that are not proven toolkit-owned stay
  // preserved.
  const retired = retired_memory_links(
    resolvedSource,
    resolvedProject,
    [join(resolvedProject, '.agents/skills'), join(resolvedProject, CLAUDE_SKILLS)],
  );
  const [removable, preserved] = retired_skill_entries(
    resolvedSource,
    resolvedProject,
    [join(resolvedProject, '.agents/skills'), join(resolvedProject, CLAUDE_SKILLS)],
  );
  if (check && (retired.length || removable.length)) {
    const problems: string[] = [];
    let suffix = '';
    if (retired.length) {
      const listed = retired
        .map((entry) => relative(resolvedProject, entry))
        .join(', ');
      problems.push(
        `Retired memory skill link(s): ${listed}. The pinned toolkit no` +
          ' longer ships Basic Memory\'s upstream skills; these links are' +
          ' broken.',
      );
      suffix = memory_flag
        ? ', then install the upstream skills at the release matching the' +
          ' server (see docs/memory/upstream-skills.md)'
        : '';
    }
    if (removable.length) {
      const listed = removable
        .map((entry) => relative(resolvedProject, entry))
        .join(', ');
      problems.push(
        `Retired toolkit skill link(s)/copies: ${listed}. The pinned` +
          ' toolkit retired these skills; the repair removes broken links' +
          ' and copies matching the recorded library content.',
      );
    }
    if (preserved.length) {
      const listed = preserved
        .map(([entry]) => relative(resolvedProject, entry))
        .join(', ');
      problems.push(
        'Preserved same-name entries (not proven toolkit-owned;' +
          ` never removed by name alone): ${listed}.`,
      );
    }
    throw new ValueError(
      `${problems.join(' ')} Repair from the consumer root:` +
        ` \`${install_repair}\`${suffix}`,
    );
  }
  for (const directory of link_dirs) {
    report_unmanaged_links(
      directory,
      skill_root,
      managed,
      memory_flag,
      [...retired, ...removable],
    );
  }
  if (reference_only.length) {
    for (const destination of link_dirs) {
      for (const name of reference_only) {
        const link = join(destination, name);
        if (isSymlink(link) && pyResolve(link) === join(skill_root, name)) {
          throw new ValueError(
            `Reference-only skill installed: ${link}; the pinned` +
              ` toolkit keeps ${name} in the library behind a managed` +
              ` pointer block in ${agents}; remove the link only after` +
              ' a reviewed decision',
          );
        }
      }
    }
    const reference_pointer: ManagedBlock = [
      REF_START,
      REF_END,
      'reference-only pointer',
      reference_block(resolvedSource, resolvedProject,
        [...reference_only].sort(compareCodePoints)),
    ];
    managed_blocks.push(reference_pointer);
    updated = apply_policy_blocks(updated, [reference_pointer], agents);
  }
  if (check && migrated !== existing) {
    throw new ValueError(
      `Stale managed block in ${agents}: the legacy worktree policy` +
        ` (markers \`${START}\`/\`${END}\`) requires migration under the` +
        ' pinned toolkit. Repair from the consumer root:' +
        ` \`${install_repair}\``,
    );
  }
  if (check && updated !== existing) {
    const missing = managed_blocks
      .filter(
        ([start, end, , block]) =>
          block_state(existing, start, end, block) === 'missing',
      )
      .map(([start, end, name]) => `${name} (markers \`${start}\`/\`${end}\`)`)
      .join('; ');
    throw new ValueError(
      `Missing managed block(s) in ${agents}: ${missing}. The pinned` +
        ' toolkit expects these instructions in AGENTS.md. Repair from the' +
        ` consumer root: \`${install_repair}\``,
    );
  }
  if (codex_agents) {
    let tomls: string[];
    try {
      tomls = readdirSync(join(resolvedSource, '.codex/agents'))
        .filter((name) => name.endsWith('.toml'));
    } catch {
      // Path.glob yields nothing for a directory that cannot be listed.
      tomls = [];
    }
    for (const name of tomls.sort(compareCodePoints)) {
      plans.push([
        join(resolvedProject, '.codex/agents', name),
        join(resolvedSource, '.codex/agents', name),
        true,
      ]);
    }
  }

  // Preflight all destinations before creating any links. In self mode
  // the library installs itself: a real destination that resolves to its
  // own library source is already current, not a conflict.
  const self_mode = resolvedSource === resolvedProject;
  for (const [destination, target, allow_local] of plans) {
    const state = link_status(destination, target);
    if (state === 'conflict') {
      throw new ValueError(
        `Conflicting symlink: ${destination} resolves to` +
          ` ${pyResolve(destination)}; the pinned toolkit expects` +
          ` ${target}. Retarget it only after a reviewed decision`,
      );
    } else if (state === 'occupied') {
      if (
        !(allow_local && isFile(destination)) &&
        !(self_mode && pyResolve(destination) === target)
      ) {
        throw new ValueError(
          `Local skill conflict: ${destination}; a consumer file` +
            ' occupies the managed path the pinned toolkit expects to' +
            ` link to ${target}; choose one source explicitly`,
        );
      }
    } else if (state === 'missing' && check) {
      const repair =
        skills !== null && MEMORY_SKILLS.includes(basename(target))
          ? memory_repair
          : install_repair;
      const expected = allow_local
        ? 'an installed link or a preserved local file at'
        : 'a managed link to';
      throw new ValueError(
        `Missing installation: ${destination}; the pinned toolkit` +
          ` expects ${expected} ${target}. Repair from the consumer root:` +
          ` \`${repair}\``,
      );
    }
  }

  return [plans, agents, existing, updated, claudeImport];
}

export interface InstallOptions {
  skills?: string[] | null;
  codex_agents?: boolean;
  check?: boolean;
  memory?: string | null;
  claude_skills?: boolean;
  delivery_profiles?: boolean;
  memory_options?: string[];
  /** Internal seams the Python tests reach through `unittest.mock`; the
   * CLI never passes them. `linkHook` runs inside the link-creation loop
   * where a patched `make_relative_link` would, and `runGitImpl` replaces
   * `runGit` at every call site. */
  linkHook?: (destination: string, target: string) => void;
  runGitImpl?: (root: string, args: string[]) => GitResult;
}

function pinEquals(a: ConsumerPin | null, b: ConsumerPin | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.path === b.path &&
    a.pin === b.pin &&
    a.head === b.head &&
    a.branch === b.branch
  );
}

export function install(
  source: string,
  project: string,
  options: InstallOptions = {},
): void {
  /** Install the derived toolkit and reconcile the capability choice.
   *
   * ``skills`` is internal-only (the library-defined memory capability set
   * passed by setup_memory.py); it is never a consumer selection.
   * ``delivery_profiles`` creates an empty consumer-owned delivery
   * profiles file only when missing; an existing file is preserved
   * byte-for-byte. ``memory_options`` forwards the caller's
   * setup_memory.py flags so repair suggestions for memory links preserve
   * them. */
  const {
    skills = null,
    codex_agents = false,
    check = false,
    memory = null,
    claude_skills = false,
    delivery_profiles = false,
    memory_options = [],
    linkHook,
    runGitImpl = runGit,
  } = options;
  const resolvedProject = pyResolve(project);
  const self_mode = pyResolve(source) === resolvedProject;
  const installOptions = install_command_options(
    codex_agents,
    claude_skills,
    delivery_profiles,
  );
  const requested = resolve_memory_choice(
    resolvedProject,
    memory,
    check,
    source,
    installOptions,
  );
  const expectedPin = consumer_pin(source, resolvedProject, runGitImpl);
  const [plans, agents, existing, updated, claudeImport] = prepare_install(
    source,
    resolvedProject,
    skills,
    {
      codex_agents,
      check,
      memory_enabled: requested === 'enabled',
      claude_skills,
      memory_options,
      install_options: installOptions,
      runGitImpl,
    },
  );
  const pin = consumer_pin(source, resolvedProject, runGitImpl);
  if (!pinEquals(pin, expectedPin)) {
    throw new ValueError(
      'Library pin or checkout changed during preflight; retry after review',
    );
  }
  if (pin !== null && pin.branch !== null && !check) {
    const detach = runGitImpl(pyResolve(source), [
      'checkout', '-q', '--detach', pin.pin,
    ]);
    if (detach.status) {
      throw new ValueError(
        `Could not detach pinned library ${pin.path}:` +
          ` ${pyStrip(detach.stderr)}`,
      );
    }
    console.log(
      `detached: ${pin.path} at ${pin.head}` +
        ` (branch ${pin.branch} preserved)`,
    );
  }
  const profiles = join(resolvedProject, DELIVERY_PROFILES);
  const profiles_missing = delivery_profiles &&
    !(existsSync(profiles) || isSymlink(profiles));
  if (check && profiles_missing) {
    throw new ValueError(
      `Missing installation: ${profiles}; the --delivery-profiles option` +
        ' was requested and creates it containing `{}`. Repair from the' +
        ` consumer root: \`${repair_command(source, resolvedProject, 'install.py', installOptions)}\``,
    );
  }
  if (memory !== null && read_capabilities(resolvedProject) === null && !check) {
    write_capabilities(resolvedProject, memory);
    console.log(`recorded: memory ${memory} in ${CAPABILITIES_FILE}`);
  }
  for (const entry of retired_memory_links(
    source,
    resolvedProject,
    [join(resolvedProject, '.agents/skills'), join(resolvedProject, CLAUDE_SKILLS)],
  )) {
    tryFs(() => unlinkSync(entry));
    console.log(
      `retired: ${relative(resolvedProject, entry)} (broken link to a` +
        ' skill the library no longer ships; see' +
        ' docs/memory/upstream-skills.md)',
    );
  }
  const [removable, preserved] = retired_skill_entries(
    source,
    resolvedProject,
    [join(resolvedProject, '.agents/skills'), join(resolvedProject, CLAUDE_SKILLS)],
  );
  for (const entry of removable) {
    let kind: string;
    if (isSymlink(entry)) {
      tryFs(() => unlinkSync(entry));
      kind = 'broken link to';
    } else {
      tryFs(() => rmSync(entry, { recursive: true }));
      kind = 'exact copy of';
    }
    console.log(
      `retired: ${relative(resolvedProject, entry)} (${kind} a toolkit` +
        ' skill the library no longer ships; see docs/integrations.md)',
    );
  }
  for (const [entry, reason] of preserved) {
    console.log(
      `preserved: ${relative(resolvedProject, entry)} (${reason}; not` +
        ' proven toolkit-owned, remove it only after a reviewed decision)',
    );
  }
  for (const [destination, target, allow_local] of plans) {
    let mode: string;
    if (existsSync(destination) || isSymlink(destination)) {
      if (
        self_mode &&
        !isSymlink(destination) &&
        pyResolve(destination) === target
      ) {
        mode = 'self';
      } else {
        mode = allow_local && !isSymlink(destination)
          ? 'local override'
          : 'linked';
      }
    } else {
      make_relative_link(destination, target);
      linkHook?.(destination, target);
      mode = 'installed';
    }
    console.log(`${mode}: ${relative(resolvedProject, destination)}`);
  }
  if (updated !== existing) {
    tryFs(() => writeFileSync(agents, updated, 'utf8'));
  }
  if (claudeImport !== null) {
    const [claude_path, claude_existing, claude_updated] = claudeImport;
    if (claude_updated !== claude_existing) {
      tryFs(() => writeFileSync(claude_path, claude_updated, 'utf8'));
      console.log('updated: CLAUDE.md imports AGENTS.md');
    }
  }
  console.log(
    `${updated !== existing ? 'updated' : 'checked'}: AGENTS.md collaboration policy`,
  );
  if (delivery_profiles) {
    if (profiles_missing) {
      tryFs(() =>
        mkdirSync(dirname(profiles), { recursive: true }),
      );
      tryFs(() => writeFileSync(profiles, '{}\n', 'utf8'));
      console.log(`created: ${relative(resolvedProject, profiles)}`);
    } else {
      console.log('existing delivery profiles preserved');
    }
  }
  const mcpNotice = antigravitySetupNotice(resolvedProject);
  if (mcpNotice !== null) console.log(mcpNotice);
  if (pin !== null) {
    const state = consumer_pin(source, resolvedProject, runGitImpl);
    if (
      state === null ||
      state.branch !== null ||
      state.head !== pin.pin ||
      state.pin !== pin.pin
    ) {
      throw new ValueError(
        `Pinned library ${pin.path} did not verify detached at the` +
          ' recorded pin; preserve and review',
      );
    }
    console.log(`verified: ${pin.path} detached at ${state.head}`);
  }
}

// ---------------------------------------------------------------------------
// argparse-compatible command line.
// ---------------------------------------------------------------------------

const PROG = 'agent-workflows.ts install';
const USAGE =
  `usage: ${PROG} [-h] --project PROJECT [--memory {enabled,declined}]\n` +
  '                  [--codex-agents] [--claude-skills] [--delivery-profiles]\n' +
  '                  [--check]';

const HELP_TEXT =
  `${USAGE}\n` +
  '\n' +
  'Install the versioned toolkit and optional Codex profiles. Every consumer\n' +
  'receives the standard toolkit derived from the pinned library version:\n' +
  'installed links and reference-only pointers follow each skill\'s `distribution`\n' +
  'frontmatter. Basic Memory is one optional capability; its setup skill is\n' +
  'installed only through agent-workflows.ts setup_memory after an explicit\n' +
  'recorded choice.\n' +
  'Basic Memory\'s own skills are not shipped here: consumers install them from\n' +
  'upstream at the release matching their server (docs/memory/upstream-\n' +
  'skills.md). Claude Code discovers project skills only from `.claude/skills`,\n' +
  'so the same installed links are mirrored there only with the opt-in `--claude-\n' +
  'skills` flag (see docs/claude.md). The opt-in `--delivery-profiles` flag\n' +
  'creates an empty consumer-owned `.agents/delivery-profiles.json` only when\n' +
  'missing; an existing file is preserved byte-for-byte and never populated,\n' +
  'replaced or repaired. Refreshing a consumer also retires proven toolkit-owned\n' +
  'links and exact copies of skills the pinned toolkit no longer ships; same-name\n' +
  'content that is not proven toolkit-owned is preserved and reported, never\n' +
  'removed by name alone (see docs/integrations.md). When the source is a\n' +
  'registered submodule of the project, the helper also keeps it detached at the\n' +
  'consumer\'s recorded pin (see consumer_pin).\n' +
  '\n' +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --project PROJECT\n' +
  '  --memory {enabled,declined}\n' +
  '                        Record the Basic Memory capability choice\n' +
  '  --codex-agents\n' +
  '  --claude-skills       Also link the toolkit skills into .claude/skills for\n' +
  '                        Claude Code\n' +
  '  --delivery-profiles   Create an empty .agents/delivery-profiles.json when\n' +
  '                        missing\n' +
  '  --check               Check installations without changes\n';

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
  dest: 'help' | 'project' | 'memory' | 'codex_agents' | 'claude_skills' |
    'delivery_profiles' | 'check';
  takesValue: boolean;
  choices?: string[];
}

const OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--project'], dest: 'project', takesValue: true },
  {
    names: ['--memory'],
    dest: 'memory',
    takesValue: true,
    choices: ['enabled', 'declined'],
  },
  { names: ['--codex-agents'], dest: 'codex_agents', takesValue: false },
  { names: ['--claude-skills'], dest: 'claude_skills', takesValue: false },
  {
    names: ['--delivery-profiles'],
    dest: 'delivery_profiles',
    takesValue: false,
  },
  { names: ['--check'], dest: 'check', takesValue: false },
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
      pastSeparator = true;
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
      if (option.choices && !option.choices.includes(value)) {
        parserError(
          `argument ${optionLabel(option)}: invalid choice: ${pyRepr(value)}` +
            ` (choose from ${option.choices.join(', ')})`,
        );
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
  if (values.project === undefined) {
    parserError('the following arguments are required: --project');
  }
  return { values, extras };
}

function libraryRoot(): string {
  return dirname(dirname(pyResolve(fileURLToPath(import.meta.url))));
}

function isReportable(error: unknown): boolean {
  // `except (ValueError, OSError)` — UnicodeDecodeError is a ValueError
  // subclass, and the OS-error names come out of pyio/tryFs wrappers.
  const named = error as Error;
  return (
    error instanceof ValueError ||
    named.name === 'UnicodeDecodeError' ||
    [
      'OSError',
      'FileNotFoundError',
      'NotADirectoryError',
      'IsADirectoryError',
      'FileExistsError',
      'PermissionError',
    ].includes(named.name)
  );
}

function runMain(argv: string[]): number {
  const { values, extras } = parseArgs(argv);
  if (extras.some((item) => item.includes('--skills'))) {
    console.error(SKILLS_MIGRATION);
    return 1;
  }
  if (extras.length) {
    parserError(`unrecognized arguments: ${extras.join(' ')}`);
  }
  try {
    install(libraryRoot(), values.project as string, {
      codex_agents: values.codex_agents === true,
      check: values.check === true,
      memory: (values.memory as string | undefined) ?? null,
      claude_skills: values.claude_skills === true,
      delivery_profiles: values.delivery_profiles === true,
    });
  } catch (error) {
    if (isReportable(error)) {
      console.error((error as Error).message);
      return 1;
    }
    throw error;
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
