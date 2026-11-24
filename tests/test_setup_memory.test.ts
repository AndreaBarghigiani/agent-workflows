/**
 * `node:test` counterpart of `tests/test_setup_memory.py` (issue #114),
 * plus the three `tests/test_memory_connections.py` methods that assert
 * `setup_memory` behaviour and were deferred to this issue:
 *
 * - `test_optin_upgrade_of_existing_routing_is_stale_not_customized`
 * - `test_stale_or_customized_instructions_block_worktree_render`
 * - `test_unknown_and_duplicate_clients_are_rejected`
 *
 * Test names keep the Python method names so the mapping in
 * docs/node-port.md stays one-to-one.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ValueError } from '../scripts/lib/pyerrors.ts';
import * as installer from '../scripts/install.ts';
import * as setup from '../scripts/setup_memory.ts';
import * as connections from '../scripts/memory_connections.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP_SCRIPT = join(ROOT, 'scripts/setup_memory.ts');
const CONNECTIONS_SCRIPT = join(
  ROOT,
  'scripts/setup_memory_connections.ts',
);

// The checked-in v2 fixtures pin the older recommended name, so CONFIG keeps
// it; `basic_memory` and custom names are covered explicitly in the tests.
const CONFIG = `schema_version = 2
[project]
id = "pilot"
[memory]
write_project = "pilot"
search_projects = ["pilot", "shared-engineering"]
related_projects = ["other-project"]
mcp_server = "basic_memory_nas"
`;

// The connections suite config (`tests/test_memory_connections.py`) names the
// plain `basic_memory` server; the deferred tests use it verbatim.
const CONN_CONFIG = `schema_version = 2
[project]
id = "pilot"
[memory]
write_project = "pilot"
search_projects = ["pilot", "shared-engineering"]
related_projects = ["other-project"]
mcp_server = "basic_memory"
`;
const CONNECTIONS =
  '[connection]\nclients = ["claude", "codex", "opencode"]\n';
const ENDPOINT = 'https://memory.tailnet.example/mcp';
const ENV_NAME = 'BASIC_MEMORY_API_TOKEN';
const PROFILE = `schema_version = 1
endpoint = "${ENDPOINT}"
bearer_token_env = "${ENV_NAME}"
`;

// -- Python-builtin mirrors used by the fixtures -----------------------------

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function isSym(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function unlinkMissing(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // missing_ok=True
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
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

function throwsRegex(fn: () => void, pattern?: RegExp): Error {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(
    thrown instanceof ValueError,
    `expected ValueError, got ${String(thrown)}`,
  );
  if (pattern !== undefined) assert.match(thrown.message, pattern);
  return thrown;
}

/**
 * `Path.rglob('*')` filtered to `p.is_file()` — real files and links that
 * resolve to files (their bytes, like `read_bytes()`), never directories
 * or dangling links. `.git` parts and the capabilities file are skipped,
 * mirroring the Python suite's snapshot().
 */
function snapshot(root: string): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const rel = relative(root, path).split('/').join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        try {
          if (statSync(path).isFile()) entries.set(rel, readFileSync(path));
        } catch {
          // Dangling links are not files; rglob yields them but
          // `p.is_file()` is false.
        }
        continue;
      }
      if (stat.isDirectory()) {
        if (name === '.git') continue;
        walk(path);
        continue;
      }
      if (name === installer.CAPABILITIES_FILE) continue;
      entries.set(rel, readFileSync(path));
    }
  };
  walk(root);
  return entries;
}

function treeEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, bytes] of a) {
    if (!b.get(key)?.equals(bytes)) return false;
  }
  return true;
}

function assertTreeEqual(
  a: Map<string, Buffer>,
  b: Map<string, Buffer>,
): void {
  assert.ok(
    treeEqual(a, b),
    `trees differ: ${[...a.keys()].sort().join(',')} vs` +
      ` ${[...b.keys()].sort().join(',')}`,
  );
}

