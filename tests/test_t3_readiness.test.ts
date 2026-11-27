/**
 * `node:test` counterpart of `tests/test_t3_readiness.py` (issue #117).
 * Test names keep the Python method names so the mapping in
 * docs/node-port.md stays one-to-one. The pinned library fixture carries
 * the TypeScript modules (`*.ts`, `scripts/lib`, the `.mjs` template)
 * plus `t3_bootstrap.py` as the flag-unset generated template — the same
 * mixed pin this repository carries during the transition.
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
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ValueError } from '../scripts/lib/pyerrors.ts';
import { jsonDumpsDefault } from '../scripts/memory_connections.ts';
import { MEMORY_SKILLS } from '../scripts/install.ts';
import * as readiness from '../scripts/t3_readiness.ts';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const READINESS_TS = join(REPO, 'scripts/t3_readiness.ts');
const BOOTSTRAP_MJS = join(REPO, 'scripts/t3_bootstrap.mjs');
const BOOTSTRAP_PY = '.agent-workflows-t3.py';
const BOOTSTRAP_MJS_NAME = '.agent-workflows-t3.mjs';
const CONFIG_NAME = '.agent-workflows-t3.json';
const RELOCATED = '.agents/memory-routing.md';

type Dict = Record<string, unknown> | Map<string, unknown>;

function dictGet(m: Dict, k: string): unknown {
  return m instanceof Map ? m.get(k) : m[k];
}
function dictSet(m: Dict, k: string, v: unknown): void {
  if (m instanceof Map) m.set(k, v); else m[k] = v;
}
function dictSpread(m: Dict, k: string, v: unknown): Map<string, unknown> {
  const copy = new Map<string, unknown>(m as Map<string, unknown>);
  copy.set(k, v);
  return copy;
}
function eqPy(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => eqPy(x, (b as unknown[])[i]))
    );
  }
  const isD = (v: unknown): v is Dict =>
    v instanceof Map ||
    (typeof v === 'object' && v !== null && !Array.isArray(v));
  if (isD(a) || isD(b)) {
    if (!isD(a) || !isD(b)) return false;
    const ka = a instanceof Map ? [...a.keys()] : Object.keys(a);
    const kb = b instanceof Map ? [...b.keys()] : Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => dictGet(b, k) !== undefined || kb.includes(k)) &&
      ka.every((k) => eqPy(dictGet(a, k), dictGet(b, k)))
    );
  }
  return false;
}

function statusOf(result: ReturnType<typeof spawnSync>): number {
  if (result.status !== null) return result.status;
  const signals = osConstants.signals as Record<string, number>;
  return -(signals[result.signal ?? ''] ?? 0);
}

function runGit(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  if (statusOf(result) !== 0) {
    throw new Error(`git -C ${root} ${args.join(' ')}: ${result.stderr}`);
  }
  return (result.stdout ?? '').trim();
}

function commit(root: string, message: string): void {
  runGit(root, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '-qm', message,
  ]);
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/** `contextlib.redirect_stdout` for the helpers that print progress. */
function captureStdout<T>(fn: () => T): T {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

function throwsRegex(fn: () => unknown, pattern: RegExp): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assertValueError(thrown);
  assert.match((thrown as Error).message, pattern);
}

/**
 * `assertRaises(ValueError)` — the pinned library's helpers throw their own
 * module instance of `ValueError`, so match the Python class name, not the
 * repo's `instanceof`.
 */
function assertValueError(thrown: unknown): void {
  assert.ok(
    thrown instanceof Error &&
      (thrown instanceof ValueError || thrown.name === 'ValueError'),
    `expected ValueError, got ${String(thrown)}`,
  );
}

async function rejectsRegex(
  fn: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  assertValueError(thrown);
  assert.match((thrown as Error).message, pattern);
}

type HelperModule = Record<string, unknown>;

interface Fixture {
  tmp: string;
  root: string;
  library: string;
  config: Map<string, unknown>;
  install: HelperModule;
}

/**
 * Mirrors `T3ReadinessTests.setUp`: pinned library with the TypeScript
 * modules, demo installed skill, `setup-demo` reference-only skill and the
 * memory skill set; a consumer with the submodule, baseline install and
 * the recorded choice, then `configure()` producing the generated assets.
 */
async function makeFixture(
  options: {
    pinMode?: 'mixed' | 'python-only';
    omitPin?: string[];
    dispatcher?: boolean;
    /** Stub `.py` files written into the pin before it is committed. */
    stubPin?: string[];
  } = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), 't3-readiness-'));
  const root = join(tmp, 'consumer');
  const source = join(tmp, 'library-source');
  mkdirSync(root);
  mkdirSync(source);
  runGit(root, ['init', '-q']);
  runGit(source, ['init', '-q']);
  if (options.pinMode === 'python-only') {
    // Python-era pin: the `.py` names are enough — migration detection keys
    // on their presence and the suite never executes them.
    for (const name of [
      'install.py',
      'setup_memory.py',
      'memory_connections.py',
      't3_readiness.py',
      't3_bootstrap.py',
    ]) {
      writeText(join(source, 'scripts', name), '# python-era stub\n');
    }
  } else {
    cpSync(join(REPO, 'scripts'), join(source, 'scripts'), {
      recursive: true,
    });
  }
  if (options.dispatcher) {
    cpSync(join(REPO, 'bin'), join(source, 'bin'), { recursive: true });
  }
  for (const name of options.omitPin ?? []) {
    rmSync(join(source, 'scripts', name), { force: true });
  }
  for (const name of options.stubPin ?? []) {
    writeText(join(source, 'scripts', name), '# python-era stub\n');
  }
  for (const [name, frontmatter] of [
    ['demo', ''],
    ['setup-demo', 'distribution: reference-only\n'],
    ...MEMORY_SKILLS.map((n) => [n, ''] as [string, string]),
  ] as [string, string][]) {
    writeText(
      join(source, '.agents/skills', name, 'SKILL.md'),
      `---\nname: ${name}\n${frontmatter}---\nFixture.\n`,
    );
  }
  writeText(join(source, '.codex/agents/demo.toml'), "name='demo'\n");
  runGit(source, ['add', '.']);
  commit(source, 'library pin');
  runGit(root, [
    '-c', 'protocol.file.allow=always',
    'submodule', 'add', '-q', source, '.agent-workflows',
  ]);
  const library = join(root, '.agent-workflows');
  writeText(join(root, 'AGENTS.md'), '# Consumer\n');
  let install: HelperModule = {};
  if (options.pinMode === 'python-only') {
    // A Python-only pin cannot host the TypeScript helpers; write the
    // recorded capability directly instead of running a baseline install.
    writeText(
      join(root, '.agent-workflows-capabilities.json'),
      '{\n  "schema_version": 1,\n  "memory": "declined"\n}\n',
    );
  } else {
    install = (await import(
      pathToFileURL(join(library, 'scripts/install.ts')).href
    )) as HelperModule;
    captureStdout(() =>
      (install.install as CallableFunction)(library, root, {
        codex_agents: true,
        memory: 'declined',
      }),
    );
  }
  runGit(root, ['add', '.gitmodules', '.agent-workflows', 'AGENTS.md']);
  commit(root, 'consumer pin and instructions');
  const config = new Map<string, unknown>([
    ['choice', 'enabled'],
    ['library', '.agent-workflows'],
    ['base', runGit(root, ['rev-parse', 'HEAD'])],
    ['profiles', ['demo.toml']],
    ['memory', new Map<string, unknown>([['routing_source', null]])],
  ]);
  writeText(join(root, CONFIG_NAME), jsonDumpsDefault(config));
  if (options.pinMode !== 'python-only') {
    await readiness.configure(root);
  }
  return { tmp, root, library, config, install };
}

