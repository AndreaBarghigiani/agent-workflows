/**
 * Report a consumer's memory state before a library or server update.
 *
 * Local and read-only: it reads files in the consumer checkout and never
 * calls Basic Memory. The server release cannot be discovered here, so
 * the caller supplies it with --server-release; without it the verdict
 * is `unknown`. The printed record is what a rollback needs: keep it
 * with the update handoff.
 */
import { existsSync, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CAPABILITIES_FILE,
  CLAUDE_SKILLS,
  pyResolve,
  read_capabilities,
  RETIRED_MEMORY_SKILLS,
  SKILLS_LOCK,
} from './install.ts';
import { jsonDumps } from './memory_connections.ts';
import { expected_instructions } from './setup_memory.ts';
import { runGit } from './lib/git.ts';
import { readText } from './lib/pyio.ts';
import { AttributeError, ValueError } from './lib/pyerrors.ts';
import {
  PyFloat,
  jsonLoadsError,
  jsonLoadsErrorMessage,
  pyJsonLoads,
} from './lib/pyloads.ts';
import { pyRepr, pyTypeName } from './lib/pyrepr.ts';

export const UPSTREAM = 'basicmachines-co/basic-memory';
// The reviewed pairs from docs/memory/compatibility.md, and nothing else.
// `legacy` is the pre-1.0 tool surface; `1.0` is the bm_* surface. A release or
// ref missing from these tables has not been reviewed and is reported as
// unknown, never guessed. Extend them only together with that document.
export const SERVER_SURFACES: Record<string, string> = {
  '0.23.2': 'legacy',
  '0.24.0': 'legacy',
  '0.24.1': 'legacy',
  '1.0.0': '1.0',
};
export const SKILL_SURFACES: Record<string, string> = {
  d1f5c5265254de258fd928228291c261fb4c99b6: 'legacy',
  'v1.0.0': '1.0',
};
export const EXIT: Record<string, number> = {
  compatible: 0,
  'not applicable': 0,
  incompatible: 3,
  unknown: 4,
};

// --- Python value semantics -----------------------------------------------------

type Dict = Record<string, unknown> | Map<string, unknown>;

function isDict(value: unknown): value is Dict {
  return (
    value instanceof Map ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      !(value instanceof PyFloat))
  );
}

/** `key in mapping` over either dict shape. */
function dictHas(mapping: Dict, key: string): boolean {
  return mapping instanceof Map
    ? mapping.has(key)
    : Object.hasOwn(mapping, key);
}

/** `mapping.get(key, default)` — the default only when absent. */
function dictGetOr(mapping: Dict, key: string, fallback: unknown): unknown {
  return dictHas(mapping, key)
    ? mapping instanceof Map
      ? mapping.get(key)
      : mapping[key]
    : fallback;
}

/** `dict.get(key)` on a mapping that may not be one — AttributeError. */
function dictGetOrAttributeError(
  mapping: unknown,
  key: string,
  fallback: unknown,
): unknown {
  if (!isDict(mapping)) {
    throw new AttributeError(
      `'${pyTypeName(mapping)}' object has no attribute 'get'`,
    );
  }
  return dictGetOr(mapping, key, fallback);
}

/**
 * `sorted()` ordering for strings: Python orders `str` by Unicode code
 * point while JS sorts UTF-16 code units; surrogate pairs differ.
 */
function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done || r.done) return Number(l.done) - Number(r.done);
    if (l.value !== r.value) {
      return (l.value.codePointAt(0) ?? 0) - (r.value.codePointAt(0) ?? 0);
    }
  }
}

/** `json.loads` raising `ValueError` carrying the CPython error text. */
function jsonLoads(text: string): unknown {
  const error = jsonLoadsError(text);
  if (error !== null) {
    throw new ValueError(jsonLoadsErrorMessage(text, error));
  }
  return pyJsonLoads(text);
}

/** `str.strip()` over Python's whitespace set. */
const PY_WS =
  '\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004' +
  '\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';