class EnvPatch {
  private saved = new Map<string, string | undefined>();
  set(vars: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(vars)) {
      if (!this.saved.has(name)) this.saved.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  restore(): void {
    for (const [name, value] of this.saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    this.saved.clear();
  }
}

/**
 * A disposable consumer checkout mirroring the Python `setUp`: a real git
 * repository, `.agent-workflows` holding a copy of the library skills tree
 * plus `docs/worktrees.md`, and the fake HOME machinery the connection
 * tests use (`XDG_CONFIG_HOME`, `CODEX_HOME`, `OPENCODE_ETC`).
 */
class Consumer {
  temp: string;
  root: string;
  source: string;
  home: string;
  xdg: string;
  codexHome: string;
  profile: string;
  private env = new EnvPatch();

  constructor(cleanup: (fn: () => void) => void) {
    this.temp = mkdtempSync(join(tmpdir(), 'setup-memory-'));
    this.root = join(this.temp, 'consumer');
    mkdirSync(this.root, { recursive: true });
    execFileSync('git', ['init', '-q', this.root]);
    writeText(join(this.root, 'AGENTS.md'), '# Consumer\nKeep project rules.\n');
    writeText(join(this.root, '.gitignore'), 'existing-ignore\n');
    this.source = join(this.root, '.agent-workflows');
    cpSync(join(ROOT, '.agents/skills'), join(this.source, '.agents/skills'), {
      recursive: true,
    });
    mkdirSync(join(this.source, 'docs'), { recursive: true });
    cpSync(
      join(ROOT, 'docs/worktrees.md'),
      join(this.source, 'docs/worktrees.md'),
    );
    installer.write_capabilities(this.root, 'enabled');
    // The machine profile and home-folder client configuration live in a
    // fake HOME so tests never touch real client configuration.
    this.home = join(this.temp, 'home');
    this.xdg = join(this.home, '.config');
    this.codexHome = join(this.home, '.codex');
    this.profile = join(this.xdg, 'agent-workflows/memory-connection.toml');
    this.env.set({
      XDG_CONFIG_HOME: this.xdg,
      CODEX_HOME: this.codexHome,
    });
    connections.setOpencodeEtcForTesting(join(this.temp, 'etc-opencode'));
    cleanup(() => {
      connections.setOpencodeEtcForTesting('/etc/opencode');
      this.env.restore();
      rmSync(this.temp, { recursive: true, force: true });
    });
  }

  writeProfile(content = PROFILE): string {
    writeText(this.profile, content);
    return this.profile;
  }

  trust(): void {
    writeText(
      join(this.codexHome, 'config.toml'),
      `[projects."${this.root}"]\ntrust_level = "trusted"\n`,
    );
  }
}

function withConsumer(
  fn: (consumer: Consumer) => void | Promise<void>,
): () => Promise<void> {
  return async () => {
    const cleanups: (() => void)[] = [];
    const consumer = new Consumer((fn) => cleanups.push(fn));
    try {
      await fn(consumer);
    } finally {
      for (const cleanup of cleanups.reverse()) cleanup();
    }
  };
}

interface ApplyOptions extends setup.SetupOptions {
  choice?: 'enabled' | 'declined' | 'keep' | null;
}

function apply(
  consumer: Consumer,
  options: ApplyOptions = {},
): Record<string, unknown> {
  const { choice = 'enabled', ...setupOptions } = options;
  if (choice === 'keep') {
    // Leave the recorded choice alone.
  } else if (choice) {
    installer.write_capabilities(consumer.root, choice);
  } else {
    unlinkMissing(join(consumer.root, installer.CAPABILITIES_FILE));
  }
  return captureStdout(() =>
    setup.setup(consumer.source, consumer.root, {
      home: consumer.home,
      ...setupOptions,
    }),
  ) as Record<string, unknown>;
}

function runConn(
  consumer: Consumer,
  check = false,
): Record<string, unknown> {
  return captureStdout(() =>
    setup.run_connections(consumer.root, {
      check,
      profile: consumer.profile,
      home: consumer.home,
    }),
  );
}

function enable(
  consumer: Consumer,
  clients: string[] = ['claude', 'codex', 'opencode'],
): void {
  const selected =
    '[connection]\nclients = [' +
    clients.map((client) => `"${client}"`).join(', ') +
    ']\n';
  consumer.writeProfile();
  if (clients.includes('codex')) consumer.trust();
  apply(consumer, { portable: CONN_CONFIG + selected });
}

// --- SetupTests -------------------------------------------------------------

test('test_claude_memory_setup_upgrade_and_check', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  assert.ok(!existsSync(join(c.root, '.claude')));
  const claude = join(c.root, 'CLAUDE.md');
  writeText(claude, '# Consumer Claude notes\n');
  apply(c, { claude_skills: true });
  assert.equal(readText(claude), '# Consumer Claude notes\n@AGENTS.md\n');
  let link = '';
  for (const name of setup.DEFAULT_SKILLS) {
    link = join(c.root, '.claude/skills', name);
    assert.ok(isSym(link));
    assert.equal(
      realpathSync(link),
      realpathSync(join(c.source, '.agents/skills', name)),
    );
    assert.ok(!isAbsolute(readlinkSync(link)));
  }
  const original = snapshot(c.root);
  apply(c, { claude_skills: true });
  apply(c, { claude_skills: true, check: true });
  assertTreeEqual(snapshot(c.root), original);
  unlinkSync(link);
  throwsRegex(() => apply(c, { claude_skills: true, check: true }));
}));

test('test_claude_memory_conflict_preflights_routing_writes', withConsumer((c) => {
  const claude = join(c.root, 'CLAUDE.md');
  const external = join(c.temp, 'shared-claude.md');
  writeText(external, '# Shared instructions\n');
  symlinkSync(external, claude);
  const conflict = join(c.root, '.claude/skills/setup-basic-memory');
  mkdirSync(conflict, { recursive: true });
  writeText(join(conflict, 'SKILL.md'), 'local memory instructions');
  throwsRegex(() => apply(c, { portable: CONFIG, claude_skills: true }));
  assert.ok(!existsSync(join(c.root, '.agents/memory/config.toml')));
  assert.ok(!existsSync(join(c.root, '.agents/skills/setup-basic-memory')));
  assert.equal(
    readText(join(conflict, 'SKILL.md')),
    'local memory instructions',
  );
  assert.ok(isSym(claude));
}));