function save(f: Fixture): void {
  writeText(join(f.root, CONFIG_NAME), jsonDumpsDefault(f.config));
}

function selected(f: Fixture): string {
  return join(f.root, '.agents/skills/demo');
}

function route(f: Fixture): string {
  return join(f.root, '.agents/memory/config.md');
}

function enableMemory(f: Fixture): string {
  const source = join(f.root, 'reviewed-routing.md');
  writeText(source, '# Reviewed non-secret routing\n');
  dictSet(f.config, 'memory', new Map<string, unknown>([['routing_source', 'reviewed-routing.md']]));
  save(f);
  (f.install.write_capabilities as CallableFunction)(f.root, 'enabled');
  return source;
}

async function memoryModule(library: string): Promise<HelperModule> {
  return (await import(
    pathToFileURL(join(library, 'scripts/setup_memory.ts')).href
  )) as HelperModule;
}

/**
 * Mirrors `enable_generated_memory`: reviewed routing input under the
 * ignored generated directory plus a tracked copy named by
 * `memory.routing_source`.
 */
async function enableGeneratedMemory(
  f: Fixture,
  sourceName = RELOCATED,
  writeSource = true,
  clients?: string[],
): Promise<string> {
  const setupMem = await memoryModule(f.library);
  const memoryDir = join(f.root, '.agents/memory');
  mkdirSync(memoryDir, { recursive: true });
  writeText(
    join(memoryDir, 'config.toml'),
    'schema_version = 2\n\n[project]\nid = "demo"\n\n[memory]\n' +
      'write_project = "demo"\nsearch_projects = ["demo"]\n' +
      'related_projects = []\nmcp_server = "basic_memory"\n' +
      (clients === undefined
        ? ''
        : '\n[connection]\nclients = [' +
          clients.map((client) => `"${client}"`).join(', ') +
          ']\n'),
  );
  const [generated, state] = (
    setupMem.expected_instructions as CallableFunction
  )(f.root) as [string, string];
  assert.equal(state, 'missing');
  if (writeSource) {
    writeText(join(f.root, sourceName), generated);
  }
  dictSet(f.config, 'memory', new Map<string, unknown>([['routing_source', sourceName]]));
  save(f);
  (f.install.write_capabilities as CallableFunction)(f.root, 'enabled');
  const ignore = join(f.root, '.gitignore');
  const current = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!current.includes('/.agents/memory/')) {
    writeFileSync(ignore, current + '/.agents/memory/\n');
  }
  await readiness.restore_missing(f.root);
  assert.equal(readFileSync(join(memoryDir, 'config.md'), 'utf8'), generated);
  await readiness.assess(f.root);
  return generated;
}

function runCli(
  args: string[],
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [READINESS_TS, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return {
    status: statusOf(result),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function configData(root: string): Map<string, unknown> {
  return JSON.parse(readFileSync(join(root, CONFIG_NAME), 'utf8')) as never;
}

test('test_issue_only_reference_only_and_local_profiles', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const profile = join(f.root, '.codex/agents/demo.toml');
  unlinkSync(profile);
  writeText(profile, 'local override\n');
  await readiness.assess(f.root);
  await readiness.check_action(f.root);
  await readiness.restore_missing(f.root);
  assert.equal(readFileSync(profile, 'utf8'), 'local override\n');
  assert.equal(existsSync(join(f.root, '.agents/skills/setup-demo')), false);
  assert.equal(existsSync(route(f)), false);
});

test('test_wrong_source_and_local_skill_override_are_preserved', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  unlinkSync(selected(f));
  const outside = join(f.tmp, 'other-skill');
  mkdirSync(outside);
  symlinkSync(outside, selected(f));
  await rejectsRegex(() => readiness.restore_missing(f.root), /wrong source/);
  assert.equal(lstatSync(selected(f)).isSymbolicLink(), true);
  assert.equal(realpathSync(selected(f)), realpathSync(outside));
  unlinkSync(selected(f));
  mkdirSync(selected(f));
  await rejectsRegex(() => readiness.assess(f.root), /Local skill override/);
});

test('test_reference_pointer_requires_exact_source', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const agents = join(f.root, 'AGENTS.md');
  writeText(
    agents,
    readFileSync(agents, 'utf8').replace(
      '.agent-workflows/.agents/skills/setup-demo',
      'somewhere/setup-demo',
    ),
  );
  await rejectsRegex(() => readiness.assess(f.root), /pointer differs/);
});

test('test_library_must_be_own_tracked_clean_pin', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  writeText(join(f.root, 'stub/scripts/t3_readiness.py'), '# stub\n');
  dictSet(f.config, 'library', 'stub');
  save(f);
  await rejectsRegex(() => readiness.assess(f.root), /gitlink/);
  dictSet(f.config, 'library', '.agent-workflows');
  save(f);
  const helper = join(f.library, 'scripts/t3_readiness.ts');
  writeText(helper, readFileSync(helper, 'utf8') + '# dirty\n');
  await rejectsRegex(() => readiness.assess(f.root), /dirty/);
});

test('test_mismatched_pin_and_uninitialized_submodule_are_not_repaired', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const original = runGit(f.library, ['rev-parse', 'HEAD']);
  runGit(f.library, [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    'commit', '--allow-empty', '-qm', 'off pin',
  ]);
  const changed = runGit(f.library, ['rev-parse', 'HEAD']);
  await rejectsRegex(() => readiness.assess(f.root), /HEAD differs/);
  assert.equal(runGit(f.library, ['rev-parse', 'HEAD']), changed);
  runGit(f.library, ['checkout', '-q', original]);
  runGit(f.root, ['submodule', 'deinit', '--force', '.agent-workflows']);
  await rejectsRegex(() => readiness.assess(f.root), /uninitialized/);
});

test('test_wrong_base_prevents_preparation', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  unlinkSync(selected(f));
  dictSet(f.config, 'base', 'missing-base');
  save(f);
  await rejectsRegex(() => readiness.restore_missing(f.root), /Expected base/);
  assert.equal(existsSync(selected(f)), false);
});

test('test_prepare_restores_missing_selection_and_routing_then_repeats', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const source = enableMemory(f);
  unlinkSync(selected(f));
  await rejectsRegex(() => readiness.assess(f.root), /prerequisite missing/);
  await readiness.restore_missing(f.root);
  await readiness.assess(f.root);
  assert.equal(
    readFileSync(route(f), 'utf8'),
    readFileSync(source, 'utf8'),
  );
  const before = lstatSync(route(f)).mtimeMs;
  await readiness.restore_missing(f.root);
  assert.equal(lstatSync(route(f)).mtimeMs, before);
});

test('test_routing_conflict_prevents_all_asset_writes', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  enableMemory(f);
  mkdirSync(dirname(route(f)), { recursive: true });
  writeText(route(f), 'custom routing\n');
  unlinkSync(selected(f));
  await rejectsRegex(
    () => readiness.restore_missing(f.root),
    /differs from source/,
  );
  assert.equal(existsSync(selected(f)), false);
  assert.equal(readFileSync(route(f), 'utf8'), 'custom routing\n');
});

