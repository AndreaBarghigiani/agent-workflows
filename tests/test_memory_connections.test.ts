/**
 * `node:test` port of `tests/test_memory_connections.py` (issue #113).
 *
 * The Python suite drives `memory_connections` through `setup_memory`'s
 * `setup()`/`run_connections()` orchestration, which issue #114 owns. These
 * counterparts keep every Python test method name and exercise the same
 * `memory_connections` behaviour through a local composition that mirrors
 * how `run_connections` and `setup()` call into this module: routing
 * selection → read_state → connection_profile → plan_connection_files →
 * render/check, plus setup()'s deselection preflight and gitignore
 * management for generated clients. Assertions on artifacts `setup()`
 * alone produces (policy text, capability file, skill links) are not
 * covered here — see docs/node-port.md for the method mapping.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as tomlParse } from '../scripts/vendor/smol-toml/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atomicWrite } from '../scripts/lib/atomic.ts';
import { ValueError } from '../scripts/lib/pyerrors.ts';
import { pyJsonLoads } from '../scripts/lib/pyloads.ts';
import { readText } from '../scripts/lib/pyio.ts';
import * as connections from '../scripts/memory_connections.ts';

const CONFIG = `schema_version = 2
[project]
id = "pilot"
[memory]
write_project = "pilot"
search_projects = ["pilot", "shared-engineering"]
related_projects = ["other-project"]
mcp_server = "basic_memory"
`;
const CONNECTIONS = '[connection]\nclients = ["claude", "codex", "opencode"]\n';
const ENDPOINT = 'https://memory.tailnet.example/mcp';
const ENV_NAME = 'BASIC_MEMORY_API_TOKEN';
const SENTINEL = 's3cr3t-value-never-written';
const PROFILE = `schema_version = 1
endpoint = "${ENDPOINT}"
bearer_token_env = "${ENV_NAME}"
`;
const SERVER_LINE =
  /^Use the native tools of MCP server `([^`\n]+)`\. All machines and clients$/m;

type Dict = Record<string, unknown> | Map<string, unknown>;

function dictGet(mapping: Dict, key: string): unknown {
  return mapping instanceof Map ? mapping.get(key) : mapping[key];
}

function dictHas(mapping: Dict, key: string): boolean {
  return mapping instanceof Map
    ? mapping.has(key)
    : Object.hasOwn(mapping, key);
}

function dictItems(mapping: Dict): [string, unknown][] {
  return mapping instanceof Map
    ? [...mapping.entries()]
    : Object.keys(mapping).map((key) => [key, mapping[key]]);
}

function dictSize(mapping: Dict): number {
  return mapping instanceof Map ? mapping.size : Object.keys(mapping).length;
}

/** Convert parsed values (`Map`-based dicts) into plain objects for asserts. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, member]) => [key, toPlain(member)]),
    );
  }
  if (Array.isArray(value)) return value.map(toPlain);
  return value;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function readJson(path: string): unknown {
  return pyJsonLoads(readText(path));
}

function readToml(path: string): Record<string, unknown> {
  return tomlParse(readText(path), { integersAsBigInt: false }) as Record<
    string,
    unknown
  >;
}

function treeBytes(root: string): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
      if (name === '.git') continue;
      const path = join(directory, name);
      const relativeName = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, relativeName);
      else entries.set(relativeName, readFileSync(path));
    }
  };
  walk(root, '');
  return entries;
}

function treeEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, bytes] of a) {
    if (!b.get(key)?.equals(bytes)) return false;
  }
  return true;
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
 * A disposable consumer checkout with a real git repository, the fake HOME
 * machinery (`XDG_CONFIG_HOME`, `CODEX_HOME`) and a deterministic
 * `OPENCODE_ETC`, mirroring the Python fixture's setUp.
 */
class Consumer {
  temp: string;
  root: string;
  home: string;
  xdg: string;
  codexHome: string;
  profile: string;
  private env = new EnvPatch();

  constructor(cleanup: (fn: () => void) => void) {
    this.temp = mkdtempSync(join(tmpdir(), 'memory-connections-'));
    this.root = join(this.temp, 'consumer');
    mkdirSync(this.root, { recursive: true });
    execFileSync('git', ['init', '-q', this.root]);
    writeFile(join(this.root, 'AGENTS.md'), '# Consumer\nKeep project rules.\n');
    writeFile(join(this.root, '.gitignore'), 'existing-ignore\n');
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
    const etc = join(this.temp, 'etc-opencode');
    connections.setOpencodeEtcForTesting(etc);
    cleanup(() => {
      connections.setOpencodeEtcForTesting('/etc/opencode');
      connections.setAtomicForTesting();
      this.env.restore();
      rmSync(this.temp, { recursive: true, force: true });
    });
  }

  writeProfile(content = PROFILE): string {
    writeFile(this.profile, content);
    return this.profile;
  }

  claudeHome(data: unknown): string {
    const path = join(this.home, '.claude.json');
    writeFile(path, JSON.stringify(data));
    return path;
  }

  codexUserConfig(text: string): string {
    const path = join(this.codexHome, 'config.toml');
    writeFile(path, text);
    return path;
  }

  trust(): void {
    this.codexUserConfig(
      `[projects."${this.root}"]\ntrust_level = "trusted"\n`,
    );
  }

  snapshot(): Map<string, Buffer> {
    return treeBytes(this.root);
  }
}

/** Minimal routing parse for the test composition (#114 owns config_data). */
function parseRouting(content: string): {
  data: Record<string, unknown>;
  clients: string[];
  server: string;
} {
  const data = tomlParse(content, { integersAsBigInt: false }) as Record<
    string,
    unknown
  >;
  const memory = data['memory'] as Record<string, unknown>;
  const clients = connections
    .connectionClients(data)
    .map((client) => String(client));
  return { data, clients, server: String(memory['mcp_server']) };
}

/**
 * Fabricated `.agents/memory/config.md`: the server line
 * `connection_selection` looks up plus the guidance paragraph
 * `connection_guidance` generates. The full `policy()` text is #114 scope;
 * these are the two parts `connection_selection` reads back.
 */
function generatedInstructions(server: string, clients: string[]): string {
  let text =
    '# Development memory\n\n' +
    `Use the native tools of MCP server \`${server}\`. All machines and clients\n`;
  if (clients.length) {
    text += '\n' + connections.connectionGuidance(clients);
  }
  return text;
}

interface RunResult {
  clients?: string[];
  mcp_server?: string;
  origin?: string;
  connections?: string;
  rendered?: string[];
  warnings: string[];
}

/**
 * `setup.run_connections` restricted to the memory_connections boundary:
 * marker selection (the `connection_selection` logic #114 ports) →
 * read_state → connection_profile → plan_connection_files → check/render.
 */
function runConnections(
  consumer: Consumer | { root: string; home: string; profile: string },
  options: { check?: boolean; profile?: string; home?: string } = {},
): RunResult {
  const root = consumer.root;
  const home = options.home ?? consumer.home;
  const check = options.check ?? false;
  const [state, stateWarning] = connections.readState(root);
  const instructions = join(root, '.agents/memory/config.md');
  let content: string | null = null;
  let origin: string | null = null;
  if (existsSync(join(root, '.agents/memory/config.toml'))) {
    origin = 'reviewed routing (config.toml + current generated config.md)';
    content = existsSync(instructions) ? readText(instructions) : '';
  } else if (existsSync(instructions)) {
    origin = 'restored routing (.agents/memory/config.md in this checkout)';
    content = readText(instructions);
  }
  const marker = content !== null ? connections.CONNECTION_MARKER.exec(content) : null;
  if (!marker) {
    const [failures, leftoverWarnings] = connections.leftoverDiagnostics(
      root,
      [],
      null,
      state,
    );
    if (failures.length) {
      throw new ValueError(
        'Generated connection entries recorded for server' +
          ` \`${dictGet(state as Dict, 'server')}\` remain, but this checkout` +
          ' records no connection selection:\n' +
          failures.join('\n') +
          '\nRemove or reconcile them manually — the helper never' +
          ' deletes client configuration',
      );
    }
    const cleaned = connections.pruneCleanedOwnership(
      root,
      [],
      state,
      !check,
    );
    const evidence =
      dictGet(cleaned as Dict, 'server') === null ||
      dictGet(cleaned as Dict, 'server') === undefined
        ? connections.connectionIgnoreEvidence(root)
        : [];
    if (evidence.length) {
      throw new ValueError(
        'This checkout carries the generated connection ignore' +
          ` entries ${evidence.map((line) => `\`${line}\``).join(', ')}` +
          ' but no connection selection is recorded in its routing —' +
          ' the restored routing predates the opt-in, or the entries' +
          ' are stale. If the opt-in is current, reconcile and commit' +
          ' the tracked routing source from the main checkout' +
          ` (\`${connections.DEFAULT_RECONCILE}\`) and commit .gitignore` +
          ' before creating worktrees. If connections were deselected' +
          ' or never selected, remove the entries through a reviewed' +
          ' edit',
      );
    }
    const warnings = [...leftoverWarnings];
    if (stateWarning) warnings.push(stateWarning);
    return { connections: 'not configured', warnings };
  }
  const clients = marker[1].trim().split(/\s+/);
  const server = SERVER_LINE.exec(content as string)?.[1] as string;
  const profile = connections.connectionProfile(
    root,
    clients,
    options.profile ?? consumer.profile,
  );
  const plans = connections.planConnectionFiles(
    root,
    clients,
    server,
    profile,
    state,
  );
  if (check) {
    return {
      clients,
      mcp_server: server,
      origin: origin ?? undefined,
      warnings: connections.checkConnections(
        root,
        clients,
        server,
        profile,
        plans,
        home,
        undefined,
        undefined,
        undefined,
        state,
      ),
    };
  }
  const [rendered, warnings] = connections.renderConnections(
    root,
    clients,
    server,
    profile,
    plans,
    home,
    undefined,
    undefined,
    state,
  );
  if (stateWarning) warnings.push(stateWarning);
  return { clients, mcp_server: server, origin: origin ?? undefined, rendered, warnings };
}