test('test_invalid_routing_names_artifact_and_requires_reviewed_input', withConsumer((c) => {
  const target = join(c.root, '.agents/memory/config.toml');
  const legacy =
    'schema_version = 1\n[project]\nname = "pilot"\n' +
    '[memory]\nwrite_project = "pilot"\n';
  writeText(target, legacy);
  const before = snapshot(c.root);
  let caught = throwsRegex(() => apply(c));
  assert.match(caught.message, /Invalid routing in \.agents\/memory\/config\.toml/);
  assert.match(caught.message, /schema_version=2/);
  assert.match(caught.message, /reviewed migration input/);
  assert.match(caught.message, /MCP connectivity/);
  assertTreeEqual(snapshot(c.root), before);
  caught = throwsRegex(() => apply(c, { portable: legacy }));
  assert.match(caught.message, /Invalid routing in \.agents\/memory\/config\.toml/);
}));

test('test_malformed_routing_comparison_names_origin', withConsumer((c) => {
  const target = join(c.root, '.agents/memory/config.toml');
  writeText(join(c.root, 'reviewed.toml'), CONFIG);
  writeText(target, 'schema_version = [\n');
  let caught = throwsRegex(() => apply(c, { portable: CONFIG }));
  assert.match(caught.message, /Invalid routing in \.agents\/memory\/config\.toml/);
  assert.match(caught.message, /reviewed migration input/);
  assert.match(caught.message, /MCP connectivity/);
  assert.equal(readText(target), 'schema_version = [\n');
  writeText(target, CONFIG);
  caught = throwsRegex(() => apply(c, { portable: 'schema_version = [\n' }));
  assert.match(caught.message, /Invalid routing in the supplied --portable input/);
  assert.match(caught.message, /reviewed migration input/);
  assert.equal(readText(target), CONFIG);
}));

test('test_native_setup_is_local_idempotent_and_does_not_stage', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  const original = snapshot(c.root);
  apply(c);
  apply(c, { check: true });
  assertTreeEqual(snapshot(c.root), original);
  assert.equal(
    readText(join(c.root, '.agents/memory/config.toml')),
    CONFIG,
  );
  const generated = readText(join(c.root, '.agents/memory/config.md'));
  assert.match(generated, /inspect the deployed tool schemas/);
  for (const retired of installer.RETIRED_MEMORY_SKILLS) {
    assert.ok(!generated.includes(retired));
    assert.ok(!existsSync(join(c.root, '.agents/skills', retired)));
  }
  const agents = readText(join(c.root, 'AGENTS.md'));
  assert.equal(agents.split(setup.START).length - 1, 1);
  assert.ok(!agents.includes('agent-workflows:worktrees'));
  for (const name of setup.DEFAULT_SKILLS) {
    assert.ok(isSym(join(c.root, '.agents/skills', name)));
  }
  const ignored = spawnSync(
    'git',
    ['-C', c.root, 'check-ignore', '.agents/memory/config.toml'],
    { encoding: 'utf8' },
  );
  assert.equal(ignored.status, 0);
  assert.ok(!existsSync(join(c.root, '.codex/hooks.json')));
  assert.ok(!existsSync(join(c.root, '.agents/memory-pending')));
  assert.ok(!existsSync(join(c.root, '.agents/skills/workflow-memory')));
  const staged = git(c.root, ['diff', '--cached', '--name-only']);
  assert.equal(staged, '');
}));

test('test_user_can_choose_shareable_config_without_staging', withConsumer((c) => {
  apply(c, { portable: CONFIG, share_config: true });
  apply(c, { check: true, share_config: true });
  assert.equal(readText(join(c.root, '.gitignore')), 'existing-ignore\n');
  apply(c); // Explicitly select local mode later.
  const ignore = readText(join(c.root, '.gitignore'));
  apply(c, { share_config: true });
  assert.equal(readText(join(c.root, '.gitignore')), ignore);
}));

test('test_conflicts_and_legacy_hooks_fail_before_mutation', withConsumer((c) => {
  for (const mode of ['skill', 'hook', 'policy', 'config', 'worktrees']) {
    let target = '';
    if (mode === 'skill') {
      target = join(c.root, '.agents/skills/setup-basic-memory');
      mkdirSync(target, { recursive: true });
      writeText(join(target, 'SKILL.md'), 'local override');
    } else if (mode === 'hook') {
      target = join(c.root, '.codex/hooks.json');
      writeText(target, '{"command":"memory_lifecycle.py capture"}');
    } else if (mode === 'policy') {
      target = join(c.root, 'AGENTS.md');
      writeText(target, setup.START + '\ncustom policy\n' + setup.END);
    } else if (mode === 'config') {
      target = join(c.root, '.agents/memory/config.toml');
      writeText(target, CONFIG.replaceAll('pilot', 'different'));
    } else {
      target = join(c.root, 'AGENTS.md');
      writeText(
        target,
        '<!-- agent-workflows:worktrees:start -->\ncustom\n' +
          '<!-- agent-workflows:worktrees:end -->',
      );
    }
    const before = snapshot(c.root);
    throwsRegex(() => apply(c, { portable: CONFIG }));
    assertTreeEqual(snapshot(c.root), before);
    if (mode === 'skill') rmSync(target, { recursive: true });
    else unlinkSync(target);
    if (mode === 'policy' || mode === 'worktrees') {
      writeText(target, '# Consumer\n');
    }
  }
}));