test('test_dangling_route_and_parent_symlinks_never_write_outside', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  enableMemory(f);
  mkdirSync(dirname(route(f)), { recursive: true });
  const outside = join(f.tmp, 'outside.md');
  symlinkSync(outside, route(f));
  await rejectsRegex(() => readiness.restore_missing(f.root), /Symlink/);
  assert.equal(existsSync(outside), false);
  unlinkSync(route(f));
  rmSync(dirname(route(f)), { recursive: true });
  const outsideDir = join(f.tmp, 'outside-dir');
  mkdirSync(outsideDir);
  symlinkSync(outsideDir, dirname(route(f)));
  await rejectsRegex(() => readiness.restore_missing(f.root), /Symlink/);
  assert.equal(readdirSync(outsideDir).length, 0);
});

test('test_routing_source_symlinks_and_missing_sources_are_refused', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const source = enableMemory(f);
  unlinkSync(source);
  let thrown: unknown;
  try {
    await readiness.restore_missing(f.root);
  } catch (error) {
    thrown = error;
  }
  assertValueError(thrown);
  const message = (thrown as Error).message;
  assert.match(message, new RegExp(CONFIG_NAME.replaceAll('.', '\\.')));
  assert.match(message, /memory\.routing_source/);
  assert.match(message, /setup_memory --project/);
  symlinkSync(join(f.tmp, 'outside'), source);
  await rejectsRegex(() => readiness.restore_missing(f.root), /Symlink/);
});

test('test_custom_library_path_works_without_shell_interpolation', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const name = "vendor/$odd`' path";
  mkdirSync(join(f.root, 'vendor'));
  runGit(f.root, ['mv', '.agent-workflows', name]);
  commit(f.root, 'relocate fixture pin');
  f.library = join(f.root, name);
  dictSet(f.config, 'library', name);
  dictSet(f.config, 'base', runGit(f.root, ['rev-parse', 'HEAD']));
  save(f);
  // A path change requires a reviewed normal selected installation refresh.
  unlinkSync(selected(f));
  unlinkSync(join(f.root, '.codex/agents/demo.toml'));
  const agents = join(f.root, 'AGENTS.md');
  writeText(
    agents,
    readFileSync(agents, 'utf8').replace(
      '.agent-workflows/.agents',
      `${name}/.agents`,
    ),
  );
  await readiness.restore_missing(f.root);
  await readiness.configure(f.root);
  await readiness.check_action(f.root);
  assert.equal(
    dictGet(readiness.action(), 'command'),
    'node .agent-workflows-t3.mjs',
  );
  assert.equal(
    realpathSync(selected(f)),
    join(f.library, '.agents/skills/demo'),
  );
});

test('test_generate_preserves_fields_actions_and_unchanged_bytes', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  writeText(
    path,
    jsonDumpsDefault(
      new Map<string, unknown>([
        ['unrelated', new Map<string, unknown>([['keep', true]])],
        [
          'scripts',
          [
            new Map<string, unknown>([
              ['id', 'manual'],
              ['name', 'Manual'],
              ['command', 'true'],
            ]),
          ],
        ],
      ]),
    ),
  );
  await readiness.configure(f.root);
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    unrelated: { keep: boolean };
    scripts: Record<string, unknown>[];
  };
  assert.equal(data.unrelated.keep, true);
  assert.equal(data.scripts.length, 2);
  assert.equal(data.scripts[1]['async'], false);
  assert.equal(data.scripts[1]['runOnSettle'], false);
  const before = new Map(
    ['t3.json', BOOTSTRAP_MJS_NAME].map((name) => [
      name,
      readFileSync(join(f.root, name)),
    ]),
  );
  await readiness.configure(f.root);
  for (const [name, bytes] of before) {
    assert.deepEqual(readFileSync(join(f.root, name)), bytes);
  }
});

test('test_composed_connection_action_is_preserved_and_ready', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await readiness.configure(f.root);
  const path = join(f.root, 't3.json');
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts: { command: string }[];
  };
  data.scripts[0].command +=
    ' && node .agent-workflows/bin/agent-workflows.ts' +
    ' setup_memory_connections --project .';
  writeText(path, JSON.stringify(data, null, 4) + '\n');
  const before = readFileSync(path);
  await readiness.configure(f.root);
  await readiness.check_action(f.root);
  assert.deepEqual(readFileSync(path), before);
});

test('test_invalid_composition_is_refused', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const base = readiness.action();
  for (const suffix of [' &&', ' || true', ' ; true']) {
    const item = dictSpread(
      base,
      'command',
      `${dictGet(base, 'command')}${suffix}`,
    );
    writeText(
      join(f.root, 't3.json'),
      jsonDumpsDefault(new Map<string, unknown>([['scripts', [item]]])),
    );
    await rejectsRegex(() => readiness.configure(f.root), /conflicts/);
  }
});

test('test_customized_actions_and_competing_roles_are_refused', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  const base = readiness.action();
  const variants: Map<string, unknown>[] = [
    dictSpread(base, 'runOnWorktreeCreate', false) as Map<string, unknown>,
    dictSpread(base, 'id', 'other') as Map<string, unknown>,
    new Map<string, unknown>([
      ['name', ' Agent workflows checkout readiness '],
      ['command', 'true'],
    ]),
    new Map<string, unknown>([
      ['name', 'Other'],
      ['command', ' node .agent-workflows-t3.mjs '],
    ]),
    new Map<string, unknown>([
      ['id', 'existing'],
      ['name', 'Existing setup'],
      ['command', 'existing'],
      ['runOnWorktreeCreate', true],
    ]),
  ];
  for (const item of variants) {
    writeText(path, jsonDumpsDefault(new Map<string, unknown>([['scripts', [item]]])));
    const before = readFileSync(path);
    await rejectsRegex(() => readiness.configure(f.root), /conflicts/);
    assert.deepEqual(readFileSync(path), before);
  }
});

test('test_malformed_config_and_generated_assets_are_non_mutating', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  writeText(path, '{"scripts":');
  const launcher = join(f.root, BOOTSTRAP_MJS_NAME);
  unlinkSync(launcher);
  const before = readFileSync(path);
  await assert.rejects(() => readiness.configure(f.root));
  assert.equal(existsSync(launcher), false);
  assert.deepEqual(readFileSync(path), before);
  unlinkSync(path);
  await rejectsRegex(() => readiness.check_action(f.root), /missing/);
});

test('test_customized_launcher_is_preserved', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, BOOTSTRAP_MJS_NAME);
  writeText(path, '# customized launcher\n');
  await rejectsRegex(() => readiness.configure(f.root), /customized or stale/);
  assert.equal(readFileSync(path, 'utf8'), '# customized launcher\n');
});

test('test_decline_requires_no_library_or_memory_and_cannot_generate', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  dictSet(f.config, 'choice', 'declined');
  save(f);
  runGit(f.root, ['submodule', 'deinit', '--force', '.agent-workflows']);
  assert.match((await readiness.assess(f.root))[0], /declined/);
  await readiness.check_action(f.root);
  const before = readFileSync(join(f.root, 't3.json'));
  await rejectsRegex(() => readiness.configure(f.root), /requires enabled/);
  assert.deepEqual(readFileSync(join(f.root, 't3.json')), before);
});

test('test_legacy_skills_array_is_ignored_and_toolkit_is_derived', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  dictSet(f.config, 'skills', [
    { name: 'demo', mode: 'installed' },
    { name: 'setup-demo', mode: 'reference-only' },
  ]);
  save(f);
  await readiness.assess(f.root);
  await readiness.check_action(f.root);
  dictSet(f.config, 'skills', []);
  save(f);
  await readiness.assess(f.root);
  assert.equal(lstatSync(selected(f)).isSymbolicLink(), true);
});