/**
 * `setup.setup` restricted to the connection slice: routing input → the
 * deselection/preflight chain → gitignore management for generated
 * clients → the same render/check calls setup() performs. Policy text,
 * skill linking and capability gating are #114 scope and are fabricated
 * or omitted here.
 */
function applySetup(
  consumer: Consumer,
  options: { portable?: string; check?: boolean; home?: string } = {},
): void {
  const root = consumer.root;
  const home = options.home ?? consumer.home;
  const target = join(root, '.agents/memory/config.toml');
  const instructions = join(root, '.agents/memory/config.md');
  let content: string;
  if (existsSync(target)) content = readText(target);
  else if (options.portable !== undefined) content = options.portable;
  else {
    throw new ValueError(
      'Missing .agents/memory/config.toml; the enabled Basic Memory' +
        ' capability expects reviewed v2 routing.',
    );
  }
  const { clients, server } = parseRouting(content);
  const generated = generatedInstructions(server, clients);
  const [connState] = connections.readState(root);
  const recordedEntries = dictGet(connState as Dict, 'entries');
  if (
    dictHas(parseRouting(content).data, 'connection') ||
    (recordedEntries instanceof Map && recordedEntries.size > 0)
  ) {
    const [leftoverFailures] = connections.leftoverDiagnostics(
      root,
      clients,
      server,
      connState,
    );
    if (leftoverFailures.length) {
      throw new ValueError(
        'Deselected connection client(s) still carry generated' +
          ` \`${server}\` entries:\n` +
          leftoverFailures.join('\n') +
          '\nRemove or reconcile them manually — the helper never' +
          ' deletes client configuration',
      );
    }
  }
  let profile: Dict | null = null;
  let plans: connections.Plan[] = [];
  if (clients.length) {
    profile = connections.connectionProfile(root, clients, consumer.profile);
    plans = connections.planConnectionFiles(
      root,
      clients,
      server,
      profile,
      connState,
    );
    const [shadowFailures] = connections.shadowReport(
      root,
      clients,
      server,
      profile,
      plans,
      home,
    );
    if (shadowFailures.length) {
      throw new ValueError(
        'Shadowing detected — no files written:\n' +
          shadowFailures.join('\n'),
      );
    }
    const unaligned = connections.alignmentFailures(plans);
    if (unaligned.length) {
      throw new ValueError(
        'Consumer-owned memory connection entries are not' +
          ' verifiably aligned — no files written:\n' +
          unaligned.join('\n'),
      );
    }
  }
  // Ignore lines for generated clients only, mirroring setup(): the
  // memory directory line first (the non-share path), then per-client
  // lines for files generation actually writes.
  const ignorePath = join(root, '.gitignore');
  const ignore = existsSync(ignorePath) ? readText(ignorePath) : '';
  let updatedIgnore = ignore;
  if (!updatedIgnore.split('\n').includes('/.agents/memory/')) {
    updatedIgnore +=
      (!updatedIgnore || updatedIgnore.endsWith('\n') ? '' : '\n') +
      '/.agents/memory/\n';
  }
  if (clients.length) {
    const generatedClients = plans
      .filter((plan) => plan.state !== 'consumer-owned')
      .map((plan) => plan.client);
    const lines = ignore.split('\n');
    for (const client of generatedClients) {
      const line = connections.CONNECTION_IGNORE[client];
      if (!lines.includes(line)) {
        updatedIgnore += (updatedIgnore.endsWith('\n') ? '' : '\n') + line + '\n';
      }
    }
    if (
      generatedClients.length &&
      !updatedIgnore.split('\n').includes('/.agents/memory/') &&
      !updatedIgnore
        .split('\n')
        .includes(connections.CONNECTION_STATE_IGNORE)
    ) {
      updatedIgnore +=
        (updatedIgnore.endsWith('\n') ? '' : '\n') +
        connections.CONNECTION_STATE_IGNORE +
        '\n';
    }
  }
  if (options.check) {
    if (updatedIgnore !== ignore) {
      const added = updatedIgnore
        .split('\n')
        .filter((line) => !ignore.split('\n').includes(line));
      throw new ValueError(
        `Missing ignore entr${added.length === 1 ? 'y' : 'ies'}` +
          ` ${added.map((line) => `\`${line}\``).join(', ')} in` +
          ' .gitignore; local routing and generated connection files' +
          ' are ignored by default.',
      );
    }
    if (clients.length) {
      connections.checkConnections(
        root,
        clients,
        server,
        profile,
        plans,
        home,
        undefined,
        undefined,
        undefined,
        connState,
      );
    }
    return;
  }
  if (updatedIgnore !== ignore) atomicWrite(ignorePath, updatedIgnore);
  if (!existsSync(target)) atomicWrite(target, content);
  const currentInstructions = existsSync(instructions)
    ? readText(instructions)
    : null;
  if (currentInstructions !== generated) {
    atomicWrite(instructions, generated);
  }
  if (!clients.length) {
    connections.pruneCleanedOwnership(root, [], connState, true);
    return;
  }
  connections.renderConnections(
    root,
    clients,
    server,
    profile,
    plans,
    home,
    undefined,
    undefined,
    connState,
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
  applySetup(consumer, { portable: CONFIG + selected });
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

function assertError(
  fn: () => void,
  pattern: RegExp,
  notIn?: string,
): void {
  try {
    fn();
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, pattern, `error message ${message}`);
    if (notIn) assert.ok(!message.includes(notIn));
    return;
  }
  assert.fail('expected an error');
}

// --- rendering ------------------------------------------------------------

test('test_optin_renders_all_clients_and_marks_instructions', withConsumer((c) => {
  enable(c);
  const claude = readJson(join(c.root, '.mcp.json')) as Dict;
  assert.deepEqual(
    toPlain(dictGet(dictGet(claude, 'mcpServers') as Dict, 'basic_memory')),
    {
      type: 'http',
      url: ENDPOINT,
      headers: { Authorization: `Bearer \${${ENV_NAME}}` },
    },
  );
  const codex = readToml(join(c.root, '.codex/config.toml'));
  assert.deepEqual(
    {
      ...((
        codex['mcp_servers'] as Record<string, Record<string, unknown>>
      )['basic_memory']),
    },
    { url: ENDPOINT, bearer_token_env_var: ENV_NAME },
  );
  const opencode = readJson(join(c.root, 'opencode.json')) as Dict;
  assert.deepEqual(
    toPlain(
      dictGet(
        dictGet(dictGet(opencode, 'mcp') as Dict, 'servers') as Dict,
        'basic_memory',
      ),
    ),
    {
      type: 'remote',
      url: ENDPOINT,
      oauth: false,
      headers: { Authorization: `Bearer {env:${ENV_NAME}}` },
    },
  );
  const generated = readText(join(c.root, '.agents/memory/config.md'));
  assert.ok(
    generated.includes(
      '<!-- agent-workflows:memory-connections: claude codex opencode -->',
    ),
  );
  const ignore = readText(join(c.root, '.gitignore')).split('\n');
  for (const line of ['/.mcp.json', '/.codex/config.toml', '/opencode.json']) {
    assert.ok(ignore.includes(line), line);
  }
  const staged = git(c.root, ['diff', '--cached', '--name-only']);
  assert.equal(staged, '');
}));

test('test_optin_is_idempotent_and_survives_checks', withConsumer((c) => {
  enable(c);
  const original = c.snapshot();
  applySetup(c);
  applySetup(c, { check: true });
  assert.ok(treeEqual(c.snapshot(), original));
  const outcome = runConnections(c, { check: true });
  assert.deepEqual(outcome.clients, ['claude', 'codex', 'opencode']);
  for (const relativePath of ['.mcp.json', '.codex/config.toml', 'opencode.json']) {
    const status = (() => {
      try {
        git(c.root, ['check-ignore', '-q', relativePath]);
        return 0;
      } catch {
        return 1;
      }
    })();
    assert.equal(status, 0);
  }
}));

test('test_disabled_mode_is_unchanged', withConsumer((c) => {
  c.writeProfile();
  applySetup(c, { portable: CONFIG });
  for (const relativePath of ['.mcp.json', '.codex/config.toml', 'opencode.json']) {
    assert.ok(!existsSync(join(c.root, relativePath)));
  }
  const generated = readText(join(c.root, '.agents/memory/config.md'));
  assert.ok(!generated.includes('memory-connections'));
  applySetup(c, { check: true });
  const outcome = runConnections(c);
  assert.equal(outcome.connections, 'not configured');
}));

test('test_empty_client_selection_renders_nothing', withConsumer((c) => {
  c.writeProfile();
  applySetup(c, {
    portable: CONFIG + '[connection]\nclients = []\n',
  });
  for (const relativePath of ['.mcp.json', '.codex/config.toml', 'opencode.json']) {
    assert.ok(!existsSync(join(c.root, relativePath)));
  }
  applySetup(c, { check: true });
}));

test('test_missing_profile_names_the_exact_file', withConsumer((c) => {
  const before = c.snapshot();
  assertError(
    () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
    /Missing machine connection profile: .*agent-workflows\/memory-connection\.toml/,
  );
  assert.ok(treeEqual(c.snapshot(), before));
}));

test('test_invalid_profiles_are_rejected', withConsumer((c) => {
  for (const content of [
    `endpoint = "${ENDPOINT}"\n`, // missing schema_version
    `schema_version = 2\nendpoint = "${ENDPOINT}"\n`,
    'schema_version = 1\nendpoint = "file:///etc/passwd"\n',
    'schema_version = 1\nendpoint = "https://u:p@host/mcp"\n',
    `schema_version = 1\nendpoint = "${ENDPOINT}"\n` +
      'bearer_token_env = "ANTHROPIC_AUTH_TOKEN"\n',
    `schema_version = 1\nendpoint = "${ENDPOINT}"\n` +
      `bearer_token_env = "${SENTINEL}-value"\n`,
  ]) {
    c.writeProfile(content);
    const before = c.snapshot();
    assertError(
      () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
      /machine connection profile/,
    );
    assert.ok(treeEqual(c.snapshot(), before));
  }
}));

test('test_bracketed_ipv6_endpoints_match_urlsplit', withConsumer((c) => {
  // CPython 3.12 urlsplit accepts an uncompressed bracketed IPv6 host
  // and rejects a zone id containing a second '%'.
  const ipv6 = 'http://[2001:db8:0:0:0:0:0:1]/mcp';
  c.writeProfile(
    `schema_version = 1\nendpoint = "${ipv6}"\n` +
      `bearer_token_env = "${ENV_NAME}"\n`,
  );
  c.trust();
  applySetup(c, { portable: CONFIG + CONNECTIONS });
  const doc = readJson(join(c.root, '.mcp.json')) as Dict;
  const entry = dictGet(
    dictGet(doc, 'mcpServers') as Dict,
    'basic_memory',
  ) as Dict;
  assert.equal(dictGet(entry, 'url'), ipv6);

  c.writeProfile('schema_version = 1\nendpoint = "http://[::1%a%b]/mcp"\n');
  const before = c.snapshot();
  assertError(
    () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
    /does not appear to be an IPv4 or IPv6 address/,
  );
  assert.ok(treeEqual(c.snapshot(), before));
}));

test('test_no_credential_value_is_written_anywhere', withConsumer((c) => {
  c.writeProfile();
  const env = new EnvPatch();
  env.set({ [ENV_NAME]: SENTINEL });
  try {
    applySetup(c, { portable: CONFIG + CONNECTIONS });
    runConnections(c);
  } finally {
    env.restore();
  }
  for (const [path, bytes] of treeBytes(c.root)) {
    assert.ok(
      !bytes.toString('utf8').includes(SENTINEL),
      `credential value leaked into ${path}`,
    );
  }
  for (const relativePath of ['.mcp.json', '.codex/config.toml', 'opencode.json']) {
    assert.ok(readText(join(c.root, relativePath)).includes(ENV_NAME));
  }
}));

// --- drift and merge -------------------------------------------------------

test('test_drift_and_missing_files_are_named_with_repairs', withConsumer((c) => {
  enable(c);
  const mcp = join(c.root, '.mcp.json');
  writeFile(mcp, readText(mcp).replace(ENDPOINT, 'https://other.example/'));
  assertError(
    () => applySetup(c, { check: true }),
    /modified after generation/,
  );
  unlinkSync(mcp);
  assertError(
    () => applySetup(c, { check: true }),
    /Missing connection file \.mcp\.json.*setup_memory_connections --project \./s,
  );
  runConnections(c); // the suggested repair restores the artifact
  assert.ok(existsSync(mcp));
}));

test('test_merges_preserve_unrelated_settings', withConsumer((c) => {
  c.writeProfile();
  writeFile(
    join(c.root, '.mcp.json'),
    JSON.stringify({
      mcpServers: { other: { type: 'stdio', command: 'tool' } },
      unrelated: true,
    }),
  );
  applySetup(c, { portable: CONFIG + CONNECTIONS });
  const merged = readJson(join(c.root, '.mcp.json')) as Dict;
  const servers = dictGet(merged, 'mcpServers') as Dict;
  assert.deepEqual(toPlain(dictGet(servers, 'other')), {
    type: 'stdio',
    command: 'tool',
  });
  assert.equal(dictGet(merged, 'unrelated'), true);
  assert.ok(dictHas(servers, 'basic_memory'));
}));

test('test_merges_preserve_scientific_notation_bytes', withConsumer((c) => {
  c.writeProfile();
  const mcp = join(c.root, '.mcp.json');
  writeFile(mcp, '{\n  "unrelated": 1e21,\n  "other": 1e16\n}\n');
  applySetup(c, { portable: CONFIG + CONNECTIONS });
  const text = readText(mcp);
  // `json.loads` keeps both as Python floats; `json.dumps` writes the
  // CPython repr — scientific notation, never `1e+21.0`.
  assert.ok(text.includes('"unrelated": 1e+21'));
  assert.ok(text.includes('"other": 1e+16'));
  JSON.parse(text); // the merged file stays valid JSON
}));

test('test_codex_layer_appends_and_preserves_existing_settings', withConsumer((c) => {
  c.writeProfile();
  const codex = join(c.root, '.codex/config.toml');
  mkdirSync(dirname(codex));
  writeFile(
    codex,
    'model = "gpt-5.5"\n\n[mcp_servers.other]\nurl = "https://other/"\n',
  );
  applySetup(c, { portable: CONFIG + CONNECTIONS });
  const merged = readToml(codex);
  assert.equal(
    ((merged['mcp_servers'] as Record<string, Record<string, unknown>>)['other'])['url'],
    'https://other/',
  );
  assert.equal(merged['model'], 'gpt-5.5');
  assert.ok('basic_memory' in (merged['mcp_servers'] as object));
  assert.ok(readText(codex).includes('[mcp_servers.other]'));
}));

test('test_inline_mcp_servers_cannot_be_extended', withConsumer((c) => {
  c.writeProfile();
  const codex = join(c.root, '.codex/config.toml');
  mkdirSync(dirname(codex));
  writeFile(codex, 'mcp_servers = {other = {url = "https://o/"}}\n');
  assertError(
    () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
    /Cannot extend/,
  );
  assert.equal(
    readText(codex),
    'mcp_servers = {other = {url = "https://o/"}}\n',
  );
}));

/**
 * `tomllib.loads` rejects these documents where smol-toml accepts them;
 * `tomlLoads` must raise `ValueError` before `planCodexConnection` can
 * return `merge`, so the consumer tree stays untouched. Covers the
 * classes in the `tomllibCompatCheck` comment, not just these strings.
 */
test('test_tomllib_verdict_gaps_refuse_codex_merge', withConsumer((c) => {
  c.writeProfile();
  const codex = join(c.root, '.codex/config.toml');
  const shapes = [
    // Trailing comma / raw newline inside an inline table.
    'unrelated = { a = 1, }\n',
    'unrelated = {\na = 1\n}\n',
    // `\e` and `\x` escapes `tomllib` does not allow.
    'unrelated = "\\e"\n',
    'unrelated = "\\x41"\n',
    // Calendar dates `datetime` rejects.
    'unrelated = 1979-02-29\n',
    'unrelated = 0000-01-01\n',
    // Local time without a seconds field.
    'unrelated = 10:00\n',
  ];
  for (const shape of shapes) {
    writeFile(codex, shape);
    const before = c.snapshot();
    assertError(
      () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
      /Unparseable .*config\.toml[\s\S]*preserve and review/,
    );
    assert.ok(treeEqual(c.snapshot(), before), shape);
    assert.equal(readText(codex), shape);
    // The same document is rejected on the other tomlLoads paths:
    // clientServers returns null like Python's client_servers does.
    assert.equal(connections.clientServers(codex, 'codex'), null);
  }
  // Documents `tomllib` also accepts still merge: an inline table, a
  // multiline array inside an inline table, and a leap date.
  writeFile(
    codex,
    'unrelated = { a = 1, b = [\n1,\n2\n], c = 2020-02-29 }\n',
  );
  applySetup(c, { portable: CONFIG + CONNECTIONS });
  const merged = readToml(codex);
  const unrelated = dictGet(merged, 'unrelated') as Record<string, unknown>;
  assert.equal(unrelated['a'], 1);
  assert.deepEqual(toPlain(unrelated['b']), [1, 2]);
  assert.equal(
    (unrelated['c'] as Date).toISOString().slice(0, 10),
    '2020-02-29',
  );
  assert.ok(
    'basic_memory' in (dictGet(merged, 'mcp_servers') as object),
  );
}));

test('test_conflicting_entries_and_tracked_files_are_refused', withConsumer((c) => {
  c.writeProfile();
  const mcp = join(c.root, '.mcp.json');
  writeFile(
    mcp,
    JSON.stringify({
      mcpServers: {
        basic_memory: { type: 'http', url: 'https://different.example/' },
      },
    }),
  );
  assertError(
    () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
    /not recorded as generated/,
  );
  assert.ok(readText(mcp).includes('https://different.example/'));
  git(c.root, ['add', '.mcp.json']);
  assertError(
    () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
    /not verifiably aligned/,
  );
  assert.ok(readText(mcp).includes('https://different.example/'));
}));

test('test_legacy_opencode_same_name_entry_conflicts', withConsumer((c) => {
  c.writeProfile();
  writeFile(
    join(c.root, 'opencode.json'),
    JSON.stringify({
      mcp: {
        basic_memory: { type: 'remote', url: ENDPOINT, enabled: true },
      },
    }),
  );
  assertError(
    () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
    /Legacy `mcp\.basic_memory`/,
  );
}));

// --- shadowing and prerequisites -------------------------------------------

test('test_claude_local_scope_shadowing_fails', withConsumer((c) => {
  c.claudeHome({
    projects: {
      [c.root]: {
        mcpServers: {
          basic_memory: { type: 'http', url: 'https://other/' },
        },
      },
    },
  });
  assertError(() => enable(c), /local-scope[\s\S]*shadows/);
}));

test('test_claude_local_same_and_user_duplicate_warn_only', withConsumer((c) => {
  c.claudeHome({
    projects: {
      [c.root]: {
        mcpServers: {
          basic_memory: {
            type: 'http',
            url: ENDPOINT,
            headers: { Authorization: `Bearer \${${ENV_NAME}}` },
          },
        },
      },
    },
    mcpServers: {
      basic_memory: { type: 'http', url: 'https://nas.example/' },
    },
  });
  enable(c);
  const outcome = runConnections(c);
  const text = outcome.warnings.join('\n');
  assert.ok(text.includes('local-scope entry `basic_memory` duplicates'));
  assert.ok(text.includes('user-scope entry `basic_memory`'));
  assert.ok(text.includes('different endpoint'));
}));

test('test_claude_rejected_project_entry_fails', withConsumer((c) => {
  c.claudeHome({
    projects: {
      [c.root]: { disabledMcpjsonServers: ['basic_memory'] },
    },
  });
  assertError(() => enable(c), /disabledMcpjsonServers/);
}));

test('test_codex_missing_trust_is_named_prerequisite', withConsumer((c) => {
  c.writeProfile();
  applySetup(c, {
    portable: CONFIG + '[connection]\nclients = ["codex"]\n',
  });
  const outcome = runConnections(c);
  assert.ok(outcome.warnings.some((warning) => warning.includes('trust')));
  assertError(
    () => runConnections(c, { check: true }),
    /Missing prerequisite[\s\S]*trust/,
  );
  c.trust();
  runConnections(c, { check: true });
}));

test('test_codex_user_field_leak_and_clean_duplicate', withConsumer((c) => {
  c.trust();
  enable(c, ['codex']);
  const config = c.codexUserConfig(
    `[projects."${c.root}"]\ntrust_level = "trusted"\n\n` +
      `[mcp_servers.basic_memory]\nurl = "https://user.example/"\n` +
      'startup_timeout_sec = 30\n',
  );
  assertError(
    () => runConnections(c, { check: true }),
    /startup_timeout_sec[\s\S]*field-level merge/,
  );
  writeFile(
    config,
    `[projects."${c.root}"]\ntrust_level = "trusted"\n\n` +
      `[mcp_servers.basic_memory]\nurl = "https://user.example/"\n` +
      'bearer_token_env_var = "OTHER"\n',
  );
  const outcome = runConnections(c, { check: true });
  assert.ok(
    outcome.warnings.some((warning) => warning.includes('fully overridden')),
  );
}));

test('test_opencode_global_duplicate_warns_and_etc_shadows', withConsumer((c) => {
  const globalConfig = join(c.xdg, 'opencode/opencode.json');
  writeFile(
    globalConfig,
    JSON.stringify({
      mcp: {
        servers: {
          basic_memory: { type: 'remote', url: 'https://global/' },
        },
      },
    }),
  );
  enable(c, ['opencode']);
  const outcome = runConnections(c, { check: true });
  assert.ok(
    outcome.warnings.some((warning) =>
      warning.includes('global entry `basic_memory`'),
    ),
  );
  const etc = join(c.temp, 'etc-opencode-2');
  writeFile(
    join(etc, 'opencode.json'),
    JSON.stringify({
      mcp: {
        servers: { basic_memory: { type: 'remote', url: 'https://etc/' } },
      },
    }),
  );
  connections.setOpencodeEtcForTesting(etc);
  assertError(
    () => runConnections(c, { check: true }),
    /higher-precedence/,
  );
}));

// --- selection, leftovers and worktrees -------------------------------------

test('test_deselected_client_leftovers_are_reported', withConsumer((c) => {
  enable(c);
  writeFile(
    join(c.root, '.agents/memory/config.toml'),
    CONFIG + '[connection]\nclients = ["claude", "codex"]\n',
  );
  assertError(() => applySetup(c), /Deselected[\s\S]*opencode\.json/);
  assert.ok(existsSync(join(c.root, 'opencode.json')));
}));

test('test_worktree_restores_from_generated_marker', withConsumer((c) => {
  enable(c);
  // A fresh worktree has the tracked config.md (via routing_source) but
  // not the ignored config.toml or the generated client files. The marker
  // selection itself is connection_selection (#114); at this boundary the
  // render regenerates every file.
  unlinkSync(join(c.root, '.agents/memory/config.toml'));
  for (const relativePath of ['.mcp.json', '.codex/config.toml', 'opencode.json']) {
    unlinkSync(join(c.root, relativePath));
  }
  const outcome = runConnections(c);
  assert.equal(
    outcome.origin,
    'restored routing (.agents/memory/config.md in this checkout)',
  );
  assert.deepEqual(outcome.rendered, ['claude', 'codex', 'opencode']);
  runConnections(c, { check: true });
}));

test('test_no_marker_no_routing_means_no_connections', withConsumer((c) => {
  writeFile(join(c.root, 'AGENTS.md'), '# Consumer\n');
  let outcome = runConnections(c);
  assert.equal(outcome.connections, 'not configured');
  applySetup(c, { portable: CONFIG });
  outcome = runConnections(c, { check: true });
  assert.equal(outcome.connections, 'not configured');
}));

test('test_missing_ignore_is_named', withConsumer((c) => {
  enable(c, ['claude']);
  const ignorePath = join(c.root, '.gitignore');
  writeFile(ignorePath, readText(ignorePath).replace('/.mcp.json\n', ''));
  assertError(() => runConnections(c), /not git-ignored/);
  // The setup() check-side 'Missing ignore entry' diagnostic is #114
  // orchestration; the boundary raises the same 'not git-ignored' error.
}));

// --- ownership, profile changes and leftovers ---------------------------------

test('test_profile_change_updates_owned_entries', withConsumer((c) => {
  enable(c);
  c.writeProfile(PROFILE.replace(ENDPOINT, 'https://new.example/mcp'));
  runConnections(c);
  const claude = readJson(join(c.root, '.mcp.json')) as Dict;
  assert.equal(
    dictGet(
      dictGet(dictGet(claude, 'mcpServers') as Dict, 'basic_memory') as Dict,
      'url',
    ),
    'https://new.example/mcp',
  );
  const codex = readToml(join(c.root, '.codex/config.toml'));
  assert.equal(
    (codex['mcp_servers'] as Record<string, Record<string, unknown>>)[
      'basic_memory'
    ]['url'],
    'https://new.example/mcp',
  );
  const opencode = readJson(join(c.root, 'opencode.json')) as Dict;
  assert.equal(
    dictGet(
      dictGet(
        dictGet(dictGet(opencode, 'mcp') as Dict, 'servers') as Dict,
        'basic_memory',
      ) as Dict,
      'url',
    ),
    'https://new.example/mcp',
  );
  runConnections(c, { check: true });
}));

test('test_hand_edited_owned_entry_refuses_regeneration', withConsumer((c) => {
  enable(c);
  const mcp = join(c.root, '.mcp.json');
  writeFile(mcp, readText(mcp).replace(ENDPOINT, 'https://other/'));
  c.writeProfile(PROFILE.replace(ENDPOINT, 'https://new.example/mcp'));
  assertError(() => runConnections(c), /modified after generation/);
  assert.ok(readText(mcp).includes('https://other/'));
}));

test('test_removing_connection_table_reports_owned_leftovers', withConsumer((c) => {
  enable(c);
  const config = join(c.root, '.agents/memory/config.toml');
  writeFile(config, CONFIG);
  assertError(() => applySetup(c), /Deselected[\s\S]*\.mcp\.json/);
  // The standalone command reaches the same conclusion from the
  // ownership record alone once the generated routing no longer
  // carries a selection.
  unlinkSync(config);
  const instructions = join(c.root, '.agents/memory/config.md');
  writeFile(
    instructions,
    readText(instructions).split(
      '<!-- agent-workflows:memory-connections:',
    )[0],
  );
  assertError(
    () => runConnections(c),
    /no connection selection[\s\S]*\.mcp\.json/,
  );
}));

test('test_manual_client_files_do_not_block_never_opted_users', withConsumer((c) => {
  // A consumer that never opted in keeps its hand-written entries;
  // nothing records ownership and nothing blocks setup or check.
  writeFile(
    join(c.root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        basic_memory: { type: 'http', url: 'https://manual/' },
      },
    }),
  );
  applySetup(c, { portable: CONFIG });
  const outcome = runConnections(c, { check: true });
  assert.equal(outcome.connections, 'not configured');
  assert.ok(readText(join(c.root, '.mcp.json')).includes('https://manual/'));
}));

test('test_manual_claude_entry_does_not_block_codex_only_optin', withConsumer((c) => {
  c.writeProfile();
  c.trust();
  writeFile(
    join(c.root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        basic_memory: { type: 'http', url: 'https://manual/' },
      },
    }),
  );
  applySetup(c, {
    portable: CONFIG + '[connection]\nclients = ["codex"]\n',
  });
  assert.ok(existsSync(join(c.root, '.codex/config.toml')));
  assert.ok(readText(join(c.root, '.mcp.json')).includes('https://manual/'));
  const outcome = runConnections(c, { check: true });
  assert.ok(
    outcome.warnings.some((warning) =>
      warning.includes('not recorded as generated'),
    ),
  );
}));

// --- preflight atomicity ------------------------------------------------------

test('test_shadowing_refusal_writes_nothing', withConsumer((c) => {
  c.writeProfile();
  c.trust();
  c.claudeHome({
    projects: {
      [c.root]: {
        mcpServers: {
          basic_memory: { type: 'http', url: 'https://other/' },
        },
      },
    },
  });
  const before = c.snapshot();
  assertError(
    () => applySetup(c, { portable: CONFIG + CONNECTIONS }),
    /Shadowing detected/,
  );
  assert.ok(treeEqual(c.snapshot(), before));
}));

// --- OpenCode layers -----------------------------------------------------------

test('test_opencode_dotdir_and_jsonc_layers', withConsumer((c) => {
  enable(c, ['opencode']);
  const dotdir = join(c.root, '.opencode');
  mkdirSync(dotdir);
  writeFile(
    join(dotdir, 'opencode.json'),
    JSON.stringify({
      mcp: {
        servers: {
          basic_memory: { type: 'remote', url: 'https://dir/' },
        },
      },
    }),
  );
  assertError(
    () => runConnections(c, { check: true }),
    /\.opencode[\s\S]*shadows/,
  );
  rmSync(dotdir, { recursive: true });
  // opencode.jsonc parses comments and shadows the generated file.
  writeFile(
    join(c.root, 'opencode.jsonc'),
    '// local override\n{"mcp": {"servers": {"basic_memory":' +
      ' {"type": "remote", "url": "https://jsonc/"}}}}\n',
  );
  assertError(
    () => runConnections(c, { check: true }),
    /opencode\.jsonc[\s\S]*shadows/,
  );
  writeFile(join(c.root, 'opencode.jsonc'), '{mcp: broken');
  const outcome = runConnections(c, { check: true });
  assert.ok(
    outcome.warnings.some(
      (warning) =>
        warning.includes('could not be parsed') &&
        warning.includes('unverified'),
    ),
  );
}));

// --- Claude settings ----------------------------------------------------------

test('test_claude_settings_disable_and_enable_all', withConsumer((c) => {
  const settings = join(c.root, '.claude/settings.local.json');
  mkdirSync(dirname(settings));
  writeFile(
    settings,
    JSON.stringify({ disabledMcpjsonServers: ['basic_memory'] }),
  );
  assertError(() => enable(c, ['claude']), /disabledMcpjsonServers/);
  writeFile(
    settings,
    JSON.stringify({ enableAllProjectMcpServers: true }),
  );
  enable(c, ['claude']);
  const outcome = runConnections(c, { check: true });
  assert.ok(
    !outcome.warnings.some((warning) =>
      warning.includes('not explicitly approved'),
    ),
  );
}));

test('test_claude_user_settings_approval_and_committed_caveat', withConsumer((c) => {
  const user = join(c.home, '.claude');
  mkdirSync(user, { recursive: true });
  writeFile(
    join(user, 'settings.json'),
    JSON.stringify({ enabledMcpjsonServers: ['basic_memory'] }),
  );
  enable(c, ['claude']);
  let outcome = runConnections(c, { check: true });
  assert.ok(
    !outcome.warnings.some((warning) =>
      warning.includes('not explicitly approved'),
    ),
  );
  const committed = join(c.root, '.claude/settings.json');
  mkdirSync(dirname(committed));
  writeFile(
    committed,
    JSON.stringify({ disabledMcpjsonServers: ['basic_memory'] }),
  );
  git(c.root, ['add', '.claude/settings.json']);
  outcome = runConnections(c, { check: true });
  assert.ok(
    outcome.warnings.some((warning) =>
      warning.includes('workspace is trusted'),
    ),
  );
}));

// --- Codex worktree trust ------------------------------------------------------

test('test_codex_trust_falls_back_to_main_checkout', withConsumer((c) => {
  c.writeProfile();
  c.trust();
  applySetup(c, {
    portable: CONFIG + '[connection]\nclients = ["codex"]\n',
  });
  git(c.root, ['add', '-A']);
  git(c.root, [
    '-c',
    'user.email=test@example',
    '-c',
    'user.name=test',
    'commit',
    '-qm',
    'x',
  ]);
  const worktree = join(c.temp, 'linked');
  git(c.root, ['worktree', 'add', worktree, 'HEAD']);
  // The bootstrap/shared-memory path restores the ignored routing; the
  // generated client files stay behind with the main checkout.
  mkdirSync(join(worktree, '.agents'), { recursive: true });
  execFileSync('cp', [
    '-r',
    join(c.root, '.agents/memory'),
    join(worktree, '.agents/memory'),
  ]);
  writeFile(join(worktree, 'AGENTS.md'), '# Consumer\n');
  const worktreeConsumer = { root: worktree, home: c.home, profile: c.profile };
  // Rendering in the linked worktree succeeds on the main checkout's
  // trust alone — no separate [projects."worktree"] entry is needed.
  let outcome = runConnections(worktreeConsumer);
  assert.ok(
    !outcome.warnings.some((warning) => warning.includes('trust')),
  );
  assert.ok(existsSync(join(worktree, '.codex/config.toml')));
  outcome = runConnections(worktreeConsumer, { check: true });
  assert.ok(
    !outcome.warnings.some((warning) => warning.includes('trust')),
  );
  c.codexUserConfig(
    `[projects."${c.root}"]\ntrust_level = "trusted"\n\n` +
      `[projects."${worktree}"]\n`,
  );
  runConnections(worktreeConsumer, { check: true });
  // Only an explicit trust level overrides the main checkout fallback.
  c.codexUserConfig(
    `[projects."${c.root}"]\ntrust_level = "trusted"\n\n` +
      `[projects."${worktree}"]\ntrust_level = "untrusted"\n`,
  );
  assertError(
    () => runConnections(worktreeConsumer, { check: true }),
    /trust/,
  );
}));

// --- stale routing source ------------------------------------------------------

test('test_ignores_without_selection_flag_stale_routing_source', withConsumer((c) => {
  enable(c, ['claude']);
  // A fresh worktree restores the tracked generated routing; when the
  // tracked copy predates the opt-in it has no marker, while the
  // committed .gitignore still carries the connection ignores.
  const instructions = join(c.root, '.agents/memory/config.md');
  writeFile(
    instructions,
    readText(instructions).split(
      '<!-- agent-workflows:memory-connections:',
    )[0],
  );
  unlinkSync(join(c.root, '.agents/memory/config.toml'));
  unlinkSync(join(c.root, '.agents/memory/connections.json'));
  assertError(
    () => runConnections(c),
    /reconcile[\s\S]*reconcile-routing-source/,
  );
}));

test('test_identical_manual_entry_is_not_adopted', withConsumer((c) => {
  c.writeProfile();
  const profile = { endpoint: ENDPOINT, bearer_token_env: ENV_NAME };
  const entry = connections.expectedEntry('claude', profile);
  const path = join(c.root, '.mcp.json');
  writeFile(path, JSON.stringify({ mcpServers: { basic_memory: entry } }));
  const before = readFileSync(path);
  assertError(
    () =>
      connections.planConnectionFiles(
        c.root,
        ['claude'],
        'basic_memory',
        profile,
      ),
    /not recorded as generated/,
  );
  assert.ok(readFileSync(path).equals(before));
  assert.ok(
    !existsSync(join(c.root, '.agents/memory/connections.json')),
  );
}));

test('test_bare_main_codex_entry_is_not_trusted', withConsumer((c) => {
  const projects = { [c.root]: {} };
  // For a regular repository the main-root lookup is the same path;
  // the linked-worktree test below covers a distinct fallback root.
  assert.equal(connections.codexTrusted(c.root, projects), false);
}));

test('test_routing_source_requires_committed_setup', withConsumer((c) => {
  const routing = join(c.root, '.agents/memory/config.md');
  mkdirSync(dirname(routing), { recursive: true });
  writeFile(routing, 'routing');
  writeFile(join(c.root, 'routing.md'), 'routing');
  writeFile(
    join(c.root, '.agent-workflows-t3.json'),
    JSON.stringify({ memory: { routing_source: 'routing.md' } }),
  );
  assert.ok(
    connections.routingSourceDrift(c.root)?.includes('differs from HEAD'),
  );
}));

test('test_nonobject_t3_config_is_diagnostic', withConsumer((c) => {
  writeFile(join(c.root, '.agent-workflows-t3.json'), '[]');
  assert.ok(connections.routingSourceDrift(c.root)?.includes('JSON object'));
}));

test('test_partial_render_retries_with_recorded_ownership', withConsumer((c) => {
  c.writeProfile();
  c.trust();
  const realAtomic = atomicWrite;
  connections.setAtomicForTesting((path, content) => {
    if (path === join(c.root, '.codex/config.toml')) {
      const error = new Error('synthetic second-client failure');
      error.name = 'PermissionError';
      throw error;
    }
    return realAtomic(path, content);
  });
  try {
    assert.throws(() => applySetup(c, { portable: CONFIG + CONNECTIONS }));
  } finally {
    connections.setAtomicForTesting();
  }
  assert.ok(existsSync(join(c.root, '.mcp.json')));
  const state = readJson(
    join(c.root, '.agents/memory/connections.json'),
  ) as Dict;
  assert.ok(dictHas(dictGet(state, 'entries') as Dict, 'claude'));
  applySetup(c);
  runConnections(c, { check: true });
}));

test('test_cleaned_deselection_releases_ownership', withConsumer((c) => {
  enable(c);
  const config = join(c.root, '.agents/memory/config.toml');
  writeFile(
    config,
    readText(config).replace(
      '"claude", "codex", "opencode"',
      '"claude", "codex"',
    ),
  );
  writeFile(join(c.root, 'opencode.json'), '{"mcp":{"servers":{}}}');
  applySetup(c);
  let state = readJson(
    join(c.root, '.agents/memory/connections.json'),
  ) as Dict;
  assert.ok(!dictHas(dictGet(state, 'entries') as Dict, 'opencode'));
  writeFile(
    join(c.root, 'opencode.json'),
    JSON.stringify({
      mcp: {
        servers: {
          basic_memory: {
            type: 'remote',
            url: 'https://manual.example/mcp',
          },
        },
      },
    }),
  );
  applySetup(c);
  runConnections(c, { check: true });
}));

test('test_malformed_ownership_is_preserved', withConsumer((c) => {
  enable(c, ['claude']);
  const state = join(c.root, '.agents/memory/connections.json');
  writeFile(state, '{bad');
  const before = c.snapshot();
  assertError(() => applySetup(c), /ownership record/);
  assert.ok(treeEqual(before, c.snapshot()));
}));

test('test_full_optout_releases_cleaned_ownership', withConsumer((c) => {
  for (const emptyTable of [false, true]) {
    enable(c, ['claude']);
    const config = join(c.root, '.agents/memory/config.toml');
    writeFile(
      config,
      CONFIG + (emptyTable ? '[connection]\nclients = []\n' : ''),
    );
    unlinkSync(join(c.root, '.mcp.json'));
    applySetup(c);
    const state = readJson(
      join(c.root, '.agents/memory/connections.json'),
    ) as Dict;
    assert.equal(dictSize(dictGet(state, 'entries') as Dict), 0);
    writeFile(
      join(c.root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          basic_memory: {
            type: 'http',
            url: 'https://manual.example/mcp',
          },
        },
      }),
    );
    applySetup(c);
    runConnections(c, { check: true });
    unlinkSync(join(c.root, '.mcp.json'));
    unlinkSync(config);
  }
}));

// --- consumer-owned (tracked) entries --------------------------------------------
//
// The Career Crafting regression (issue #107, slice 4): the consumer tracks
// its client files and keeps a manual `basic_memory_nas` entry next to
// unrelated sentinel-bearing servers. Tracked files are consumer-owned: the
// check validates their memory registration instead of writing them.

const TRACKED_CONFIG = CONFIG.replace('"basic_memory"', '"basic_memory_nas"');
const SERVER = 'basic_memory_nas';

function writeTrackedRegression(c: Consumer, overrides: {
  memoryClaude?: unknown;
  memoryCodex?: string;
  memoryOpencode?: unknown;
} = {}): Map<string, Buffer> {
  const memoryClaude =
    overrides.memoryClaude ??
    {
      type: 'http',
      url: ENDPOINT,
      headers: { Authorization: `Bearer \${${ENV_NAME}}` },
    };
  writeFile(
    join(c.root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        [SERVER]: memoryClaude,
        sentry: {
          type: 'http',
          url: 'https://sentry.example/mcp',
          headers: { Authorization: `Bearer ${SENTINEL}` },
        },
        'local-tool': { command: 'tool', env: { TOOL_KEY: SENTINEL } },
      },
    }),
  );
  const memoryOpencode =
    overrides.memoryOpencode ??
    {
      type: 'remote',
      url: ENDPOINT,
      oauth: false,
      headers: { Authorization: `Bearer {env:${ENV_NAME}}` },
    };
  writeFile(
    join(c.root, 'opencode.json'),
    JSON.stringify({
      mcp: {
        servers: {
          [SERVER]: memoryOpencode,
          neon: {
            type: 'remote',
            url: 'https://neon.example/',
            headers: { Authorization: `Bearer ${SENTINEL}` },
          },
        },
      },
      'other-setting': true,
    }),
  );
  const memoryCodex =
    overrides.memoryCodex ??
    `[mcp_servers."${SERVER}"]\nurl = "${ENDPOINT}"\n` +
      `bearer_token_env_var = "${ENV_NAME}"\n`;
  const codex = join(c.root, '.codex/config.toml');
  writeFile(
    codex,
    'model = "gpt-5.5"\n\n' +
      memoryCodex +
      '\n[mcp_servers.neon]\ncommand = "neon-mcp"\n' +
      `env = { NEON_TOKEN = "${SENTINEL}" }\n`,
  );
  const settings = join(c.root, '.claude/settings.local.json');
  writeFile(
    settings,
    JSON.stringify({
      enabledMcpjsonServers: [SERVER],
      permissions: {
        allow: [`mcp__${SERVER}`, 'mcp__sentry__query_logs'],
      },
    }),
  );
  git(c.root, [
    'add',
    '-f',
    '.mcp.json',
    'opencode.json',
    '.codex/config.toml',
    '.claude/settings.local.json',
  ]);
  const originals = new Map<string, Buffer>();
  for (const relativePath of [
    '.mcp.json',
    'opencode.json',
    '.codex/config.toml',
    '.claude/settings.local.json',
  ]) {
    originals.set(relativePath, readFileSync(join(c.root, relativePath)));
  }
  return originals;
}

function enableTracked(c: Consumer): void {
  c.writeProfile();
  c.trust();
  applySetup(c, { portable: TRACKED_CONFIG + CONNECTIONS });
}

test('test_tracked_aligned_entries_pass_check_consumer_owned', withConsumer((c) => {
  const original = writeTrackedRegression(c);
  enableTracked(c);
  applySetup(c, { check: true });
  let outcome = runConnections(c, { check: true });
  let text = outcome.warnings.join('\n');
  for (const relativePath of ['.mcp.json', '.codex/config.toml', 'opencode.json']) {
    assert.ok(
      text.includes(
        `${relativePath}: registration \`${SERVER}\` is` +
          ' consumer-owned (tracked) and aligned',
      ),
      text,
    );
  }
  assert.ok(text.includes('authentication'));
  assert.ok(!text.includes(SENTINEL));
  for (const [relativePath, content] of original) {
    assert.ok(readFileSync(join(c.root, relativePath)).equals(content));
  }
  const ignore = readText(join(c.root, '.gitignore')).split('\n');
  for (const line of [
    '/.mcp.json',
    '/.codex/config.toml',
    '/opencode.json',
    '/.agents/memory/connections.json',
  ]) {
    assert.ok(!ignore.includes(line), line);
  }
  assert.ok(!existsSync(join(c.root, '.agents/memory/connections.json')));
  // Rendering validates instead of writing: the entry is preserved.
  outcome = runConnections(c);
  assert.deepEqual(outcome.rendered, []);
  for (const [relativePath, content] of original) {
    assert.ok(readFileSync(join(c.root, relativePath)).equals(content));
  }
}));

