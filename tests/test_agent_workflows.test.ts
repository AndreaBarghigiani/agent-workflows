/**
 * `bin/agent-workflows.ts` (issue #118): subcommand dispatch to the
 * TypeScript `main`s, and the `--json` envelope contract — exit code
 * preserved, stderr empty, stdout exactly one
 * `{"ok", "exit", "stdout", "stderr"}` document.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const DISPATCHER = join(REPO, 'bin/agent-workflows.ts');
const VALIDATE = join(REPO, 'scripts/validate.ts');
const INSTALL = join(REPO, 'scripts/install.ts');

const ENV = { ...process.env };
delete ENV.FORCE_COLOR;
delete ENV.NO_COLOR;

function statusOf(result: ReturnType<typeof spawnSync>): number {
  if (result.status !== null) return result.status;
  const signals = osConstants.signals as Record<string, number>;
  return -(signals[result.signal ?? ''] ?? 0);
}

function run(
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    env: ENV,
  });
  return {
    status: statusOf(result),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function dispatch(subcommand: string, args: string[] = []) {
  return run([DISPATCHER, subcommand, ...args]);
}

/** The `json.dumps(..., indent=2)` envelope the contract requires. */
function envelope(
  status: number,
  stdout: string,
  stderr: string,
): string {
  return (
    '{\n' +
    `  "ok": ${status === 0 ? 'true' : 'false'},\n` +
    `  "exit": ${status},\n` +
    `  "stdout": ${JSON.stringify(stdout)},\n` +
    `  "stderr": ${JSON.stringify(stderr)}\n` +
    '}\n'
  );
}

test('dispatch runs the subcommand and preserves exit/stdout/stderr', () => {
  const direct = run([VALIDATE]);
  const dispatched = dispatch('validate');
  assert.equal(dispatched.status, 0);
  assert.equal(dispatched.stdout, direct.stdout);
  assert.equal(dispatched.stderr, direct.stderr);
});

test('subcommand arguments and argparse errors match the module', () => {
  const direct = run([INSTALL, '--bogus']);
  const dispatched = dispatch('install', ['--bogus']);
  assert.equal(dispatched.status, direct.status);
  assert.equal(dispatched.stdout, direct.stdout);
  assert.equal(dispatched.stderr, direct.stderr);
  assert.match(dispatched.stderr, /usage: agent-workflows\.ts install/);
});

test('every-command usage and unknown command exit 2', () => {
  const missing = run([DISPATCHER]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage: agent-workflows <command>/);
  assert.match(missing.stderr, /validate/);
  const unknown = dispatch('no-such-command');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown command 'no-such-command'/);
});

test('--json wraps a successful run in the one-document envelope', () => {
  const human = dispatch('validate');
  const json = dispatch('validate', ['--json']);
  assert.equal(json.status, human.status);
  assert.equal(json.stderr, '');
  assert.equal(json.stdout, envelope(human.status, human.stdout, human.stderr));
});

test('--json preserves a failing exit code and captures the human streams', () => {
  const human = dispatch('install', ['--bogus']);
  const json = dispatch('install', ['--bogus', '--json']);
  assert.equal(json.status, human.status);
  assert.equal(json.status, 2);
  assert.equal(json.stderr, '');
  assert.equal(json.stdout, envelope(human.status, human.stdout, human.stderr));
});

test('--json output parses as a single JSON document with the key order', () => {
  const json = dispatch('validate', ['--json']);
  const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ['ok', 'exit', 'stdout', 'stderr']);
  assert.equal(parsed['ok'], true);
});