test('test_memory_choice_lives_only_in_capabilities_file', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  unlinkSync(join(f.root, '.agent-workflows-capabilities.json'));
  await rejectsRegex(
    () => readiness.assess(f.root),
    /Memory choice not recorded/,
  );
  (f.install.write_capabilities as CallableFunction)(f.root, 'declined');
  await readiness.assess(f.root);
  dictSet(
    f.config,
    'memory',
    new Map<string, unknown>([
      ['enabled', true],
      ['routing_source', null],
    ]),
  );
  save(f);
  const before = readFileSync(join(f.root, CONFIG_NAME));
  await rejectsRegex(() => readiness.assess(f.root), /conflicts with the/);
  assert.deepEqual(readFileSync(join(f.root, CONFIG_NAME)), before);
  (f.install.write_capabilities as CallableFunction)(f.root, 'enabled');
  await rejectsRegex(() => readiness.assess(f.root), /routing/);
});

test('test_invalid_enablement_never_persists_partial_choice', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, CONFIG_NAME);
  unlinkSync(path);
  const reviewed = join(f.root, 'reviewed.json');
  for (const changes of [
    { base: 'absent' },
    { profiles: ['unknown.toml'] },
    { memory: { enabled: 'false', routing_source: null } },
  ]) {
    const merged = new Map(f.config);
    for (const [k, v] of Object.entries(changes)) merged.set(k, v);
    writeText(reviewed, jsonDumpsDefault(merged));
    await assert.rejects(() =>
      readiness.record_choice(f.root, 'enabled', reviewed),
    );
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(`${path}.preflight`), false);
  }
});

test('test_unchanged_choice_reruns_and_explicit_later_enablement', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, CONFIG_NAME);
  unlinkSync(path);
  await readiness.record_choice(f.root, 'declined');
  const before = readFileSync(path);
  await readiness.record_choice(f.root, 'declined');
  assert.deepEqual(readFileSync(path), before);
  const reviewed = join(f.root, 'reviewed.json');
  writeText(reviewed, jsonDumpsDefault(f.config));
  await rejectsRegex(
    () => readiness.record_choice(f.root, 'enabled', reviewed),
    /already recorded/,
  );
  assert.deepEqual(readFileSync(path), before);
  await readiness.record_choice(f.root, 'enabled', reviewed, true);
  assert.ok(eqPy(readiness.load(f.root), f.config));
});

test('test_cli_check_does_not_create_or_repair_missing_assets', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  unlinkSync(selected(f));
  let result = runCli(['--project', f.root, '--check']);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(selected(f)), false);
  result = runCli(['--project', f.root, '--check', '--prepare']);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(selected(f)), false);
});

test('test_supported_t3_contract_rejects_invalid_preserved_fields', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  const expected = readiness.action();
  const spread = (extra: [string, unknown]) =>
    new Map<string, unknown>([...expected as Map<string, unknown>, extra]);
  const cases: Map<string, unknown>[] = [
    new Map<string, unknown>([['scripts', [expected, new Map<string, unknown>([['command', 'true']])]]]),
    new Map<string, unknown>([['scripts', [expected, new Map<string, unknown>([['name', 'Manual']])]]]),
    new Map<string, unknown>([['scripts', [spread(['async', 'false'])]]]),
    new Map<string, unknown>([['scripts', [spread(['runOnWorktreeCreate', 'true'])]]]),
    new Map<string, unknown>([['scripts', [spread(['runOnSettle', 0])]]]),
    new Map<string, unknown>([['scripts', [spread(['icon', 'invalid'])]]]),
    new Map<string, unknown>([['scripts', [spread(['previewUrl', '   '])]]]),
    new Map<string, unknown>([
      ['scripts', [expected]],
      ['defaultThreadEnvMode', 'invalid'],
    ]),
    new Map<string, unknown>([['scripts', [expected]], ['worktreeSubmodules', null]]),
    new Map<string, unknown>([['scripts', [expected]], ['iconPath', 'x'.repeat(513)]]),
    new Map<string, unknown>([['scripts', [expected]], ['$schema', 1]]),
  ];
  for (const data of cases) {
    writeText(path, jsonDumpsDefault(data));
    const before = readFileSync(path);
    await rejectsRegex(() => readiness.check_action(f.root), /./);
    await assert.rejects(() => readiness.configure(f.root));
    assert.deepEqual(readFileSync(path), before);
  }
});

test('test_action_limit_and_invalid_file_prevent_partial_generation_or_choice', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const launcher = join(f.root, BOOTSTRAP_MJS_NAME);
  unlinkSync(launcher);
  const path = join(f.root, 't3.json');
  writeText(
    path,
    jsonDumpsDefault(
      new Map<string, unknown>([
        [
          'scripts',
          Array.from({ length: 50 }, (_, n) =>
            new Map<string, unknown>([
              ['name', `Manual ${n}`],
              ['command', `echo ${n}`],
            ]),
          ),
        ],
      ]),
    ),
  );
  const before = readFileSync(path);
  await rejectsRegex(() => readiness.configure(f.root), /at most 50/);
  assert.equal(existsSync(launcher), false);
  assert.deepEqual(readFileSync(path), before);
  unlinkSync(join(f.root, CONFIG_NAME));
  const reviewed = join(f.root, 'reviewed.json');
  writeText(reviewed, jsonDumpsDefault(f.config));
  await assert.rejects(() =>
    readiness.record_choice(f.root, 'enabled', reviewed),
  );
  assert.equal(existsSync(join(f.root, CONFIG_NAME)), false);
});

test('test_detect_and_repair_deleted_tracked_source', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const generated = await enableGeneratedMemory(f);
  const source = join(f.root, RELOCATED);
  unlinkSync(source);
  let result = runCli(['--project', f.root, '--check-routing-source']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.agent-workflows-t3\.json/);
  assert.match(result.stderr, /memory\.routing_source/);
  assert.match(result.stderr, /--reconcile-routing-source/);
  await rejectsRegex(() => readiness.assess(f.root), /memory\.routing_source/);
  const before = readFileSync(join(f.root, CONFIG_NAME));
  result = runCli(['--project', f.root, '--reconcile-routing-source']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Wrote tracked routing source/);
  assert.deepEqual(readFileSync(source), Buffer.from(generated, 'utf8'));
  assert.deepEqual(readFileSync(join(f.root, CONFIG_NAME)), before);
  await readiness.assess(f.root);
  await readiness.check_action(f.root);
  result = runCli(['--project', f.root, '--check-routing-source']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no reconciliation needed/);
  const again = await readiness.reconcile_routing_source(f.root);
  assert.ok(again.some((line) => line.includes('already matches')));
  assert.deepEqual(readFileSync(source), Buffer.from(generated, 'utf8'));
});