test('test_memory_setup_migrates_exact_legacy_worktree_policy', withConsumer((c) => {
  const agents = join(c.root, 'AGENTS.md');
  const legacy =
    '<!-- agent-workflows:worktrees:start -->\n## Worktrees\n\n' +
    'Create a worktree only when requested by the user or selected through the harness.\n' +
    'Keep linked worktrees under `<main-checkout-parent>/worktrees/<project>/<task>/`.\n' +
    'Read `.agent-workflows/docs/worktrees.md` before creating, moving or removing a worktree.\n' +
    'After a verified PR merge, remove its task worktree once preservation checks pass;\n' +
    'submodules alone do not prevent cleanup. Preserve existing work and authorization.\n' +
    '<!-- agent-workflows:worktrees:end -->';
  const oldInstall =
    '# Consumer\nKeep this.\n\n' + legacy + '\n\n' + installer.COLLAB_BLOCK + '\n';
  writeText(agents, oldInstall);
  const before = snapshot(c.root);
  unlinkSync(join(c.root, installer.CAPABILITIES_FILE));
  throwsRegex(
    () => apply(c, { choice: null, portable: CONFIG, check: true }),
    /No Basic Memory choice recorded/,
  );
  assertTreeEqual(snapshot(c.root), before);
  installer.write_capabilities(c.root, 'enabled');
  // Missing routing is identified before any legacy migration concern.
  throwsRegex(
    () => apply(c, { choice: 'keep', portable: CONFIG, check: true }),
    /Missing memory routing/,
  );
  assertTreeEqual(snapshot(c.root), before);
  apply(c, { portable: CONFIG });
  const text = readText(agents);
  assert.match(text, /Keep this\./);
  assert.ok(text.includes(installer.COLLAB_BLOCK));
  assert.ok(!text.includes('agent-workflows:worktrees'));
  const after = snapshot(c.root);
  apply(c, { check: true });
  assertTreeEqual(snapshot(c.root), after);
  // A legacy block left behind by a later pin adoption is identified with
  // its markers and the deterministic repair.
  writeText(agents, text + '\n\n' + legacy + '\n');
  const preserved = snapshot(c.root);
  throwsRegex(
    () => apply(c, { choice: 'keep', check: true }),
    /Stale managed block in .*AGENTS\.md.*requires migration.*install --project \./,
  );
  assertTreeEqual(snapshot(c.root), preserved);
}));

test('test_check_identifies_each_missing_memory_artifact', withConsumer((c) => {
  // Missing routing requires reviewed input, never an invented one.
  let before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true }),
    /Missing \.agents\/memory\/config\.toml.*--portable <reviewed-config\.toml>.*do not invent routing/,
  );
  assertTreeEqual(snapshot(c.root), before);
  apply(c, { portable: CONFIG });

  // Missing generated instructions get the deterministic repair.
  unlinkSync(join(c.root, '.agents/memory/config.md'));
  before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true }),
    /Missing generated instructions: \.agents\/memory\/config\.md.*setup_memory --project \./,
  );
  assertTreeEqual(snapshot(c.root), before);
  apply(c); // the suggested repair restores the artifact

  // A missing managed policy block names its markers and the repair.
  const agents = join(c.root, 'AGENTS.md');
  const text = readText(agents);
  const start = text.indexOf(setup.START);
  const end = text.indexOf(setup.END) + setup.END.length;
  writeText(agents, text.slice(0, start) + text.slice(end));
  before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true }),
    /Missing memory policy block in AGENTS\.md \(markers `<!-- agent-workflows:memory:start -->`\/`<!-- agent-workflows:memory:end -->`\).*setup_memory --project \./,
  );
  assertTreeEqual(snapshot(c.root), before);
}));

test('test_check_identifies_missing_ignore_entry_and_memory_links', withConsumer((c) => {
  apply(c, { portable: CONFIG, share_config: true });
  let before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true }),
    /Missing ignore entry `\/\.agents\/memory\/` in \.gitignore.*setup_memory --project \..*--share-config/,
  );
  assertTreeEqual(snapshot(c.root), before);
  // A missing skill link names its path and suggests the memory setup
  // command preserving the caller's flags.
  const link = join(c.root, '.agents/skills/setup-basic-memory');
  unlinkSync(link);
  before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true, claude_skills: true, share_config: true }),
    /Missing installation: .*setup-basic-memory.*Repair from the consumer root: `node \.agent-workflows\/bin\/agent-workflows\.ts setup_memory --project \. --claude-skills --share-config`/,
  );
  assertTreeEqual(snapshot(c.root), before);
  assert.ok(!existsSync(link));
}));