test('test_tracked_entry_without_alignment_fails_with_instruction', withConsumer((c) => {
  const original = writeTrackedRegression(c);
  enableTracked(c);
  // The tracked entry drifts from this machine's profile endpoint.
  const mcp = join(c.root, '.mcp.json');
  writeFile(
    mcp,
    readText(mcp).replace(ENDPOINT, 'https://other.example/mcp'),
  );
  const drifted = readFileSync(mcp);
  for (const check of [false, true]) {
    assertError(
      () => runConnections(c, { check }),
      /\.mcp\.json is not verifiably aligned[\s\S]*Align `basic_memory_nas`/,
    );
    assert.ok(readFileSync(mcp).equals(drifted));
  }
  for (const relativePath of [
    'opencode.json',
    '.codex/config.toml',
    '.claude/settings.local.json',
  ]) {
    assert.ok(
      readFileSync(join(c.root, relativePath)).equals(
        original.get(relativePath) as Buffer,
      ),
    );
  }
}));

test('test_tracked_file_without_memory_entry_gets_targeted_instruction', withConsumer((c) => {
  const original = writeTrackedRegression(c);
  enableTracked(c);
  const doc = JSON.parse(readText(join(c.root, '.mcp.json')));
  delete doc['mcpServers'][SERVER];
  writeFile(join(c.root, '.mcp.json'), JSON.stringify(doc));
  assertError(
    () => runConnections(c, { check: true }),
    /not verifiably aligned[\s\S]*no registration `basic_memory_nas`[\s\S]*http/,
  );
  for (const [relativePath, content] of original) {
    if (relativePath === '.mcp.json') continue;
    assert.ok(readFileSync(join(c.root, relativePath)).equals(content));
  }
}));