test('test_repair_repoints_paths_that_cannot_hold_the_tracked_copy', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const generated = await enableGeneratedMemory(f, '.agents/memory.toml');
  const legacy = join(f.root, '.agents/memory.toml');
  writeText(legacy, 'retired v1 routing\n');
  await rejectsRegex(
    () => readiness.routing_source_status(f.root),
    /cannot hold the tracked/,
  );
  const reports = await readiness.reconcile_routing_source(f.root);
  const relocated = join(f.root, RELOCATED);
  assert.deepEqual(readFileSync(relocated), Buffer.from(generated, 'utf8'));
  assert.equal(readFileSync(legacy, 'utf8'), 'retired v1 routing\n');
  assert.ok(
    reports.some(
      (line) => line.includes('Repointed') && line.includes('.agents/memory.toml'),
    ),
  );
  assert.ok(reports.some((line) => line.includes('untouched')));
  assert.ok(reports.some((line) => line.includes('git status:')));
  const data = configData(f.root);
  assert.equal(
    dictGet(dictGet(data, 'memory') as Dict, 'routing_source'),
    RELOCATED,
  );
  await readiness.assess(f.root);
  for (const name of ['.agents/memory/config.md', '.agents/memory/routing.md']) {
    try {
      unlinkSync(join(f.root, '.agents/memory/routing.md'));
    } catch {
      // missing_ok=True
    }
    dictSet(
      dictGet(f.config, 'memory') as Dict,
      'routing_source',
      name,
    );
    save(f);
    await readiness.reconcile_routing_source(f.root);
    const data2 = configData(f.root);
    assert.equal(
      dictGet(dictGet(data2, 'memory') as Dict, 'routing_source'),
      RELOCATED,
    );
    assert.deepEqual(
      readFileSync(relocated),
      Buffer.from(generated, 'utf8'),
    );
  }
});

test('test_relocated_source_inside_shared_memory_directory_stays', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const generated = await enableGeneratedMemory(f, '.agents/memory/routing.md');
  writeFileSync(join(f.root, '.gitignore'), '');
  assert.equal(
    readiness.source_must_move(f.root, [
      '.agents',
      'memory',
      'routing.md',
    ]),
    false,
  );
  unlinkSync(join(f.root, '.agents/memory/routing.md'));
  const reports = await readiness.reconcile_routing_source(f.root);
  const source = join(f.root, '.agents/memory/routing.md');
  assert.deepEqual(readFileSync(source), Buffer.from(generated, 'utf8'));
  const data = configData(f.root);
  assert.equal(
    dictGet(dictGet(data, 'memory') as Dict, 'routing_source'),
    '.agents/memory/routing.md',
  );
  assert.equal(reports.some((line) => line.includes('Repointed')), false);
});

test('test_reconcile_refuses_unusable_generated_routing', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await enableGeneratedMemory(f);
  const source = join(f.root, RELOCATED);
  unlinkSync(source);
  const routePath = route(f);
  writeText(routePath, 'custom routing\n');
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /customized/,
  );
  await rejectsRegex(
    () => readiness.routing_source_status(f.root),
    /customized/,
  );
  unlinkSync(routePath);
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /setup_memory --project/,
  );
  assert.equal(existsSync(source), false);
  unlinkSync(join(f.root, '.agents/memory/config.toml'));
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /portable/,
  );
  assert.equal(existsSync(source), false);
});

test('test_reconcile_refuses_stale_generated_routing', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const generated = await enableGeneratedMemory(f);
  const setupMem = await memoryModule(f.library);
  const stale = (
    setupMem.previous_generated as CallableFunction
  )(generated)[0] as string;
  writeText(route(f), stale);
  unlinkSync(join(f.root, RELOCATED));
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /stale/,
  );
  assert.equal(readFileSync(route(f), 'utf8'), stale);
});

test('test_python_era_connection_routing_reconciles_after_refresh', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const generated = await enableGeneratedMemory(
    f,
    RELOCATED,
    true,
    ['claude'],
  );
  // The exact text v0.4.0 through v0.5.0 generated names the Python
  // helper; it is stale, never customized (#139).
  const python = generated.replace(
    '`setup_memory_connections`',
    '`setup_memory_connections.py`',
  );
  assert.notEqual(python, generated);
  const routePath = route(f);
  const source = join(f.root, RELOCATED);
  writeText(routePath, python);
  for (const check of [
    () => readiness.routing_source_status(f.root),
    () => readiness.reconcile_routing_source(f.root),
  ]) {
    await rejectsRegex(check, /stale[\s\S]*setup_memory/);
  }
  // Refreshed generated routing leaves the tracked Python-era source as
  // drift; reconcile rewrites it with the current generated bytes.
  writeText(routePath, generated);
  writeText(source, python);
  await rejectsRegex(
    () => readiness.routing_source_status(f.root),
    /drifted/,
  );
  await readiness.reconcile_routing_source(f.root);
  assert.deepEqual(readFileSync(source), Buffer.from(generated, 'utf8'));
  await readiness.routing_source_status(f.root);
  // A genuinely customized config.md still refuses and preserves the
  // tracked file.
  writeText(routePath, generated + 'Local note.\n');
  const kept = readFileSync(source);
  for (const check of [
    () => readiness.routing_source_status(f.root),
    () => readiness.reconcile_routing_source(f.root),
  ]) {
    await rejectsRegex(check, /customized/);
  }
  assert.deepEqual(readFileSync(source), kept);
});

test('test_reconcile_refuses_null_source_and_declined_choices', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await enableGeneratedMemory(f);
  dictSet(dictGet(f.config, 'memory') as Dict, 'routing_source', null);
  save(f);
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /explicit setup choice/,
  );
  (f.install.write_capabilities as CallableFunction)(f.root, 'declined');
  dictSet(
    dictGet(f.config, 'memory') as Dict,
    'routing_source',
    RELOCATED,
  );
  save(f);
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /declined/,
  );
  dictSet(f.config, 'choice', 'declined');
  save(f);
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /requires enabled/,
  );
});

test('test_routing_source_check_not_applicable_states_and_mismatch', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const missing = join(f.tmp, 'elsewhere');
  assert.match(
    (await readiness.routing_source_status(missing))[0],
    /not applicable/,
  );
  const generated = await enableGeneratedMemory(f);
  void generated;
  assert.match(
    (await readiness.routing_source_status(f.root))[0],
    /no reconciliation needed/,
  );
  const source = join(f.root, RELOCATED);
  writeText(source, 'stale copy\n');
  await rejectsRegex(() => readiness.routing_source_status(f.root), /differs/);
  dictSet(dictGet(f.config, 'memory') as Dict, 'routing_source', null);
  save(f);
  await rejectsRegex(() => readiness.routing_source_status(f.root), /null/);
});

test('test_detection_and_repair_skip_disabled_memory_or_t3', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  (f.install.write_capabilities as CallableFunction)(f.root, 'declined');
  assert.match(
    (await readiness.routing_source_status(f.root))[0],
    /not applicable/,
  );
  dictSet(f.config, 'choice', 'declined');
  save(f);
  assert.match(
    (await readiness.routing_source_status(f.root))[0],
    /not applicable/,
  );
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /requires enabled/,
  );
});

test('test_relocate_target_conflict_is_preserved', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await enableGeneratedMemory(f, '.agents/memory.toml');
  writeText(join(f.root, '.agents/memory.toml'), 'retired v1 routing\n');
  const relocated = join(f.root, RELOCATED);
  writeText(relocated, "someone else's file\n");
  await rejectsRegex(
    () => readiness.reconcile_routing_source(f.root),
    /preserve and review/,
  );
  assert.equal(readFileSync(relocated, 'utf8'), "someone else's file\n");
  const data = configData(f.root);
  assert.equal(
    dictGet(dictGet(data, 'memory') as Dict, 'routing_source'),
    '.agents/memory.toml',
  );
});

test('test_generated_destination_conflict_cites_repair', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await enableGeneratedMemory(f);
  dictSet(
    dictGet(f.config, 'memory') as Dict,
    'routing_source',
    '.agents/memory/config.md',
  );
  save(f);
  await rejectsRegex(
    () => readiness.assess(f.root),
    /memory\.routing_source[\s\S]*--reconcile-routing-source/,
  );
});