test('test_conflicting_memory_link_reports_actual_and_expected', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  const link = join(c.root, '.agents/skills/setup-basic-memory');
  unlinkSync(link);
  symlinkSync(join(c.source, '.agents/skills/shape-issue'), link);
  const before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true }),
    /Conflicting memory skill link: .*setup-basic-memory resolves to .*shape-issue, expected .*setup-basic-memory; retarget it only after a reviewed decision/,
  );
  assertTreeEqual(snapshot(c.root), before);
  assert.equal(
    realpathSync(link),
    realpathSync(join(c.source, '.agents/skills/shape-issue')),
  );
}));

test('test_check_never_installs_and_local_overrides_are_refused', withConsumer((c) => {
  throwsRegex(() => apply(c, { portable: CONFIG, check: true }));
  assert.ok(!existsSync(join(c.root, '.agents/memory')));
  const local = join(c.root, '.agents/skills/setup-basic-memory');
  mkdirSync(local, { recursive: true });
  writeText(join(local, 'SKILL.md'), 'custom');
  const before = snapshot(c.root);
  throwsRegex(() => apply(c, { portable: CONFIG }), /Local skill override/);
  assertTreeEqual(snapshot(c.root), before);
  assert.equal(readText(join(local, 'SKILL.md')), 'custom');
}));

test('test_memory_default_selects_dedicated_skill_and_preserves_old_selections', withConsumer((c) => {
  assert.deepEqual(setup.DEFAULT_SKILLS, installer.MEMORY_SKILLS);
  // A prior workflow selection is outside this helper's write set and
  // remains installed.
  const oldSetup = join(c.root, '.agents/skills/setup-agent-workflows');
  mkdirSync(dirname(oldSetup), { recursive: true });
  symlinkSync(join(c.source, '.agents/skills/setup-agent-workflows'), oldSetup);
  apply(c, { portable: CONFIG });
  assert.ok(isSym(oldSetup));
  assert.ok(isSym(join(c.root, '.agents/skills/setup-basic-memory')));
  apply(c, { check: true });
  assert.ok(isSym(oldSetup));
}));

test('test_unknown_choice_never_enables_memory', withConsumer((c) => {
  const before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { choice: null, portable: CONFIG }),
    /No Basic Memory choice recorded/,
  );
  assertTreeEqual(snapshot(c.root), before);
  assert.ok(!existsSync(join(c.root, '.agents/skills/setup-basic-memory')));
  assert.ok(!existsSync(join(c.root, '.agents/memory')));
  assert.ok(
    !readText(join(c.root, 'AGENTS.md')).includes(setup.START),
  );
}));

test('test_declined_choice_is_never_silently_overridden', withConsumer((c) => {
  installer.write_capabilities(c.root, 'declined');
  const before = snapshot(c.root);
  throwsRegex(() => apply(c, { choice: 'declined', portable: CONFIG }), /declined/);
  throwsRegex(() => apply(c, { choice: 'declined', check: true }), /declined/);
  assertTreeEqual(snapshot(c.root), before);
  assert.ok(!existsSync(join(c.root, '.agents/memory')));
  assert.ok(!existsSync(join(c.root, '.agents/skills/setup-basic-memory')));
  assert.ok(!readText(join(c.root, 'AGENTS.md')).includes(setup.START));
  assert.ok(
    !readText(join(c.root, '.gitignore')).includes('/.agents/memory/'),
  );
}));

test('test_malformed_capabilities_file_is_reported', withConsumer((c) => {
  writeText(
    join(c.root, installer.CAPABILITIES_FILE),
    '{"schema_version": 1, "memory": "maybe"}',
  );
  const before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { choice: 'keep', portable: CONFIG }),
    /preserve and review/,
  );
  assertTreeEqual(snapshot(c.root), before);
}));

test('test_invalid_routing_and_escaping_paths_are_rejected', withConsumer((c) => {
  for (const content of [
    CONFIG.replace('schema_version = 2', 'schema_version = 1'),
    CONFIG.replace('write_project = "pilot"', 'write_project = "other"'),
    CONFIG.replace('other-project', 'shared-engineering'),
    CONFIG + 'file_root = "/example/storage"\n',
    CONFIG.replace('"other-project"', '1'),
  ]) {
    const before = snapshot(c.root);
    throwsRegex(() => apply(c, { portable: content }));
    assertTreeEqual(snapshot(c.root), before);
  }
  const outside = join(c.temp, 'outside');
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(c.root, '.agents'), { recursive: true });
  symlinkSync(outside, join(c.root, '.agents/memory'));
  throwsRegex(() => apply(c, { portable: CONFIG }));
  assert.equal(readdirSync(outside).length, 0);
}));