test('test_unrecognized_tracked_shape_is_unknown_not_missing', withConsumer((c) => {
  writeTrackedRegression(c);
  enableTracked(c);
  const path = join(c.root, '.mcp.json');
  const doc = JSON.parse(readText(path));
  doc['mcpServers'][SERVER] = { mystery: true };
  writeFile(path, JSON.stringify(doc));
  try {
    runConnections(c, { check: true });
    assert.fail('expected an error');
  } catch (error) {
    assert.match((error as Error).message, /not verifiably aligned[\s\S]*unrecognized/);
    assert.ok(!(error as Error).message.includes(SENTINEL));
  }
}));

test('test_bracketed_ipv6_client_entries_match_urlsplit', withConsumer((c) => {
  // Client-file inspection shares urlsplit: the uncompressed host
  // inspects and aligns; the second-'%' zone degrades the entry to
  // unknown-inspection, like CPython's rejection.
  const ipv6 = 'http://[2001:db8:0:0:0:0:0:1]/mcp';
  const claudeAt = (url: string): Record<string, unknown> => ({
    type: 'http',
    url,
    headers: { Authorization: `Bearer \${${ENV_NAME}}` },
  });
  const codexAt = (url: string): string =>
    `[mcp_servers."${SERVER}"]\nurl = "${url}"\n` +
    `bearer_token_env_var = "${ENV_NAME}"\n`;
  const opencodeAt = (url: string): Record<string, unknown> => ({
    type: 'remote',
    url,
    oauth: false,
    headers: { Authorization: `Bearer {env:${ENV_NAME}}` },
  });
  writeTrackedRegression(c, {
    memoryClaude: claudeAt(ipv6),
    memoryCodex: codexAt(ipv6),
    memoryOpencode: opencodeAt(ipv6),
  });
  c.writeProfile(
    `schema_version = 1\nendpoint = "${ipv6}"\n` +
      `bearer_token_env = "${ENV_NAME}"\n`,
  );
  c.trust();
  applySetup(c, { portable: TRACKED_CONFIG + CONNECTIONS });
  runConnections(c, { check: true });

  writeTrackedRegression(c, {
    memoryClaude: claudeAt('http://[::1%a%b]/mcp'),
    memoryCodex: codexAt(ipv6),
    memoryOpencode: opencodeAt(ipv6),
  });
  assertError(
    () => applySetup(c),
    /not verifiably aligned[\s\S]*invalid port or authority/,
  );
}));