test('test_reconcile_refuses_ignored_fallback_without_writes', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await enableGeneratedMemory(f, '.agents/memory.toml');
  const before = readFileSync(join(f.root, CONFIG_NAME));
  const target = join(f.root, RELOCATED);
  for (const pattern of ['/.agents/memory-routing.md\n', '/.agents/\n']) {
    writeFileSync(join(f.root, '.gitignore'), pattern);
    await rejectsRegex(
      () => readiness.reconcile_routing_source(f.root),
      /review \.gitignore/,
    );
    assert.equal(existsSync(target), false);
    assert.deepEqual(readFileSync(join(f.root, CONFIG_NAME)), before);
  }
});

test('test_reconcile_preserves_exact_crlf_generated_bytes', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const generated = await enableGeneratedMemory(f);
  const exact = Buffer.from(generated.replace(/\n/g, '\r\n'), 'utf8');
  writeFileSync(route(f), exact);
  await readiness.reconcile_routing_source(f.root);
  assert.deepEqual(readFileSync(join(f.root, RELOCATED)), exact);
  await readiness.routing_source_status(f.root);
  await readiness.reconcile_routing_source(f.root);
  await readiness.assess(f.root);
});

test('test_fresh_worktree_flags_routing_source_stale_before_optin', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const mem = await memoryModule(f.library);
  const conn = (await import(
    pathToFileURL(join(f.library, 'scripts/memory_connections.ts')).href
  )) as HelperModule;
  await enableGeneratedMemory(f);
  await readiness.configure(f.root);
  runGit(f.root, ['add', '-A']);
  commit(f.root, 'tracked routing source before opt-in');
  // Opt in afterwards: regenerate the ignored routing and commit only the
  // .gitignore entries, leaving the tracked source stale.
  const config = join(f.root, '.agents/memory/config.toml');
  writeText(
    config,
    readFileSync(config, 'utf8') + '[connection]\nclients = ["claude"]\n',
  );
  const data = (mem.config_data as CallableFunction)(
    (mem.parse_routing as CallableFunction)(
      readFileSync(config, 'utf8'),
      'test routing',
    ),
  );
  writeText(
    join(f.root, '.agents/memory/config.md'),
    (mem.policy as CallableFunction)(data),
  );
  const ignore = join(f.root, '.gitignore');
  writeText(ignore, readFileSync(ignore, 'utf8') + '/.mcp.json\n');
  runGit(f.root, ['add', '.gitignore']);
  commit(f.root, 'connection ignores; routing source stale');
  const env = {
    ...process.env,
    GIT_ALLOW_PROTOCOL: 'file',
  };
  const worktree = join(f.tmp, 'optin-worktree');
  const add = spawnSync(
    'git',
    ['-C', f.root, 'worktree', 'add', '-b', 'optin', worktree, 'HEAD'],
    { encoding: 'utf8', env },
  );
  assert.equal(statusOf(add), 0, add.stderr);
  const result = spawnSync(
    process.execPath,
    [join(worktree, BOOTSTRAP_MJS_NAME)],
    { cwd: worktree, encoding: 'utf8', env },
  );
  assert.equal(statusOf(result), 0, result.stderr);
  const marker = (conn.CONNECTION_MARKER as RegExp).exec(
    readFileSync(join(worktree, '.agents/memory/config.md'), 'utf8'),
  );
  assert.equal(marker, null);
  const profile = join(f.tmp, 'profile.toml');
  writeText(
    profile,
    'schema_version = 1\nendpoint = "https://memory.example/mcp"\n',
  );
  const home = join(f.tmp, 'home');
  mkdirSync(home);
  await rejectsRegex(
    async () =>
      (mem.run_connections as CallableFunction)(worktree, {
        profile,
        home,
      }),
    /reconcile[\s\S]*reconcile-routing-source/,
  );
  await readiness.reconcile_routing_source(f.root);
  runGit(f.root, ['add', '-A']);
  commit(f.root, 'reconcile routing source with opt-in');
  const fixed = join(f.tmp, 'fixed');
  const addFixed = spawnSync(
    'git',
    ['-C', f.root, 'worktree', 'add', '-b', 'optin-fixed', fixed, 'HEAD'],
    { encoding: 'utf8', env },
  );
  assert.equal(statusOf(addFixed), 0, addFixed.stderr);
  const result2 = spawnSync(
    process.execPath,
    [join(fixed, BOOTSTRAP_MJS_NAME)],
    { cwd: fixed, encoding: 'utf8', env },
  );
  assert.equal(statusOf(result2), 0, result2.stderr);
  assert.notEqual(
    (conn.CONNECTION_MARKER as RegExp).exec(
      readFileSync(join(fixed, '.agents/memory/config.md'), 'utf8'),
    ),
    null,
  );
  const outcome = (mem.run_connections as CallableFunction)(fixed, {
    profile,
    home,
  }) as Record<string, unknown>;
  assert.deepEqual(outcome['rendered'], ['claude']);
  const outcomeCheck = (mem.run_connections as CallableFunction)(fixed, {
    check: true,
    profile,
    home,
  }) as Record<string, unknown>;
  assert.deepEqual(outcomeCheck['clients'], ['claude']);
});

test('test_end_to_end_drift_repair_then_fresh_worktree_bootstrap', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const generated = await enableGeneratedMemory(f, '.agents/memory.toml');
  await assert.rejects(() => readiness.routing_source_status(f.root));
  await readiness.reconcile_routing_source(f.root);
  await readiness.configure(f.root);
  runGit(f.root, ['add', '-A']);
  commit(f.root, 'reconcile tracked routing source');
  const env = {
    ...process.env,
    GIT_ALLOW_PROTOCOL: 'file',
  };
  const worktree = join(f.tmp, 'fresh-worktree');
  const add = spawnSync(
    'git',
    ['-C', f.root, 'worktree', 'add', '-b', 'fresh', worktree, 'HEAD'],
    { encoding: 'utf8', env },
  );
  assert.equal(statusOf(add), 0, add.stderr);
  assert.equal(
    existsSync(join(worktree, '.agents/memory/config.md')),
    false,
  );
  const result = spawnSync(
    process.execPath,
    [join(worktree, BOOTSTRAP_MJS_NAME)],
    { cwd: worktree, encoding: 'utf8', env },
  );
  assert.equal(statusOf(result), 0, result.stderr);
  assert.deepEqual(
    readFileSync(join(worktree, '.agents/memory/config.md')),
    Buffer.from(generated, 'utf8'),
  );
});

