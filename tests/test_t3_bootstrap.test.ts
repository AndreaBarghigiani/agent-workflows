/**
 * `node:test` counterpart of `tests/test_t3_bootstrap.py` (issue #117).
 * Test names keep the Python method names so the mapping in
 * docs/node-port.md stays one-to-one. The consumer bootstrap file is the
 * TypeScript module renamed `.agent-workflows-t3.mjs`, the spelling
 * `main()`'s argparse `prog` reports as the invoked file or, under the
 * dispatcher, `agent-workflows.ts t3_bootstrap`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMPLATE = join(REPO, 'scripts/t3_bootstrap.ts');

const ENV = {
  ...process.env,
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_CONFIG_NOSYSTEM: '1',
};

function statusOf(result: ReturnType<typeof spawnSync>): number {
  if (result.status !== null) return result.status;
  const signals = osConstants.signals as Record<string, number>;
  return -(signals[result.signal ?? ''] ?? 0);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: ENV,
  });
  if (statusOf(result) !== 0) {
    throw new Error(`git -C ${cwd} ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout ?? '';
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

interface Fixture {
  tmp: string;
  librarySource: string;
  base: string;
  baseRef: string;
  pin: string;
  worktree: string;
  bootstrapFile: string;
}

/**
 * Mirrors `BootstrapTests.setUp`: a pinned library source carrying the
 * stub `t3_readiness.ts` helper — plain JavaScript so `node` runs it
 * without imports — a consumer with the submodule registered at
 * `vendor/agent-workflows`, and a fresh worktree holding a copy of the
 * bootstrap template plus its TypeScript import neighbors. `readinessPy`
 * pins the legacy Python stub instead, for the migration diagnostics.
 */
function makeFixture(
  options: {
    /** Extra files committed into the pinned library source. */
    pinFiles?: Record<string, string>;
    /** Copy the repository `scripts/lib` into the pin's `scripts/lib`. */
    pinLib?: boolean;
    /** Leave `scripts/t3_readiness.ts` out of the pinned library. */
    omitReadiness?: boolean;
    /** Pin the Python-era `t3_readiness.py` stub instead of the `.ts`. */
    readinessPy?: boolean;
  } = {},
): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), 't3-bootstrap-'));
  const librarySource = join(tmp, 'library-source');
  git(tmp, ['init', librarySource]);
  git(librarySource, ['config', 'user.email', 'test@example.invalid']);
  git(librarySource, ['config', 'user.name', 'Test']);
  if (options.omitReadiness !== true) {
    if (options.readinessPy === true) {
      writeText(
        join(librarySource, 'scripts/t3_readiness.py'),
        `import sys
from pathlib import Path
Path(sys.argv[sys.argv.index('--project') + 1], 'prepared.marker').write_text('prepared')
`,
      );
    } else {
      writeText(
        join(librarySource, 'scripts/t3_readiness.ts'),
        `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
writeFileSync(
  join(process.argv[process.argv.indexOf('--project') + 1], 'prepared.marker'),
  'prepared',
);
`,
      );
    }
  }
  for (const [name, content] of Object.entries(options.pinFiles ?? {})) {
    writeText(join(librarySource, name), content);
  }
  if (options.pinLib) {
    cpSync(join(REPO, 'scripts/lib'), join(librarySource, 'scripts/lib'), {
      recursive: true,
    });
  }
  git(librarySource, ['add', '.']);
  git(librarySource, ['commit', '--allow-empty', '-m', 'library helper']);
  const pin = git(librarySource, ['rev-parse', 'HEAD']).trim();

  const base = join(tmp, 'consumer');
  mkdirSync(base);
  git(tmp, ['init', base]);
  git(base, ['config', 'user.email', 'test@example.invalid']);
  git(base, ['config', 'user.name', 'Test']);
  writeText(join(base, 'AGENTS.md'), 'consumer\n');
  git(base, ['add', 'AGENTS.md']);
  git(base, ['commit', '-m', 'base']);
  const baseRef = git(base, ['rev-parse', 'HEAD']).trim();
  git(base, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    librarySource,
    'vendor/agent-workflows',
  ]);
  configure(base, baseRef);
  git(base, ['add', '.gitmodules', '.agent-workflows-t3.json']);
  git(base, ['commit', '-m', 'pin workflow library']);
  const worktree = join(tmp, 'fresh-worktree');
  git(base, ['worktree', 'add', '-b', 'fresh', worktree, 'HEAD']);
  const bootstrapFile = join(worktree, '.agent-workflows-t3.ts');
  cpSync(TEMPLATE, bootstrapFile);
  // The module's own imports resolve against its directory like the
  // generated consumer copy expects.
  cpSync(join(REPO, 'scripts/install.ts'), join(worktree, 'install.ts'));
  cpSync(join(REPO, 'scripts/lib'), join(worktree, 'lib'), {
    recursive: true,
  });
  return { tmp, librarySource, base, baseRef, pin, worktree, bootstrapFile };
}