test('test_workspace_qualified_scopes_are_accepted_and_kept_verbatim', withConsumer((c) => {
  const qualified = CONFIG
    .replace('write_project = "pilot"', 'write_project = "team/pilot"')
    .replace('["pilot", "shared-engineering"]', '["team/pilot", "shared-engineering"]')
    .replace('"other-project"', '"personal/other-project"');
  const result = apply(c, { portable: qualified });
  assert.equal(
    (result['memory'] as Record<string, unknown>)['write_project'],
    'team/pilot',
  );
  assert.equal(
    readText(join(c.root, '.agents/memory/config.toml')),
    qualified,
  );
  const generated = readText(join(c.root, '.agents/memory/config.md'));
  assert.ok(generated.includes('Write project: `team/pilot`.'));
  assert.ok(generated.includes('"personal/other-project"'));
  apply(c, { check: true });
}));

test('test_malformed_qualified_scopes_and_qualified_identity_are_rejected', withConsumer((c) => {
  for (const content of [
    CONFIG.replace('"other-project"', '"a/b/c"'),
    CONFIG.replace('"other-project"', '"/other-project"'),
    CONFIG.replace('"other-project"', '"team/"'),
    CONFIG.replace('"other-project"', '"Team/other-project"'),
    CONFIG.replace('id = "pilot"', 'id = "team/pilot"'),
  ]) {
    throwsRegex(() => apply(c, { portable: content }));
    assert.ok(!existsSync(join(c.root, '.agents/memory/config.toml')));
  }
}));

test('test_consumer_moves_off_vendored_skills_in_one_setup_run', withConsumer((c) => {
  apply(c, { portable: CONFIG, claude_skills: true });
  const instructions = join(c.root, '.agents/memory/config.md');
  const current = readText(instructions);
  // Pinned output of the 0.2.1 generator, not derived from current code.
  const vendored = readText(
    join(ROOT, 'tests/fixtures/native-memory-v2-vendored-config.md'),
  );
  assert.ok(vendored.includes('`memory-capture`'));
  assert.deepEqual(setup.previous_generated(current), [
    vendored,
    readText(join(ROOT, 'tests/fixtures/native-memory-v2-config.md')),
  ]);
  writeText(instructions, vendored);
  const links: string[] = [];
  for (const directory of ['.agents/skills', '.claude/skills']) {
    for (const name of installer.RETIRED_MEMORY_SKILLS) {
      const link = join(c.root, directory, name);
      symlinkSync(join('../../.agent-workflows/.agents/skills', name), link);
      links.push(link);
    }
  }
  const before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true, claude_skills: true }),
    /Stale generated instructions/,
  );
  writeText(instructions, current);
  throwsRegex(
    () => apply(c, { check: true, claude_skills: true }),
    /Retired memory skill link/,
  );
  assert.ok(links.every((link) => isSym(link)));
  writeText(instructions, vendored);
  assertTreeEqual(snapshot(c.root), before);
  apply(c, { claude_skills: true });
  assert.ok(!links.some((link) => isSym(link)));
  assert.equal(readText(instructions), current);
  assert.equal(
    readText(join(c.root, '.agents/memory/config.toml')),
    CONFIG,
  );
  apply(c, { check: true, claude_skills: true });
}));

test('test_upstream_installed_skills_are_not_conflicts', withConsumer((c) => {
  const skills = join(c.root, '.agents/skills');
  const claude = join(c.root, '.claude/skills');
  mkdirSync(claude, { recursive: true });
  for (const name of installer.RETIRED_MEMORY_SKILLS) {
    mkdirSync(join(skills, name), { recursive: true });
    writeText(join(skills, name, 'SKILL.md'), `# upstream ${name}\n`);
    symlinkSync(join('../../.agents/skills', name), join(claude, name));
  }
  apply(c, { portable: CONFIG, claude_skills: true });
  apply(c, { check: true, claude_skills: true });
  for (const name of installer.RETIRED_MEMORY_SKILLS) {
    assert.equal(
      readText(join(skills, name, 'SKILL.md')),
      `# upstream ${name}\n`,
    );
    assert.equal(
      realpathSync(join(claude, name)),
      realpathSync(join(skills, name)),
    );
  }
}));

test('test_subdirectory_root_is_rejected', withConsumer((c) => {
  const child = join(c.root, 'src');
  mkdirSync(child);
  throwsRegex(() => setup.setup(c.source, child, { portable: CONFIG }));
}));

test('test_retired_shared_link_requires_migration_without_mutation', withConsumer((c) => {
  const retired = join(c.root, '.agents/skills/workflow-memory');
  mkdirSync(dirname(retired), { recursive: true });
  symlinkSync(join(c.source, '.agents/skills/workflow-memory'), retired);
  const before = snapshot(c.root);
  throwsRegex(() => apply(c, { portable: CONFIG }), /retired shared/);
  assertTreeEqual(snapshot(c.root), before);
  assert.ok(isSym(retired));
  unlinkSync(retired);
  apply(c, { portable: CONFIG });
  assert.ok(!isSym(retired));
}));