test('composed readiness action restores a no-auth Antigravity registration in a fresh worktree', async (t) => {
  const f = await makeFixture({ dispatcher: true });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await enableGeneratedMemory(f, RELOCATED, true, ['claude']);
  const ignore = join(f.root, '.gitignore');
  writeText(ignore, readFileSync(ignore, 'utf8') + '/.mcp.json\n/.agents/mcp_config.json\n');

  const manifest = JSON.parse(readFileSync(
    join(REPO, 'tests/fixtures/mcp-requirements/basic-memory.json'), 'utf8',
  ));
  manifest.services[0].guidance = ['AGENTS.md'];
  writeText(join(f.root, '.agents/mcp-requirements.json'), JSON.stringify(manifest));
  writeText(join(f.root, '.agents/antigravity-mcp.json'), JSON.stringify({
    version: 1,
    services: {
      'basic-memory': {
        registration: 'basic_memory',
        source: { client: 'claude', registration: 'basic_memory' },
      },
    },
  }));
  const cli = 'node .agent-workflows/bin/agent-workflows.ts';
  const actionPath = join(f.root, 't3.json');
  const data = JSON.parse(readFileSync(actionPath, 'utf8'));
  data.scripts[0].command +=
    ` && ${cli} setup_memory_connections --project .` +
    ` && ${cli} setup_antigravity_mcp --project .`;
  writeText(actionPath, JSON.stringify(data, null, 2) + '\n');
  await readiness.check_action(f.root);
  runGit(f.root, ['add', '-A']);
  commit(f.root, 'tracked opt-in and composed action');

  const endpoint = 'https://memory.example.test/mcp';
  const home = join(f.tmp, 'home');
  const configHome = join(home, '.config');
  writeText(
    join(configHome, 'agent-workflows/memory-connection.toml'),
    `schema_version = 1\nendpoint = "${endpoint}"\n`,
  );
  const worktree = join(f.tmp, 'antigravity-worktree');
  runGit(f.root, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  const target = join(worktree, '.agents/mcp_config.json');
  assert.equal(existsSync(target), false);
  const run = spawnSync('sh', ['-c', data.scripts[0].command], {
    cwd: worktree,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: configHome, GIT_ALLOW_PROTOCOL: 'file' },
  });
  assert.equal(statusOf(run), 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
    mcpServers: { basic_memory: { serverUrl: endpoint } },
  });
  assert.equal(existsSync(join(f.root, '.agents/mcp_config.json')), false);
});

// --- Cross-port migration coverage (issue #117; no Python counterpart) ----

/**
 * TypeScript readiness against a pin that carries only the `.py` helpers:
 * the helper check reports the needed migration — exit 1, no traceback.
 */
test('test_readiness_reports_python_only_helper_pin', async (t) => {
  const f = await makeFixture({ pinMode: 'python-only' });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const result = runCli(['--project', f.root, '--check']);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Pinned install\.py needs migration to install\.ts/,
  );
  assert.doesNotMatch(result.stderr, /at |Error:/);
});

/**
 * A `.ts`-carrying pin with a Python-era `.agent-workflows-t3.py` on
 * disk: the old file is reported as needing migration, never as broken,
 * customized or corrupt — and `--check` does not write it away.
 */
test('test_old_bootstrap_reports_migration', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  unlinkSync(join(f.root, BOOTSTRAP_MJS_NAME));
  writeText(
    join(f.root, BOOTSTRAP_PY),
    '# python-era bootstrap stub\n',
  );
  const result = runCli(['--project', f.root, '--check']);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Generated bootstrap \.agent-workflows-t3\.py needs migration to \.agent-workflows-t3\.mjs/,
  );
  assert.equal(existsSync(join(f.root, BOOTSTRAP_PY)), true);
  assert.equal(existsSync(join(f.root, BOOTSTRAP_MJS_NAME)), false);
});

/**
 * `--configure-action` writes the `.mjs` and the `node` action command
 * while leaving the `.py` in place; the check then passes.
 */
test('test_configure_writes_mjs_and_migrates_action', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  // Restore the Python-era state: `.py` launcher and `python3` command.
  unlinkSync(join(f.root, BOOTSTRAP_MJS_NAME));
  writeText(
    join(f.root, BOOTSTRAP_PY),
    '# python-era bootstrap stub\n',
  );
  const t3path = join(f.root, 't3.json');
  const t3data = JSON.parse(readFileSync(t3path, 'utf8')) as {
    scripts: { command: string }[];
  };
  t3data.scripts[0].command = 'python3 .agent-workflows-t3.py';
  writeText(t3path, JSON.stringify(t3data, null, 2) + '\n');
  await readiness.configure(f.root);
  assert.equal(existsSync(join(f.root, BOOTSTRAP_PY)), true);
  assert.deepEqual(
    readFileSync(join(f.root, BOOTSTRAP_MJS_NAME)),
    readFileSync(join(f.library, 'scripts/t3_bootstrap.mjs')),
  );
  const t3 = JSON.parse(readFileSync(join(f.root, 't3.json'), 'utf8')) as {
    scripts: { command: string }[];
  };
  assert.equal(t3.scripts[0].command, 'node .agent-workflows-t3.mjs');
  const result = runCli(['--project', f.root, '--check']);
  assert.equal(result.status, 0, result.stderr);
});

/**
 * The generated `.mjs` runs on Node: delegated bootstrap checks report
 * through `main`, like `node .agent-workflows-t3.mjs --check`.
 */
test('test_generated_mjs_runs_under_node', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await readiness.configure(f.root);
  const result = spawnSync(
    process.execPath,
    [join(f.root, BOOTSTRAP_MJS_NAME), '--check'],
    {
      cwd: f.root,
      encoding: 'utf8',
      env: { ...process.env },
    },
  );
  assert.equal(statusOf(result), 0, result.stderr);
  assert.match(
    result.stdout ?? '',
    /Pinned library bootstrap prerequisites are ready/,
  );
});

/**
 * The recorded action `node .agent-workflows-t3.mjs` runs with no
 * transition flag in the environment: the generated launcher is the
 * Node bootstrap by default and delegates to the pin's TypeScript
 * helper.
 */
test('test_generated_mjs_runs_without_flag', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  await readiness.configure(f.root);
  const env = { ...process.env };
  delete env.AW_T3_BOOTSTRAP;
  const result = spawnSync(
    process.execPath,
    [join(f.root, BOOTSTRAP_MJS_NAME)],
    { cwd: f.root, encoding: 'utf8', env },
  );
  assert.equal(statusOf(result), 0, result.stderr);
  assert.match(
    result.stdout ?? '',
    /Pinned library prepared the T3 checkout/,
  );
  const t3 = JSON.parse(readFileSync(join(f.root, 't3.json'), 'utf8')) as {
    scripts: { command: string }[];
  };
  assert.equal(t3.scripts[0].command, 'node .agent-workflows-t3.mjs');
});

/**
 * A pin missing both `memory_connections` files reports the missing
 * helper through `main` — exit 1 with the `safe_path` message, never an
 * `ERR_MODULE_NOT_FOUND` crash or a Node stack.
 */
test('test_check_routing_source_reports_missing_memory_connections', async (t) => {
  const f = await makeFixture({
    omitPin: ['memory_connections.ts', 'memory_connections.py'],
  });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  enableMemory(f);
  const result = runCli([
    '--project',
    f.root,
    '--check-routing-source',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing path: .*memory_connections\.py/);
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|at |Error:/);
});

/**
 * A pin carrying only `memory_connections.py` reports the needed
 * migration on the same path — one line, exit 1, no traceback.
 */
test('test_check_routing_source_reports_python_only_memory_connections', async (t) => {
  const f = await makeFixture({
    omitPin: ['memory_connections.ts'],
    stubPin: ['memory_connections.py'],
  });
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  enableMemory(f);
  const result = runCli([
    '--project',
    f.root,
    '--check-routing-source',
  ]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Pinned memory_connections\.py needs migration to memory_connections\.ts/,
  );
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|at |Error:/);
});

// --- Retired action identifier migration (issue #1; no Python counterpart) ---

const RETIRED_ID = 'agent-workflows-checkout-readiness';

/**
 * The generated action's identifier is the exported constant and
 * satisfies T3's 24-character script-ID rule.
 */
test('test_action_id_satisfies_t3_script_id_rule', () => {
  const generated = readiness.action();
  assert.equal(dictGet(generated, 'id'), readiness.ACTION_ID);
  assert.equal(readiness.valid_action_id(dictGet(generated, 'id')), true);
});