function configure(
  root: string,
  baseRef: string,
  library = 'vendor/agent-workflows',
): void {
  const data = {
    choice: 'enabled',
    library,
    base: baseRef,
    profiles: [],
    memory: { routing_source: null },
  };
  writeText(join(root, '.agent-workflows-t3.json'), JSON.stringify(data));
}

function run(
  fixture: Fixture,
  args: string[] = [],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [fixture.bootstrapFile, ...args],
    { cwd: fixture.worktree, encoding: 'utf8', env: { ...ENV, ...env } },
  );
  return {
    status: statusOf(result),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

test('test_fresh_worktree_initializes_exact_pin_then_invokes_pinned_helper', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  assert.equal(
    existsSync(join(f.worktree, 'vendor/agent-workflows/.git')),
    false,
  );
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const library = join(f.worktree, 'vendor/agent-workflows');
  assert.equal(git(library, ['rev-parse', 'HEAD']).trim(), f.pin);
  assert.equal(
    readFileSync(join(f.worktree, 'prepared.marker'), 'utf8'),
    'prepared',
  );
});

test('test_legacy_skills_array_is_ignored', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const config = join(f.worktree, '.agent-workflows-t3.json');
  const data = JSON.parse(readFileSync(config, 'utf8')) as Record<
    string,
    unknown
  >;
  data['skills'] = ['unrelated-skill'];
  writeFileSync(config, JSON.stringify(data));
  const result = run(f, ['--check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not initialized/);
});

test('test_wrong_base_fails_before_initializing', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  writeText(join(f.base, 'unrelated'), 'later commit');
  git(f.base, ['add', 'unrelated']);
  git(f.base, ['commit', '-m', 'later commit']);
  configure(f.worktree, git(f.base, ['rev-parse', 'HEAD']).trim());
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an ancestor/);
  assert.equal(
    existsSync(join(f.worktree, 'vendor/agent-workflows/.git')),
    false,
  );
});

test('test_check_is_read_only_and_reports_missing_library', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const result = run(f, ['--check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not initialized/);
  assert.equal(
    readdirSync(join(f.worktree, 'vendor/agent-workflows')).length,
    0,
  );
  assert.equal(existsSync(join(f.worktree, 'prepared.marker')), false);
});

test('test_dirty_initialized_library_is_refused_without_repair', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  git(f.worktree, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--',
    'vendor/agent-workflows',
  ]);
  const helper = join(
    f.worktree,
    'vendor/agent-workflows/scripts/t3_readiness.ts',
  );
  writeText(helper, readFileSync(helper, 'utf8') + '# dirty\n');
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /dirty/);
  assert.match(readFileSync(helper, 'utf8'), /# dirty/);
  assert.equal(existsSync(join(f.worktree, 'prepared.marker')), false);
});

test('test_mismatched_initialized_library_is_refused_without_reset', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  git(f.worktree, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--',
    'vendor/agent-workflows',
  ]);
  const library = join(f.worktree, 'vendor/agent-workflows');
  git(library, [
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'user.name=Test',
    'commit',
    '--allow-empty',
    '-m',
    'off pin',
  ]);
  const mismatched = git(library, ['rev-parse', 'HEAD']).trim();
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /differs from the committed gitlink pin/);
  assert.equal(git(library, ['rev-parse', 'HEAD']).trim(), mismatched);
});

