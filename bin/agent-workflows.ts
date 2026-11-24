/**
 * `agent-workflows` — the single entry point for the toolkit (issue #118).
 *
 * Every former `scripts/<name>.py` is a subcommand named after its stem:
 *
 *     node bin/agent-workflows.ts <command> [args...]
 *
 * In a consumer checkout the library lives at `.agent-workflows`, so the
 * invocation is `node .agent-workflows/bin/agent-workflows.ts <command>`.
 * Without `--json` each subcommand is byte-identical to the Python script
 * it replaces — options, stdout, stderr, exit status, and written files.
 *
 * `--json` runs the subcommand in a child process and emits exactly one
 * JSON document equivalent to
 *
 *     json.dumps({"ok": exit == 0, "exit": exit,
 *                 "stdout": <human stdout>, "stderr": <human stderr>},
 *                indent=2) + "\n"
 *
 * with `sort_keys=False` (key order: ok, exit, stdout, stderr). The child
 * still writes the same files and its exit status is propagated; process
 * stderr stays empty so callers can rely on stdout being one document.
 *
 * `update` is the exception: it carries its own `--json`, which prints
 * the update plan itself as one JSON document instead of the envelope.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { escapeString } from '../scripts/lib/pyjson.ts';

const SELF = realpathSync(fileURLToPath(import.meta.url));

type Entry = (argv: string[]) => number | Promise<number>;

interface Command {
  /**
   * The module's `main`, loaded on demand so a consumer library carrying
   * only a subset of the toolkit still dispatches the commands it has.
   */
  load: () => Promise<{ main: Entry }>;
  /**
   * The command owns its `--json` handling: argv passes through wrapped
   * in no envelope (`update plan --json` prints the plan document).
   */
  nativeJson?: boolean;
}

/** Python scripts keep their stems as subcommand names. */
const COMMANDS = new Map<string, Command>([
  ['install', { load: () => import('../scripts/install.ts') }],
  ['setup_memory', { load: () => import('../scripts/setup_memory.ts') }],
  [
    'setup_memory_connections',
    { load: () => import('../scripts/setup_memory_connections.ts') },
  ],
  ['memory_preflight', { load: () => import('../scripts/memory_preflight.ts') }],
  ['adopt_skills', { load: () => import('../scripts/adopt_skills.ts') }],
  ['mcp_configure', { load: () => import('../scripts/mcp_configure.ts') }],
  ['t3_readiness', { load: () => import('../scripts/t3_readiness.ts') }],
  ['t3_bootstrap', { load: () => import('../scripts/t3_bootstrap.ts') }],
  [
    'update',
    { load: () => import('../scripts/update_plan.ts'), nativeJson: true },
  ],
  ['validate', { load: () => import('../scripts/validate.ts') }],
]);

function usage(): string {
  return [
    'usage: agent-workflows <command> [args...]',
    '',
    'commands:',
    `  ${[...COMMANDS.keys()].join('\n  ')}`,
    '',
    'every command accepts --json for machine-readable output',
    '(update prints its plan document itself)',
  ].join('\n');
}

/**
 * The `--json` wrapper: replay the same dispatcher command in a child
 * process (minus `--json`), capture the human streams, and print the
 * one-document envelope on this process's stdout. Replaying through the
 * dispatcher keeps dispatch-level behavior — like `t3_bootstrap`'s `prog`
 * — identical inside and outside the envelope.
 */
function runJson(subcommand: string, argv: string[]): number {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  const result = spawnSync(process.execPath, [SELF, subcommand, ...argv], {
    encoding: 'utf8',
    env,
  });
  const exit = result.status ?? 1;
  process.stdout.write(
    '{\n' +
      `  "ok": ${exit === 0 ? 'true' : 'false'},\n` +
      `  "exit": ${exit},\n` +
      `  "stdout": ${escapeString(result.stdout ?? '')},\n` +
      `  "stderr": ${escapeString(result.stderr ?? '')}\n` +
      '}\n',
  );
  return exit;
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (
    subcommand === undefined ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    if (subcommand === undefined) {
      console.error(usage());
      return 2;
    }
    console.log(usage());
    return 0;
  }
  const command = COMMANDS.get(subcommand);
  if (command === undefined) {
    console.error(usage());
    console.error(`agent-workflows: error: unknown command '${subcommand}'`);
    return 2;
  }
  const jsonIndex = rest.indexOf('--json');
  if (jsonIndex !== -1 && command.nativeJson !== true) {
    const args = [...rest.slice(0, jsonIndex), ...rest.slice(jsonIndex + 1)];
    return runJson(subcommand, args);
  }
  const { main: entry } = await command.load();
  return entry(rest);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = await main();
}