function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WS.includes(text[start])) start += 1;
  while (end > start && PY_WS.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `Path.is_symlink()` — lstat, false on a missing path. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `Path.is_file()` — follows links, false on error. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `Path.is_dir()` — follows links, false on error. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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

// --- Module logic ---------------------------------------------------------------

/** Map an exact reviewed server release (optionally `v`-prefixed). */
export function server_surface_of(release: unknown): string | null {
  if (typeof release !== 'string') return null;
  const key = release.startsWith('v') ? release.slice(1) : release;
  return Object.hasOwn(SERVER_SURFACES, key) ? SERVER_SURFACES[key] : null;
}

/** Describe where one memory skill comes from, from local files only. */
export function skill_state(
  root: string,
  name: string,
  lock: Dict,
): Record<string, unknown> {
  const entry = join(root, '.agents/skills', name);
  if (isSymlink(entry)) {
    if (!existsSync(entry)) {
      return {
        source:
          'broken link; run node' +
          ' .agent-workflows/bin/agent-workflows.ts install',
        surface: null,
      };
    }
    return { source: 'link, not an upstream install', surface: null };
  }
  if (!isFile(join(entry, 'SKILL.md'))) {
    return { source: 'missing', surface: null };
  }
  const record = dictGetOr(lock, name, undefined);
  if (!isDict(record) || dictGetOr(record, 'source', undefined) !== UPSTREAM) {
    return {
      source: `directory with no ${UPSTREAM} entry in ${SKILLS_LOCK}`,
      surface: null,
    };
  }
  const ref = dictGetOr(record, 'ref', undefined);
  if (typeof ref !== 'string' || !ref) {
    return { source: 'upstream, no ref recorded', surface: null };
  }
  const surface = Object.hasOwn(SKILL_SURFACES, ref)
    ? SKILL_SURFACES[ref]
    : null;
  if (surface === null) {
    return {
      source: 'upstream, at a ref that has not been reviewed',
      ref,
      surface: null,
    };
  }
  return { source: 'upstream', ref, surface };
}

/** Run git in `root` only when `root` is itself a work tree root. */
function git(root: string, args: string[]): string | null {
  const run = (command: string[]): string | null => {
    const result = runGit(root, command);
    return result.status === 0 ? pyStrip(result.stdout) : null;
  };
  const top = run(['rev-parse', '--show-toplevel']);
  if (top === null || pyResolve(top) !== pyResolve(root)) {
    return null;
  }
  return run(args);
}

export function preflight(
  project: string,
  server_release: string | null = null,
): Record<string, unknown> {
  const root = pyResolve(project);
  const library = join(root, '.agent-workflows');
  if (!isFile(join(root, 'AGENTS.md')) || !isDir(library)) {
    throw new ValueError(
      'Use the consumer root with AGENTS.md and its own .agent-workflows',
    );
  }
  const choice = read_capabilities(root);
  const record: Record<string, unknown> = {
    library_pin: git(library, ['rev-parse', 'HEAD']),
    library_version: git(library, ['describe', '--tags', '--always']),
    memory_choice: choice ?? 'unrecorded',
    claude_skills: isDir(join(root, CLAUDE_SKILLS)),
    server_release,
  };
  if (choice !== 'enabled') {
    record['verdict'] = 'not applicable';
    record['reasons'] = [
      `Memory is ${record['memory_choice']} in ${CAPABILITIES_FILE}; no` +
        ' memory compatibility applies.',
    ];
    return record;
  }
  const lockPath = join(root, SKILLS_LOCK);
  let lock: unknown = {};
  if (isFile(lockPath)) {
    const text = readText(lockPath);
    try {
      lock = dictGetOrAttributeError(jsonLoads(text), 'skills', {});
    } catch (error) {
      if (
        error instanceof ValueError ||
        error instanceof AttributeError
      ) {
        throw new ValueError(
          `Unreadable ${SKILLS_LOCK}; preserve and review:` +
            ` ${errorText(error)}`,
        );
      }
      throw error;
    }
  }
  const skills: Record<string, unknown> = {};
  for (const name of RETIRED_MEMORY_SKILLS) {
    skills[name] = skill_state(root, name, isDict(lock) ? lock : {});
  }
  let instructions: string;
  try {
    instructions = expected_instructions(root)[1];
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    instructions = `unavailable: ${errorText(error)}`;
  }
  record['skills'] = skills;
  record['generated_instructions'] = instructions;

  const reasons: string[] = [];
  const surfaces = new Set(
    Object.values(skills).map(
      (state) => (state as Record<string, unknown>)['surface'],
    ),
  );
  const unresolved = Object.keys(skills)
    .filter(
      (name) =>
        (skills[name] as Record<string, unknown>)['surface'] === null,
    )
    .sort(compareCodePoints);
  const serverSurface = server_surface_of(server_release);
  let verdict: string;
  if (unresolved.length) {
    verdict = 'unknown';
    reasons.push(
      'Cannot place these skills on a reviewed release: ' +
        unresolved
          .map(
            (name) =>
              `${name} (${(skills[name] as Record<string, unknown>)['source']})`,
          )
          .join(', '),
    );
  } else if (surfaces.size > 1) {
    verdict = 'incompatible';
    reasons.push(
      'Memory skills come from different tool surfaces; install all' +
        ' four from one upstream release.',
    );
  } else if (server_release === null) {
    verdict = 'unknown';
    reasons.push(
      'No --server-release given; the server cannot be discovered' +
        ' locally. Read its version on the service host.',
    );
  } else if (serverSurface === null) {
    verdict = 'unknown';
    reasons.push(
      `Server release ${pyRepr(server_release)} is not in the reviewed` +
        ' compatibility contract.',
    );
  } else if (surfaces.size === 1 && [...surfaces][0] === serverSurface) {
    verdict = 'compatible';
    reasons.push(
      `${SKILLS_LOCK} records all four skills at a release reviewed` +
        ` with server ${server_release} (${serverSurface} tool` +
        ' surface). File contents and client tool lists are not' +
        ' checked.',
    );
  } else {
    verdict = 'incompatible';
    reasons.push(
      `Skills use the ${[...surfaces][0]} tool surface but server` +
        ` ${server_release} exposes ${serverSurface}; every memory call` +
        ' would fail as an unknown tool. Replace the skills or the' +
        ' server release before using memory' +
        ' (docs/memory/consumer-update.md).',
    );
  }
  record['verdict'] = verdict;
  record['reasons'] = reasons;
  return record;
}

// ---------------------------------------------------------------------------
// argparse-compatible command line.
// ---------------------------------------------------------------------------

const PROG = 'agent-workflows.ts memory_preflight';
const USAGE =
  `usage: ${PROG} [-h] --project PROJECT\n` +
  '                           [--server-release SERVER_RELEASE]';

const HELP_TEXT =
  `${USAGE}\n` +
  '\n' +
  'Report a consumer\'s memory state before a library or server update. Local and\n' +
  'read-only: it reads files in the consumer checkout and never calls Basic\n' +
  'Memory. The server release cannot be discovered here, so the caller supplies\n' +
  'it with --server-release; without it the verdict is `unknown`. The printed\n' +
  'record is what a rollback needs: keep it with the update handoff.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --project PROJECT\n' +
  '  --server-release SERVER_RELEASE\n' +
  '                        Release of the Basic Memory server, e.g. 1.0.0\n';

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
  dest: 'help' | 'project' | 'server_release';
  takesValue: boolean;
}

const OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--project'], dest: 'project', takesValue: true },
  { names: ['--server-release'], dest: 'server_release', takesValue: true },
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

function parseArgs(argv: string[]): Record<string, string | boolean | undefined> {
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
    if (arg === '-h') {
      process.stdout.write(HELP_TEXT);
      throw new ExitError(0);
    }
    if (arg.startsWith('-h')) {
      // `consume_optional`: a no-argument single-dash option re-reads the
      // tail as more short options. A `=`-separated or `-`-leading
      // remainder is an ignored-explicit-argument error; an unknown tail
      // option lands in extras, so the queued help action still fires.
      let explicit = arg.slice(2);
      let separated = explicit.startsWith('=');
      if (separated) explicit = explicit.slice(1);
      for (;;) {
        if (separated || explicit.startsWith('-')) {
          parserError(
            `argument ${optionLabel(OPTIONS[0])}: ignored explicit argument` +
              ` ${pyRepr(explicit)}`,
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
  // `parse_known_args` validates required options before `parse_args`
  // joins leftovers into the unrecognized-arguments error.
  if (values.project === undefined) {
    parserError('the following arguments are required: --project');
  }
  if (extras.length) {
    parserError(`unrecognized arguments: ${extras.join(' ')}`);
  }
  return values;
}

function runMain(argv: string[]): number {
  const values = parseArgs(argv);
  try {
    const record = preflight(
      values.project as string,
      values.server_release !== undefined
        ? (values.server_release as string)
        : null,
    );
    console.log(jsonDumps(record));
    process.stderr.write(
      'Local files only; this does not assess MCP connectivity or client' +
        ' tool lists.\n',
    );
    return EXIT[record['verdict'] as string];
  } catch (error) {
    if (isValueOrOSError(error)) {
      process.stderr.write(`${errorText(error)}\n`);
      return 1;
    }
    throw error;
  }
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