test('test_disabled_or_credential_literal_entries_are_not_aligned', withConsumer((c) => {
  writeTrackedRegression(c);
  enableTracked(c);
  const cases: [string, string[], Record<string, unknown>][] = [
    [
      join(c.root, '.mcp.json'),
      ['mcpServers'],
      {
        type: 'http',
        url: ENDPOINT,
        headers: { Authorization: `Bearer ${SENTINEL}` },
      },
    ],
    [
      join(c.root, 'opencode.json'),
      ['mcp', 'servers'],
      {
        type: 'remote',
        url: ENDPOINT,
        enabled: false,
        headers: { Authorization: `Bearer {env:${ENV_NAME}}` },
      },
    ],
  ];
  const originals = new Map(cases.map(([path]) => [path, readFileSync(path)]));
  for (const [path, section, entry] of cases) {
    const doc = JSON.parse(readText(path));
    let node = doc;
    for (const key of section) node = node[key];
    node[SERVER] = entry;
    writeFile(path, JSON.stringify(doc));
    try {
      runConnections(c, { check: true });
      assert.fail('expected an error');
    } catch (error) {
      assert.match((error as Error).message, /not verifiably aligned/);
      assert.ok(!(error as Error).message.includes(SENTINEL));
    }
    writeFileSync(path, originals.get(path) as Buffer);
  }
  runConnections(c, { check: true });
}));