test('test_retired_skill_selection_is_rejected_at_cli_too', withConsumer((c) => {
  const result = spawnSync(
    process.execPath,
    [SETUP_SCRIPT, '--project', c.root, '--skills', 'workflow-memory'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /--skills was removed/);
  assert.ok(!existsSync(join(c.root, '.agents/memory')));
}));

test('test_connections_cli_requires_worktree_root', withConsumer((c) => {
  // The standalone CLI's git gate is stricter than setup()'s: a
  // subdirectory of a worktree and a directory outside Git both refuse
  // before any connection handling.
  const child = join(c.root, 'src');
  mkdirSync(child);
  const plain = join(c.temp, 'plain');
  mkdirSync(plain);
  for (const project of [child, plain]) {
    const result = spawnSync(
      process.execPath,
      [CONNECTIONS_SCRIPT, '--project', project],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1, project);
    assert.equal(
      result.stderr,
      'Project must be the active worktree root\n',
    );
    assert.equal(result.stdout, '');
  }
}));

test('test_cli_short_help_tails_print_help', () => {
  for (const script of [SETUP_SCRIPT, CONNECTIONS_SCRIPT]) {
    for (const arg of ['-h', '--help', '-hfoo', '-hh', '-hx']) {
      const result = spawnSync(process.execPath, [script, arg], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `${script} ${arg}`);
      assert.match(result.stdout, /^usage: /);
    }
    // `=`-separated and `-`-leading remainders stay argparse errors.
    for (const arg of ['-h=foo', '-h-x']) {
      const result = spawnSync(process.execPath, [script, arg], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 2, `${script} ${arg}`);
      assert.match(result.stderr, /ignored explicit argument/);
    }
  }
});

test('test_unrelated_edits_and_staging_are_preserved', withConsumer((c) => {
  const unrelated = join(c.root, 'product.txt');
  writeText(unrelated, 'staged product work');
  git(c.root, ['add', 'product.txt']);
  apply(c, { portable: CONFIG });
  const result = git(c.root, ['diff', '--cached', '--name-only']);
  assert.equal(result.trim(), 'product.txt');
  assert.equal(readText(unrelated), 'staged product work');
}));

test('test_previous_v2_instructions_upgrade_without_changing_scopes', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  const instructions = join(c.root, '.agents/memory/config.md');
  const previous = readText(
    join(ROOT, 'tests/fixtures/native-memory-v2-config.md'),
  );
  writeText(instructions, previous);
  const agents = join(c.root, 'AGENTS.md');
  writeText(agents, readText(agents) + '\nKeep local routing prose.\n');
  const before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true }),
    /Stale generated instructions: \.agents\/memory\/config\.md.*setup_memory --project \./,
  );
  assertTreeEqual(snapshot(c.root), before);
  apply(c);
  const after = snapshot(c.root);
  const changed = new Set(
    [...before.keys()].filter((name) => !before.get(name)!.equals(after.get(name)!)),
  );
  for (const name of after.keys()) {
    if (!before.has(name)) changed.add(name);
  }
  assert.deepEqual(changed, new Set(['.agents/memory/config.md']));
  assert.equal(
    readText(join(c.root, '.agents/memory/config.toml')),
    CONFIG,
  );
  assert.notEqual(readText(instructions), previous);
  apply(c);
  apply(c, { check: true });
  assertTreeEqual(snapshot(c.root), after);
}));

test('test_customized_previous_instructions_are_not_upgraded', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  const instructions = join(c.root, '.agents/memory/config.md');
  const previous = readText(
    join(ROOT, 'tests/fixtures/native-memory-v2-config.md'),
  );
  writeText(instructions, previous + '\nConsumer-specific instructions.\n');
  const before = snapshot(c.root);
  for (const check of [false, true]) {
    throwsRegex(
      () => apply(c, { check }),
      /Customized memory instructions/,
    );
    assertTreeEqual(snapshot(c.root), before);
  }
}));

test('test_setup_and_check_accept_any_recorded_server_name', withConsumer((c) => {
  for (const server of ['basic_memory', 'basic_memory_nas', 'team-memory']) {
    const config = CONFIG.replace('basic_memory_nas', server);
    apply(c, { portable: config });
    assert.equal(
      readText(join(c.root, '.agents/memory/config.toml')),
      config,
    );
    const generated = readText(join(c.root, '.agents/memory/config.md'));
    assert.ok(generated.includes(`MCP server \`${server}\``));
    apply(c, { check: true });
    for (const artifact of ['config.toml', 'config.md']) {
      unlinkSync(join(c.root, '.agents/memory', artifact));
    }
  }
}));

test('test_renamed_mcp_server_regenerates_only_the_server_name', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  const instructions = join(c.root, '.agents/memory/config.md');
  const previous = readText(instructions);
  const target = join(c.root, '.agents/memory/config.toml');
  const renamed = CONFIG.replace('basic_memory_nas', 'basic_memory');
  writeText(target, renamed);
  const before = snapshot(c.root);
  // Untouched generated text under the old name is stale, not customized.
  throwsRegex(() => apply(c, { check: true }), /Stale generated instructions/);
  assertTreeEqual(snapshot(c.root), before);
  assert.equal(setup.expected_instructions(c.root)[1], 'stale');
  apply(c);
  const after = snapshot(c.root);
  const changed = new Set(
    [...before.keys()].filter((name) => !before.get(name)!.equals(after.get(name)!)),
  );
  for (const name of after.keys()) {
    if (!before.has(name)) changed.add(name);
  }
  assert.deepEqual(changed, new Set(['.agents/memory/config.md']));
  assert.equal(
    readText(instructions),
    previous.replace('`basic_memory_nas`', '`basic_memory`'),
  );
  assert.equal(readText(target), renamed);
  apply(c, { check: true });
}));