test('test_symlink_and_nonempty_uninitialized_destination_are_preserved', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const target = join(f.tmp, 'valuable');
  mkdirSync(target);
  writeText(join(target, 'keep'), 'keep');
  const destination = join(f.worktree, 'vendor/agent-workflows');
  rmSync(destination, { recursive: true });
  symlinkSync(target, destination, 'dir');
  let result = run(f);
  assert.notEqual(result.status, 0);
  assert.equal(lstatSync(destination).isSymbolicLink(), true);
  unlinkSync(destination);
  mkdirSync(destination);
  writeText(join(destination, 'keep'), 'keep');
  result = run(f);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(join(destination, 'keep'), 'utf8'), 'keep');
});

// --- Cross-port migration coverage (issue #117; no Python counterpart) ----

/**
 * A pin carrying only `t3_bootstrap.py` reports the pinned-Python
 * migration — one line, exit 1, no traceback. Exercises the generated
 * `.mjs` template against the Python-only bootstrap pin.
 */
test('test_node_bootstrap_reports_pinned_python_template', async (t) => {
  const f = makeFixture({
    pinFiles: {
      'scripts/t3_bootstrap.py': '# python-era bootstrap stub\n',
    },
  });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  cpSync(
    join(REPO, 'scripts/t3_bootstrap.mjs'),
    join(f.worktree, '.agent-workflows-t3.mjs'),
  );
  const result = spawnSync(
    process.execPath,
    [join(f.worktree, '.agent-workflows-t3.mjs')],
    {
      cwd: f.worktree,
      encoding: 'utf8',
      env: ENV,
    },
  );
  assert.equal(statusOf(result), 1);
  assert.match(
    result.stderr ?? '',
    /Pinned t3_bootstrap\.py needs migration to t3_bootstrap\.ts/,
  );
  assert.doesNotMatch(result.stderr ?? '', /at |Error:/);
});

/** Run the generated `.agent-workflows-t3.mjs` copied into the worktree. */
function runGenerated(
  fixture: Fixture,
  args: string[] = [],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  cpSync(
    join(REPO, 'scripts/t3_bootstrap.mjs'),
    join(fixture.worktree, '.agent-workflows-t3.mjs'),
  );
  const result = spawnSync(
    process.execPath,
    [join(fixture.worktree, '.agent-workflows-t3.mjs'), ...args],
    {
      cwd: fixture.worktree,
      encoding: 'utf8',
      env: { ...ENV, ...env },
    },
  );
  return {
    status: statusOf(result),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * A pin carrying `t3_bootstrap.ts` but only the Python readiness helper
 * reports that migration, no traceback.
 */
test('test_node_bootstrap_reports_pinned_python_readiness', async (t) => {
  const f = makeFixture({
    readinessPy: true,
    pinLib: true,
    pinFiles: {
      'scripts/t3_bootstrap.ts': readFileSync(TEMPLATE, 'utf8'),
      'scripts/install.ts': readFileSync(
        join(REPO, 'scripts/install.ts'),
        'utf8',
      ),
    },
  });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const result = run(f, []);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Pinned t3_readiness\.py needs migration to t3_readiness\.ts/,
  );
  assert.doesNotMatch(result.stderr, /at |Error:/);
});

/**
 * The generated `.mjs` is the trusted copy: `--check` is read-only, so
 * an uninitialized pin stays uninitialized — the launcher must report it
 * rather than running `git submodule update` itself.
 */
test('test_mjs_check_never_initializes_submodule', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const result = runGenerated(f, ['--check']);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Pinned library submodule is not initialized; run bootstrap without --check/,
  );
  assert.equal(
    existsSync(join(f.worktree, 'vendor/agent-workflows/.git')),
    false,
  );
});

/**
 * A library path that is not the registered gitlink — here a plain
 * directory carrying a side-effecting stub helper — must fail the trust
 * checks before anything from it is imported.
 */
test('test_mjs_check_refuses_unregistered_library_before_helper_runs', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const marker = join(f.tmp, 'stub-ran');
  writeText(
    join(f.worktree, 'vendor/unregistered/scripts/t3_bootstrap.ts'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
      'export function main() { return 0; }\n',
  );
  const config = join(f.worktree, '.agent-workflows-t3.json');
  const data = JSON.parse(readFileSync(config, 'utf8')) as Record<
    string,
    unknown
  >;
  data['library'] = 'vendor/unregistered';
  writeFileSync(config, JSON.stringify(data));
  const result = runGenerated(f, ['--check']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gitlink/);
  assert.equal(existsSync(marker), false);
});