test('test_different_name_equivalent_entry_is_aligned', withConsumer((c) => {
  const original = writeTrackedRegression(c);
  const path = join(c.root, '.mcp.json');
  const doc = JSON.parse(readText(path));
  doc['mcpServers']['corp-memory'] = doc['mcpServers'][SERVER];
  delete doc['mcpServers'][SERVER];
  writeFile(path, JSON.stringify(doc));
  original.set('.mcp.json', readFileSync(path));
  enableTracked(c);
  const outcome = runConnections(c, { check: true });
  const text = outcome.warnings.join('\n');
  assert.ok(text.includes('registration `corp-memory` is consumer-owned'));
  assert.ok(text.includes('endpoint equivalence'));
  for (const [relativePath, content] of original) {
    assert.ok(readFileSync(join(c.root, relativePath)).equals(content));
  }
}));

// --- mixed ownership ------------------------------------------------------------

test('test_mixed_tracked_and_generated_clients', withConsumer((c) => {
  const original = writeTrackedRegression(c);
  for (const relativePath of ['opencode.json', '.codex/config.toml']) {
    git(c.root, ['rm', '--cached', '-q', relativePath]);
    unlinkSync(join(c.root, relativePath));
  }
  c.writeProfile();
  c.trust();
  applySetup(c, { portable: TRACKED_CONFIG + CONNECTIONS });
  const ignore = readText(join(c.root, '.gitignore')).split('\n');
  assert.ok(ignore.includes('/.codex/config.toml'));
  assert.ok(ignore.includes('/opencode.json'));
  assert.ok(!ignore.includes('/.mcp.json'));
  const codex = readToml(join(c.root, '.codex/config.toml'));
  assert.equal(
    (codex['mcp_servers'] as Record<string, Record<string, unknown>>)[SERVER][
      'url'
    ],
    ENDPOINT,
  );
  const state = readJson(
    join(c.root, '.agents/memory/connections.json'),
  ) as Dict;
  assert.ok(!dictHas(dictGet(state, 'entries') as Dict, 'claude'));
  const outcome = runConnections(c, { check: true });
  assert.ok(
    outcome.warnings
      .join('\n')
      .includes(
        '.mcp.json: registration `basic_memory_nas` is consumer-owned',
      ),
  );
  // The tracked file keeps its bytes through render and check.
  assert.ok(
    readFileSync(join(c.root, '.mcp.json')).equals(original.get('.mcp.json') as Buffer),
  );
  assert.ok(
    readFileSync(join(c.root, '.claude/settings.local.json')).equals(
      original.get('.claude/settings.local.json') as Buffer,
    ),
  );
}));