test('test_renamed_mcp_server_preserves_customized_instructions', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  const instructions = join(c.root, '.agents/memory/config.md');
  writeText(instructions, readText(instructions) + 'Local note.\n');
  writeText(
    join(c.root, '.agents/memory/config.toml'),
    CONFIG.replace('basic_memory_nas', 'basic_memory'),
  );
  const before = snapshot(c.root);
  assert.equal(setup.expected_instructions(c.root)[1], 'customized');
  for (const check of [false, true]) {
    throwsRegex(
      () => apply(c, { check }),
      /Customized memory instructions/,
    );
    assertTreeEqual(snapshot(c.root), before);
  }
}));

test('test_instruction_upgrade_waits_for_full_install_preflight', withConsumer((c) => {
  apply(c, { portable: CONFIG });
  const instructions = join(c.root, '.agents/memory/config.md');
  writeText(
    instructions,
    readText(join(ROOT, 'tests/fixtures/native-memory-v2-config.md')),
  );
  const conflict = join(c.root, '.agents/skills/setup-basic-memory');
  unlinkSync(conflict);
  mkdirSync(conflict);
  writeText(join(conflict, 'SKILL.md'), 'Local override');
  const before = snapshot(c.root);
  throwsRegex(() => apply(c), /Local skill override/);
  assertTreeEqual(snapshot(c.root), before);
}));

// --- ConnectionTests methods deferred from #113 --------------------------------
// `tests/test_memory_connections.py` keeps these names; their assertions are
// `setup_memory`/`run_connections` behaviour.

test('test_optin_upgrade_of_existing_routing_is_stale_not_customized', withConsumer((c) => {
  c.writeProfile();
  c.trust();
  apply(c, { portable: CONN_CONFIG });
  writeText(join(c.root, '.agents/memory/config.toml'), CONN_CONFIG + CONNECTIONS);
  throwsRegex(() => apply(c, { check: true }), /Stale generated instructions/);
  apply(c);
  assert.ok(existsSync(join(c.root, '.mcp.json')));
  apply(c, { check: true });
}));

test('test_v050_connection_routing_is_stale_not_customized', withConsumer((c) => {
  enable(c);
  const instructions = join(c.root, '.agents/memory/config.md');
  const current = readText(instructions);
  // The exact text v0.4.0 through v0.5.0 generated: the same paragraph
  // naming the Python helper (#139).
  const python = current.replace(
    '`setup_memory_connections`',
    '`setup_memory_connections.py`',
  );
  assert.notEqual(python, current);
  writeText(instructions, python);
  assert.equal(setup.expected_instructions(c.root)[1], 'stale');
  const before = snapshot(c.root);
  throwsRegex(
    () => apply(c, { check: true }),
    /Stale generated instructions/,
  );
  assertTreeEqual(snapshot(c.root), before);
  apply(c);
  assert.equal(readText(instructions), current);
  const after = snapshot(c.root);
  const changed = new Set(
    [...before.keys()].filter(
      (name) => !before.get(name)!.equals(after.get(name)!),
    ),
  );
  for (const name of after.keys()) {
    if (!before.has(name)) changed.add(name);
  }
  assert.deepEqual(changed, new Set(['.agents/memory/config.md']));
  apply(c, { check: true });
}));

test('test_v050_connection_routing_with_edits_stays_customized', withConsumer((c) => {
  enable(c);
  const instructions = join(c.root, '.agents/memory/config.md');
  const python = readText(instructions).replace(
    '`setup_memory_connections`',
    '`setup_memory_connections.py`',
  );
  writeText(instructions, python + '\nConsumer-specific instructions.\n');
  const before = snapshot(c.root);
  assert.equal(setup.expected_instructions(c.root)[1], 'customized');
  for (const check of [false, true]) {
    throwsRegex(
      () => apply(c, { check }),
      /Customized memory instructions/,
    );
    assertTreeEqual(snapshot(c.root), before);
  }
}));

test('test_stale_or_customized_instructions_block_worktree_render', withConsumer((c) => {
  enable(c);
  const instructions = join(c.root, '.agents/memory/config.md');
  writeText(instructions, readText(instructions) + 'Local note.\n');
  throwsRegex(() => runConn(c), /customized/);
}));

test('test_unknown_and_duplicate_clients_are_rejected', withConsumer((c) => {
  c.writeProfile();
  for (const selection of [
    '[connection]\nclients = ["devin"]\n',
    '[connection]\nclients = ["grok"]\n',
    '[connection]\nclients = ["claude", "claude"]\n',
    '[connection]\nclients = "claude"\n',
    '[connection]\nother = ["claude"]\n',
  ]) {
    throwsRegex(() => apply(c, { portable: CONN_CONFIG + selection }));
    assert.ok(!existsSync(join(c.root, '.mcp.json')));
  }
}));