/**
 * A helper whose bytes drifted from the committed pin — kept out of
 * `git status` with `--skip-worktree` so only the committed-byte
 * comparison can catch it — must be refused before it is imported.
 */
test('test_mjs_refuses_modified_helper_before_import', async (t) => {
  const f = makeFixture({
    pinFiles: {
      'scripts/t3_bootstrap.ts': readFileSync(TEMPLATE, 'utf8'),
    },
  });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  git(f.worktree, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--',
    'vendor/agent-workflows',
  ]);
  const library = join(f.worktree, 'vendor/agent-workflows');
  const marker = join(f.tmp, 'stub-ran');
  git(library, ['update-index', '--skip-worktree', 'scripts/t3_bootstrap.ts']);
  writeText(
    join(library, 'scripts/t3_bootstrap.ts'),
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(marker)}, 'ran');\n` +
      'export function main() { return 0; }\n',
  );
  const result = runGenerated(f);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Pinned helper content differs from library HEAD/,
  );
  assert.equal(existsSync(marker), false);
});

/**
 * The reviewer's probe: a pin missing `t3_readiness.ts` reports the
 * readiness-helper diagnostic even though `t3_bootstrap.ts` is missing
 * too — the generated copy runs `t3_bootstrap.ts`'s helper trust check
 * first and never reaches the TypeScript helper check.
 */
test('test_mjs_missing_readiness_helper_reports_helper_message', async (t) => {
  const f = makeFixture({ omitReadiness: true });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  git(f.worktree, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--',
    'vendor/agent-workflows',
  ]);
  const result = runGenerated(f);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'T3 bootstrap: Pinned t3_readiness.ts helper is missing or unsafe\n',
  );
});

/**
 * A readiness helper whose bytes drifted from the committed pin — hidden
 * from `git status` with `--skip-worktree` so only the committed-byte
 * comparison catches it — is refused before `t3_bootstrap.ts` is even
 * consulted.
 */
test('test_mjs_drifted_readiness_helper_reports_helper_message', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  git(f.worktree, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--',
    'vendor/agent-workflows',
  ]);
  const library = join(f.worktree, 'vendor/agent-workflows');
  const readiness = join(library, 'scripts/t3_readiness.ts');
  git(library, ['update-index', '--skip-worktree', 'scripts/t3_readiness.ts']);
  writeText(readiness, `${readFileSync(readiness, 'utf8')}# drift\n`);
  const result = runGenerated(f);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'T3 bootstrap: Pinned helper content differs from library HEAD\n',
  );
});

/**
 * A trustworthy readiness helper with neither bootstrap helper in the
 * pin reports the `.ts` as unavailable under the `T3 bootstrap: `
 * prefix — the rejected `Pinned t3_bootstrap.ts helper is missing or
 * unsafe` wording never appears.
 */
test('test_mjs_neither_bootstrap_helper_reports_unavailable', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  git(f.worktree, [
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'update',
    '--init',
    '--',
    'vendor/agent-workflows',
  ]);
  const result = runGenerated(f);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'T3 bootstrap: pinned library scripts/t3_bootstrap.ts is unavailable\n',
  );
});

/**
 * A malformed recorded choice reports CPython's `str(JSONDecodeError)`,
 * not V8's `JSON.parse` wording: `{broken` fails at the second column.
 */
test('test_mjs_config_decode_error_matches_cpython', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  writeFileSync(join(f.worktree, '.agent-workflows-t3.json'), '{broken');
  const result = runGenerated(f);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'T3 bootstrap: Cannot read .agent-workflows-t3.json: ' +
      'Expecting property name enclosed in double quotes: ' +
      'line 1 column 2 (char 1)\n',
  );
});

/**
 * A different invalid document — trailing data after a complete value —
 * keeps the decode formatter honest rather than a single hard-coded
 * sentence.
 */
test('test_mjs_config_extra_data_matches_cpython', async (t) => {
  const f = makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  writeFileSync(
    join(f.worktree, '.agent-workflows-t3.json'),
    '{"choice": "enabled"} extra',
  );
  const result = runGenerated(f);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr,
    'T3 bootstrap: Cannot read .agent-workflows-t3.json: ' +
      'Extra data: line 1 column 23 (char 22)\n',
  );
});