test('test_all_tracked_needs_no_profile', withConsumer((c) => {
  writeTrackedRegression(c);
  c.trust();
  // No machine profile exists: alignment is structural only.
  applySetup(c, { portable: TRACKED_CONFIG + CONNECTIONS });
  const outcome = runConnections(c, { check: true });
  const text = outcome.warnings.join('\n');
  assert.ok(text.includes('consumer-owned (tracked) and aligned'));
  assert.ok(text.includes('structurally only'));
  assert.ok(!text.includes(SENTINEL));
}));

test('test_stale_ownership_released_when_file_becomes_tracked', withConsumer((c) => {
  c.writeProfile();
  c.trust();
  applySetup(c, {
    portable: CONFIG + '[connection]\nclients = ["claude"]\n',
  });
  let state = readJson(
    join(c.root, '.agents/memory/connections.json'),
  ) as Dict;
  assert.ok(dictHas(dictGet(state, 'entries') as Dict, 'claude'));
  // The generated file becomes tracked: the entry is now
  // consumer-owned; its stale ownership record is released.
  git(c.root, ['add', '-f', '.mcp.json']);
  const outcome = runConnections(c);
  assert.ok(
    outcome.warnings
      .join('\n')
      .includes('consumer-owned (tracked) and aligned'),
  );
  state = readJson(join(c.root, '.agents/memory/connections.json')) as Dict;
  assert.ok(!dictHas(dictGet(state, 'entries') as Dict, 'claude'));
  assert.equal(
    dictGet(
      dictGet(
        dictGet(readJson(join(c.root, '.mcp.json')) as Dict, 'mcpServers') as Dict,
        'basic_memory',
      ) as Dict,
      'url',
    ),
    ENDPOINT,
  );
  // Deselecting claude afterwards reports nothing to remove: the
  // tracked entry is consumer-owned.
  writeFile(join(c.root, '.agents/memory/config.toml'), CONFIG);
  applySetup(c);
  assert.ok(existsSync(join(c.root, '.mcp.json')));
}));