/** Boundary outcomes of T3's script-ID rule, pinned character for character. */
test('test_valid_action_id_boundaries', () => {
  for (const value of ['a', '0', 'a-b', 'a--b', 'ab-', 'a'.repeat(24)]) {
    assert.equal(
      readiness.valid_action_id(value),
      true,
      `expected valid: ${value}`,
    );
  }
  for (const value of [
    '',
    'a'.repeat(25),
    'A',
    'a_b',
    '-a',
    'a b',
    'a.b',
    null,
    7,
  ]) {
    assert.equal(
      readiness.valid_action_id(value),
      false,
      `expected invalid: ${String(value)}`,
    );
  }
});

/** The generation-time assertion names the offending value. */
test('test_assert_valid_action_id', () => {
  readiness.assert_valid_action_id(readiness.ACTION_ID);
  let thrown: unknown;
  try {
    readiness.assert_valid_action_id(RETIRED_ID);
  } catch (error) {
    thrown = error;
  }
  assertValueError(thrown);
  assert.match(
    (thrown as Error).message,
    /Script IDs must be 1-24 lowercase letters/,
  );
  assert.match((thrown as Error).message, /agent-workflows-checkout-readiness/);
  assert.match((thrown as Error).message, /34 characters/);
  thrown = undefined;
  try {
    readiness.assert_valid_action_id(null);
  } catch (error) {
    thrown = error;
  }
  assertValueError(thrown);
});

/**
 * A t3.json carrying the retired identifier: `--check` reports the
 * generated-asset diagnostic, `--configure-action` rewrites only the
 * `id` in place, a rerun leaves the bytes unchanged and `--check`
 * then passes.
 */
test('test_retired_id_plain_action_is_migrated_in_place', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts: Record<string, unknown>[];
  } & Record<string, unknown>;
  data.scripts[0].id = RETIRED_ID;
  const original = { ...data.scripts[0] };
  data.unrelated = { keep: true };
  data.scripts.push({ id: 'manual', name: 'Manual', command: 'true' });
  writeText(path, JSON.stringify(data, null, 2) + '\n');
  await rejectsRegex(
    () => readiness.check_action(f.root),
    /Generated asset missing: t3\.json; run --configure-action/,
  );
  await readiness.configure(f.root);
  const migrated = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts: Record<string, unknown>[];
    unrelated: { keep: boolean };
  };
  assert.equal(migrated.scripts[0].id, readiness.ACTION_ID);
  assert.equal(
    migrated.scripts[0].command,
    'node .agent-workflows-t3.mjs',
  );
  assert.equal(migrated.unrelated.keep, true);
  assert.equal(migrated.scripts.length, 2);
  assert.equal(migrated.scripts[1].id, 'manual');
  // Only the id changed: every other field survives the rewrite.
  assert.deepEqual(migrated.scripts[0], {
    ...original,
    id: readiness.ACTION_ID,
  });
  const before = readFileSync(path);
  await readiness.configure(f.root);
  assert.deepEqual(readFileSync(path), before);
  await readiness.check_action(f.root);
});

/**
 * A retired identifier on the valid composed form: the command's bytes
 * are preserved exactly and only the `id` is rewritten.
 */
test('test_retired_id_composed_action_rewrites_only_the_id', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts: { id: string; command: string }[];
  };
  data.scripts[0].id = RETIRED_ID;
  data.scripts[0].command +=
    ' && node .agent-workflows/bin/agent-workflows.ts' +
    ' setup_memory_connections --project .';
  const original = { ...data.scripts[0] };
  writeText(path, JSON.stringify(data, null, 2) + '\n');
  await readiness.configure(f.root);
  const migrated = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts: { id: string; command: string }[];
  };
  assert.equal(migrated.scripts[0].id, readiness.ACTION_ID);
  assert.equal(migrated.scripts[0].command, original.command);
  // Only the id changed: the composed command and every other field
  // survive byte-for-byte.
  assert.deepEqual(migrated.scripts[0], {
    ...original,
    id: readiness.ACTION_ID,
  });
  await readiness.check_action(f.root);
});

/**
 * A retired identifier on a Python-era action: one `--configure-action`
 * pass rewrites both the launcher command and the `id`.
 */
test('test_retired_id_python_era_action_migrates_command_and_id', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  const data = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts: { id: string; command: string }[];
  };
  data.scripts[0].id = RETIRED_ID;
  data.scripts[0].command = `python3 ${BOOTSTRAP_PY}`;
  writeText(path, JSON.stringify(data, null, 2) + '\n');
  await readiness.configure(f.root);
  const migrated = JSON.parse(readFileSync(path, 'utf8')) as {
    scripts: { id: string; command: string }[];
  };
  assert.equal(migrated.scripts[0].id, readiness.ACTION_ID);
  assert.equal(
    migrated.scripts[0].command,
    'node .agent-workflows-t3.mjs',
  );
  await readiness.check_action(f.root);
});

/** A retired identifier does not unlock customized managed entries. */
test('test_retired_id_customized_action_is_refused', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  const customized = dictSpread(
    dictSpread(readiness.action(), 'id', RETIRED_ID),
    'runOnWorktreeCreate',
    false,
  );
  writeText(
    path,
    jsonDumpsDefault(new Map<string, unknown>([['scripts', [customized]]])),
  );
  const before = readFileSync(path);
  await rejectsRegex(() => readiness.configure(f.root), /conflicts/);
  assert.deepEqual(readFileSync(path), before);
});

/** Retired and current identifiers on two entries stay a conflict. */
test('test_retired_and_current_id_entries_conflict', async (t) => {
  const f = await makeFixture();
  t.after(() => rmSync(f.tmp, { recursive: true, force: true }));
  const path = join(f.root, 't3.json');
  const retired = dictSpread(readiness.action(), 'id', RETIRED_ID);
  writeText(
    path,
    jsonDumpsDefault(
      new Map<string, unknown>([
        ['scripts', [retired, readiness.action()]],
      ]),
    ),
  );
  const before = readFileSync(path);
  await rejectsRegex(() => readiness.configure(f.root), /conflicts/);
  assert.deepEqual(readFileSync(path), before);
});

/** `python_era_action`/`legacy_id_action` classification outcomes. */
test('test_managed_action_classification', () => {
  const expected = readiness.action();
  const retired = dictSpread(expected, 'id', RETIRED_ID);
  const pythonEra = dictSpread(retired, 'command', `python3 ${BOOTSTRAP_PY}`);
  const composed = dictSpread(
    retired,
    'command',
    'node .agent-workflows-t3.mjs &&' +
      ' node .agent-workflows/bin/agent-workflows.ts' +
      ' setup_memory_connections --project .',
  );
  const unrelated = new Map<string, unknown>([
    ['id', 'custom-readiness'],
    ['name', 'Custom readiness'],
    ['command', `python3 ${BOOTSTRAP_PY}`],
  ]);
  assert.equal(readiness.python_era_action(pythonEra), true);
  assert.equal(readiness.legacy_id_action(pythonEra), false);
  assert.equal(readiness.python_era_action(retired), false);
  assert.equal(readiness.legacy_id_action(retired), true);
  assert.equal(readiness.legacy_id_action(composed), true);
  assert.equal(readiness.python_era_action(expected), false);
  assert.equal(readiness.legacy_id_action(expected), false);
  assert.equal(readiness.python_era_action(unrelated), false);
  assert.equal(readiness.legacy_id_action(unrelated), false);
});

