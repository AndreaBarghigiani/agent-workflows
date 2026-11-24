/**
 * Regenerate or check git-ignored project-scope Basic Memory connections —
 * TypeScript port of `scripts/setup_memory_connections.py` (issue #114).
 * The reviewed selection lives in `.agents/memory/config.toml`; every
 * worktree recovers it from the generated `.agents/memory/config.md`
 * marker that T3 readiness restores, so this command works in any
 * checkout of an opted-in consumer. It renders each selected client's
 * connection file from the machine-local profile (endpoint and credential
 * env-var NAME only), never writes a credential value, and reports drift,
 * shadowing and missing prerequisites with `--check`. A tracked client
 * file is consumer-owned: it is validated against the profile (or
 * structurally without one) and never rewritten — an entry that is not
 * verifiably aligned produces a targeted alignment instruction. Compose
 * it after the generated readiness launcher in the consumer's T3 worktree
 * setup action (the consumer owns the action). Local artifact state only;
 * it does not assess MCP connectivity.
 */
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pyResolve, repair_command } from './install.ts';
import { jsonDumps } from './memory_connections.ts';
import { runGit } from './lib/git.ts';
import { ValueError } from './lib/pyerrors.ts';
import { pyRepr } from './lib/pyrepr.ts';
import { run_connections } from './setup_memory.ts';

/** `Path(path)` spelling for CLI-supplied paths used in diagnostics. */
function purePath(value: string): string {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    parts.push(part);
  }
  const joined = parts.join('/');
  const result = (absolute ? '/' : '') + joined;
  return result === '' ? (absolute ? '/' : '.') : result;
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

// ---------------------------------------------------------------------------
// argparse-compatible command line.
// ---------------------------------------------------------------------------

const PROG = 'agent-workflows.ts setup_memory_connections';
const USAGE =
  `usage: ${PROG} [-h] --project PROJECT [--check]\n` +
  '                                   [--profile PROFILE]';

const HELP_TEXT =
  `${USAGE}\n` +
  '\n' +
  'Regenerate or check git-ignored project-scope Basic Memory connections. The\n' +
  'reviewed selection lives in `.agents/memory/config.toml`; every worktree\n' +
  'recovers it from the generated `.agents/memory/config.md` marker that T3\n' +
  'readiness restores, so this command works in any checkout of an opted-in\n' +
  'consumer. It renders each selected client\'s connection file from the machine-\n' +
  'local profile (endpoint and credential env-var NAME only), never writes a\n' +
  'credential value, and reports drift, shadowing and missing prerequisites with\n' +
  '`--check`. A tracked client file is consumer-owned: it is validated against\n' +
  'the profile (or structurally without one) and never rewritten — an entry that\n' +
  'is not verifiably aligned produces a targeted alignment instruction. Compose\n' +
  'it after the generated readiness launcher in the consumer\'s T3 worktree setup\n' +
  'action (the consumer owns the action). Local artifact state only; it does not\n' +
  'assess MCP connectivity.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help         show this help message and exit\n' +
  '  --project PROJECT\n' +
  '  --check\n' +
  '  --profile PROFILE  Machine connection profile override (default:\n' +
  '                     $XDG_CONFIG_HOME/agent-workflows/memory-connection.toml)\n';

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
  dest: 'help' | 'project' | 'check' | 'profile';
  takesValue: boolean;
}

const OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--project'], dest: 'project', takesValue: true },
  { names: ['--check'], dest: 'check', takesValue: false },
  { names: ['--profile'], dest: 'profile', takesValue: true },
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

function libraryRoot(): string {
  return dirname(dirname(pyResolve(fileURLToPath(import.meta.url))));
}

function runMain(argv: string[]): number {
  const values = parseArgs(argv);
  try {
    // Unlike `setup()` — which only refuses a subdirectory — this CLI's
    // gate also rejects a non-repository: a non-zero git status or a
    // toplevel other than the project is the same ValueError.
    const root = pyResolve(values.project as string);
    const toplevel = runGit(root, ['rev-parse', '--show-toplevel']);
    if (
      toplevel.status !== 0 ||
      pyResolve(pyStrip(toplevel.stdout)) !== root
    ) {
      throw new ValueError('Project must be the active worktree root');
    }
    const result = run_connections(root, {
      check: values.check === true,
      profile:
        values.profile !== undefined
          ? purePath(values.profile as string)
          : null,
      repair: repair_command(
        libraryRoot(),
        values.project as string,
        'setup_memory_connections.py',
      ),
      reconcile: repair_command(
        libraryRoot(),
        values.project as string,
        't3_readiness.py',
        ['--reconcile-routing-source'],
      ),
    });
    console.log(jsonDumps(result));
    return 0;
  } catch (error) {
    if (isValueOrOSError(error)) {
      console.error(error instanceof Error ? error.message : String(error));
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