// --- fresh worktrees --------------------------------------------------------------

test('test_fresh_worktree_validates_inherited_tracked_entries', withConsumer((c) => {
  writeTrackedRegression(c);
  c.writeProfile();
  c.trust();
  applySetup(c, { portable: TRACKED_CONFIG + CONNECTIONS });
  git(c.root, ['add', '-A']);
  git(c.root, [
    '-c',
    'user.email=test@example',
    '-c',
    'user.name=test',
    'commit',
    '-qm',
    'x',
  ]);
  const worktree = join(c.temp, 'linked');
  git(c.root, ['worktree', 'add', worktree, 'HEAD']);
  mkdirSync(join(worktree, '.agents'), { recursive: true });
  execFileSync('cp', [
    '-r',
    join(c.root, '.agents/memory'),
    join(worktree, '.agents/memory'),
  ]);
  const worktreeConsumer = { root: worktree, home: c.home, profile: c.profile };
  const before = readFileSync(join(worktree, '.mcp.json'));
  let outcome = runConnections(worktreeConsumer);
  assert.deepEqual(outcome.rendered, []);
  assert.ok(readFileSync(join(worktree, '.mcp.json')).equals(before));
  outcome = runConnections(worktreeConsumer, { check: true });
  assert.ok(
    outcome.warnings
      .join('\n')
      .includes('consumer-owned (tracked) and aligned'),
  );
  // Without a profile on the machine the tracked entry still
  // validates structurally — it is never rewritten from a
  // machine-local profile.
  const missing = join(c.temp, 'absent-profile.toml');
  outcome = runConnections(worktreeConsumer, {
    check: true,
    profile: missing,
  });
  assert.ok(outcome.warnings.join('\n').includes('structurally only'));
  assert.ok(readFileSync(join(worktree, '.mcp.json')).equals(before));
  // A missing tracked entry is an instruction, never a rewrite.
  const doc = JSON.parse(readText(join(worktree, '.mcp.json')));
  delete doc['mcpServers'][SERVER];
  writeFile(join(worktree, '.mcp.json'), JSON.stringify(doc));
  try {
    runConnections(worktreeConsumer, { profile: missing });
    assert.fail('expected an error');
  } catch (error) {
    assert.match((error as Error).message, /not verifiably aligned/);
    assert.ok(!(error as Error).message.includes(SENTINEL));
  }
  // The unrelated sentinel-bearing entries are preserved, unjudged.
  assert.ok(readText(join(worktree, '.mcp.json')).includes(SENTINEL));
}));

// --- parse_jsonc dedicated rejection tests ----------------------------------------
//
// `parse_jsonc` must reject every input the Python version rejects: the
// bounded normalizer only strips comments and trailing commas, then
// `json.loads` decides — malformed JSON, malformed comments and anything
// else still raises ValueError.

test('test_parse_jsonc_accepts_comments_and_trailing_commas', () => {
  const parsed = connections.parseJsonc(
    '{\n// a comment\n"mcp": { /* nested */ "servers": {}, },\n}\n',
  );
  assert.deepEqual(toPlain(parsed), { mcp: { servers: {} } });
});

test('test_parse_jsonc_rejects_malformed_json', () => {
  for (const text of [
    '{bad',
    '{"a": }',
    '{"a": 1,,}',
    '{"a": undefined}',
    '"unterminated',
    '{/* unclosed comment',
    '{"a": "x", "b"}',
    '[]extra',
    "{'single': 'quotes'}",
    '{"a": 1} trailing',
    '// only a comment',
  ]) {
    try {
      connections.parseJsonc(text);
      assert.fail(`expected rejection for ${text}`);
    } catch (error) {
      assert.equal((error as Error).name, 'ValueError', text);
    }
  }
});

test('test_parse_jsonc_rejects_comments_in_strings_like_python', () => {
  // A comment opener inside a string is not a comment: the resulting
  // text is exactly what json.loads sees.
  const parsed = connections.parseJsonc('{"a": "http://x/y"}');
  assert.deepEqual(toPlain(parsed), { a: 'http://x/y' });
  // An unterminated string still fails after normalization.
  assert.throws(() => connections.parseJsonc('{"a": "b//c'), {
    name: 'ValueError',
  });
});
