// Node counterpart of tests/test_mcp_configure.py for the
// scripts/mcp_configure.ts port (issue #116). Test names keep the
// Python method names; the class-to-test mapping lives in
// docs/node-port.md.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mc from '../scripts/mcp_configure.ts';
import { jsonDumps, tomlLoads } from '../scripts/memory_connections.ts';
import { pyJsonLoads } from '../scripts/lib/pyloads.ts';
import { ValueError } from '../scripts/lib/pyerrors.ts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(ROOT);
const FIXTURES = join(ROOT, 'fixtures', 'mcp-configure');
const PROJECT = join(FIXTURES, 'project');
const APPLY_PROJECT = join(FIXTURES, 'apply', 'project');
const APPLY_BARE = join(FIXTURES, 'apply', 'bare');
const SENTINEL = 'SECRET_SENTINEL-do-not-emit';
const REVIEW_SENTINEL = 'SECRET_SENTINEL_REVIEW';
const SCRIPT = join(REPO, 'scripts', 'mcp_configure.ts');

const MACHINE = {
  name: 'workstation',
  env: new Set(['TRACKER_API_TOKEN', 'LINT_MCP_COMMAND',
    'LINT_BACKEND_TOKEN']),
  executables: new Set(['npx']),
  local_config_refs: {
    'machine-local memory profile': {
      endpoint: 'https://memory.example.test/mcp',
    },
    LINT_MCP_COMMAND: { command: ['lint-mcp', '--stdio'] },
  },
};

const MAPPING = {
  'basic-memory': {
    claude: 'basic_memory_nas', codex: 'memory', opencode: 'memory',
  },
  'issue-tracker': {
    claude: 'tracker', codex: 'tracker', opencode: 'tracker',
  },
  'local-lint': { claude: 'lint', codex: 'lint', opencode: 'lint' },
  'docs-api': { claude: 'weird', codex: 'experimental', opencode: 'mystery' },
};

const APPLY_MACHINE = {
  name: 'apply-machine',
  env: new Set(['TRACKER_API_TOKEN', 'LINT_MCP_COMMAND',
    'LINT_BACKEND_TOKEN', 'PARTNER_TOKEN']),
  executables: new Set(['lint-mcp', 'npx', 'secret-runner']),
  local_config_refs: {
    'machine-local memory profile': {
      endpoint: 'https://memory.example.test/mcp',
    },
    LINT_MCP_COMMAND: { command: ['lint-mcp', '--stdio'] },
  },
};

const APPLY_MAPPING = {
  memory: { claude: 'mem', codex: 'mem', opencode: 'mem' },
  tracker: { claude: 'tracker', codex: 'tracker', opencode: 'tracker' },
  lint: { claude: 'lint', codex: 'lint', opencode: 'lint' },
  blocked: { claude: 'blocked', codex: 'blocked', opencode: 'blocked' },
  moved: { claude: 'moved', codex: 'moved', opencode: 'moved' },
  'partner-api': { claude: 'partner', codex: 'partner', opencode: 'partner' },
  shadowed: { opencode: 'shadowed' },
  'oauth-docs': {
    claude: 'oauth-docs', codex: 'oauth-docs', opencode: 'oauth-docs',
  },
};

const DESTINATIONS = [
  '.mcp.json', '.codex/config.toml', 'opencode.json',
  '.claude/settings.local.json',
];

type Dict = Record<string, unknown> | Map<string, unknown>;

/** `mapping[key]` over the Map/object dicts the module returns. */
function get(mapping: unknown, key: string): unknown {
  if (mapping instanceof Map) return mapping.get(key);
  return (mapping as Record<string, unknown>)[key];
}

function has(mapping: unknown, key: string): boolean {
  return mapping instanceof Map
    ? mapping.has(key)
    : Object.hasOwn(mapping as Record<string, unknown>, key);
}

function keysOf(mapping: unknown): string[] {
  return mapping instanceof Map
    ? [...mapping.keys()]
    : Object.keys(mapping as Record<string, unknown>);
}

function set(mapping: unknown, key: string, value: unknown): void {
  if (mapping instanceof Map) mapping.set(key, value);
  else (mapping as Record<string, unknown>)[key] = value;
}

/** Recursively convert Map-based parse results into plain objects. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, member]) => [key, toPlain(member)]),
    );
  }
  if (Array.isArray(value)) return value.map(toPlain);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, toPlain(member)]),
    );
  }
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Set) return [...value];
  return value;
}

/** Every string anywhere inside `structure` (the Python `strings` helper). */
function strings(node: unknown): string[] {
  if (node instanceof Map) {
    return [...node.values()].flatMap(strings);
  }
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node !== null && typeof node === 'object' && !(node instanceof Set)) {
    return Object.values(node).flatMap(strings);
  }
  if (node instanceof Set) return [...node].flatMap(strings);
  return typeof node === 'string' ? [node] : [];
}

function assess(
  overrides: {
    machine?: unknown;
    mapping?: unknown;
    clients?: string[];
    root?: string;
  } = {},
): Dict {
  const options: {
    machine?: Dict;
    mapping?: unknown;
    clients?: string[];
  } = {
    machine:
      overrides.machine === undefined
        ? (structuredClone({
            ...MACHINE,
            env: [...MACHINE.env],
            executables: [...MACHINE.executables],
          }) as unknown as Dict)
        : (overrides.machine as Dict),
    mapping: overrides.mapping ?? MAPPING,
  };
  if (overrides.clients) options.clients = overrides.clients;
  return mc.assess(overrides.root ?? PROJECT, options);
}

function result(report: Dict, service: string, client: string): Dict {
  for (const entry of get(report, 'results') as Dict[]) {
    if (get(entry, 'service') === service && get(entry, 'client') === client) {
      return entry;
    }
  }
  assert.fail(`no result for ${service}/${client}`);
}

function action(plan: Dict, service: string, client: string): Dict {
  for (const entry of get(plan, 'actions') as Dict[]) {
    if (get(entry, 'service') === service && get(entry, 'client') === client) {
      return entry;
    }
  }
  assert.fail(`no action for ${service}/${client}`);
}

function confirm(
  plan: Dict,
  resolutions?: Record<string, Dict>,
): Dict {
  set(plan, 'confirmed', true);
  for (const [pair, resolution] of Object.entries(resolutions ?? {})) {
    const [service, client] = pair.split(' ');
    set(action(plan, service, client), 'resolution', resolution);
  }
  return plan;
}

/** `assertRaisesRegex(ValueError, pattern)`; returns the exception. */
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

/** `contextlib.redirect_stdout`/`redirect_stderr` over `main`. */
function runCli(argv: string[]): [number, string, string] {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalWrite = process.stdout.write;
  const originalErrWrite = process.stderr.write;
  console.log = (...args: unknown[]) => out.push(`${args.join(' ')}\n`);
  console.error = (...args: unknown[]) => err.push(`${args.join(' ')}\n`);
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = mc.main(argv);
    return [code, out.join(''), err.join('')];
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
  }
}

function makeTemp(): string {
  return mkdtempSync(join(tmpdir(), 'mcp-configure-'));
}

function readJson(path: string): unknown {
  return pyJsonLoads(readFileSync(path, 'utf8'));
}

// --- InspectionTests ----------------------------------------------------

test('test_parses_each_client_kind', () => {
  const snapshot = mc.inspectProject(PROJECT);
  const claude = get(get(snapshot, 'claude'), 'entries');
  assert.equal(get(get(claude, 'basic_memory_nas'), 'transport'), 'remote');
  assert.equal(get(get(claude, 'lint'), 'transport'), 'stdio');
  const codex = get(get(snapshot, 'codex'), 'entries');
  assert.equal(get(get(codex, 'tracker'), 'transport'), 'remote');
  assert.equal(get(get(codex, 'lint'), 'transport'), 'stdio');
  const opencode = get(get(snapshot, 'opencode'), 'entries');
  assert.equal(get(get(opencode, 'memory'), 'transport'), 'remote');
  assert.equal(get(get(opencode, 'lint'), 'transport'), 'stdio');
});

test('test_entries_emit_allowlisted_data_only', () => {
  const snapshot = mc.inspectProject(PROJECT);
  const lint = get(get(get(snapshot, 'claude'), 'entries'), 'lint');
  assert.equal(get(lint, 'command'), 'lint-mcp');
  assert.equal(get(lint, 'args'), 1);
  assert.deepEqual(get(lint, 'env_names'), ['LINT_BACKEND_TOKEN']);
  const tracker = get(get(get(snapshot, 'claude'), 'entries'), 'tracker');
  assert.deepEqual(get(tracker, 'header_names'), ['Authorization']);
  assert.deepEqual(get(tracker, 'env_refs'), ['TRACKER_API_TOKEN']);
  assert.equal(get(tracker, 'url'), 'https://tracker.example.test');
  const codex = get(get(get(snapshot, 'codex'), 'entries'), 'tracker');
  assert.deepEqual(get(codex, 'credential_names'), ['TRACKER_API_TOKEN']);
});

test('test_unknown_and_unsupported_shapes_are_named', () => {
  const snapshot = mc.inspectProject(PROJECT);
  const claude = get(get(get(snapshot, 'claude'), 'entries'), 'weird');
  assert.equal(get(claude, 'inspection'), 'unknown');
  assert.ok((get(claude, 'notes') as string[]).length);
  const codex = get(get(get(snapshot, 'codex'), 'entries'), 'experimental');
  assert.equal(get(codex, 'inspection'), 'unsupported');
  assert.ok(
    (get(codex, 'notes') as string[]).some((note) =>
      note.includes('websocket_url'),
    ),
  );
  const opencode = get(get(get(snapshot, 'opencode'), 'entries'), 'mystery');
  assert.equal(get(opencode, 'inspection'), 'unsupported');
  assert.ok(
    (get(opencode, 'notes') as string[]).some((note) =>
      note.includes('warp-drive'),
    ),
  );
});

test('test_opencode_shadowed_duplicate_is_diagnosed', () => {
  const snapshot = mc.inspectProject(PROJECT);
  const shadow = get(get(get(snapshot, 'opencode'), 'entries'), 'shadow');
  assert.deepEqual(get(shadow, 'layers'), ['mcp', 'mcp.servers']);
  const diagnostics = (get(get(snapshot, 'opencode'), 'diagnostics') as string[]).join('\n');
  assert.ok(diagnostics.includes('shadow'));
  assert.ok(diagnostics.includes('explicit resolution'));
});

test('test_claude_approvals_and_broad_grant_flag', () => {
  const snapshot = mc.inspectProject(PROJECT);
  const approvals = get(get(snapshot, 'claude'), 'approvals');
  assert.deepEqual(get(get(approvals, 'allow'), 'basic_memory_nas'), ['*']);
  assert.deepEqual(
    [...(get(get(approvals, 'allow'), 'tracker') as string[])].sort(),
    ['list_issues', 'read_issue'],
  );
  assert.deepEqual(get(approvals, 'disabled'), ['lint']);
  assert.equal(get(approvals, 'enable_all'), false);
  const broad = get(mc.inspectProject(join(FIXTURES, 'broad-grant')), 'claude');
  assert.equal(get(get(broad, 'approvals'), 'enable_all'), true);
  const diagnostics = (get(broad, 'diagnostics') as string[]).join('\n');
  assert.ok(diagnostics.includes('enableAllProjectMcpServers'));
  assert.ok(diagnostics.includes('never introduces'));
});

test('test_absent_client_files_are_not_errors', () => {
  const snapshot = mc.inspectProject(join(FIXTURES, 'broad-grant'));
  assert.equal(get(get(snapshot, 'codex'), 'present'), false);
  assert.deepEqual(toPlain(get(get(snapshot, 'codex'), 'entries')), {});
});

test('test_unreadable_client_file_is_explicit', () => {
  const temp = makeTemp();
  try {
    writeFileSync(join(temp, '.mcp.json'), '{not json');
    const block = get(mc.inspectProject(temp), 'claude');
    assert.equal(get(block, 'readable'), false);
    assert.ok((get(block, 'diagnostics') as string[]).length);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// smol-toml hands TOML calendar values back as `TomlDate` objects while
// `tomllib` produces `datetime` values — neither is a dict, so these
// fields degrade to unknown-inspection exactly like any other non-table.
test('test_codex_toml_date_env_is_not_a_table', () => {
  const temp = makeTemp();
  try {
    mkdirSync(join(temp, '.codex'));
    writeFileSync(
      join(temp, '.codex', 'config.toml'),
      '[mcp_servers.demo]\ncommand = "tool"\nenv = 1979-05-27\n',
    );
    const entries = get(get(mc.inspectProject(temp), 'codex'), 'entries');
    const demo = get(entries, 'demo');
    assert.equal(get(demo, 'inspection'), 'unknown');
    assert.equal(get(demo, 'transport'), 'stdio');
    assert.deepEqual(get(demo, 'env_names'), []);
    assert.deepEqual(get(demo, 'notes'), ["'env' must be a table"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('test_codex_toml_date_entry_is_not_a_table', () => {
  const temp = makeTemp();
  try {
    mkdirSync(join(temp, '.codex'));
    writeFileSync(
      join(temp, '.codex', 'config.toml'),
      '[mcp_servers]\ndemo = 07:32:00\n',
    );
    const entries = get(get(mc.inspectProject(temp), 'codex'), 'entries');
    const demo = get(entries, 'demo');
    assert.equal(get(demo, 'inspection'), 'unknown');
    assert.equal(get(demo, 'transport'), null);
    assert.deepEqual(get(demo, 'notes'), ['entry is not a table']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('test_codex_toml_date_http_headers_is_not_a_table', () => {
  const temp = makeTemp();
  try {
    mkdirSync(join(temp, '.codex'));
    writeFileSync(
      join(temp, '.codex', 'config.toml'),
      '[mcp_servers.demo]\nurl = "https://demo.example.test/mcp"\n' +
        'http_headers = 1979-05-27T07:32:00\n',
    );
    const entries = get(get(mc.inspectProject(temp), 'codex'), 'entries');
    const demo = get(entries, 'demo');
    assert.equal(get(demo, 'inspection'), 'unknown');
    assert.equal(get(demo, 'transport'), 'remote');
    assert.deepEqual(get(demo, 'header_names'), []);
    assert.deepEqual(get(demo, 'notes'), ["'http_headers' must be a table"]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// --- ClassificationTests ----------------------------------------------------

test('test_satisfied_registration_under_a_different_name', () => {
  const report = assess();
  for (const client of mc.CLIENTS) {
    const outcome = result(report, 'basic-memory', client);
    assert.equal(get(outcome, 'state'), 'satisfied');
    assert.equal(
      get(outcome, 'registration'),
      (MAPPING['basic-memory'] as Record<string, string>)[client],
    );
    // The registration name stays data; no rename is implied.
    assert.notEqual(get(outcome, 'registration'), 'basic-memory');
  }
});

test('test_auth_unverified_is_distinct_from_missing', () => {
  const report = assess();
  for (const client of mc.CLIENTS) {
    const outcome = result(report, 'issue-tracker', client);
    assert.equal(get(outcome, 'state'), 'auth-unverified');
    assert.ok(
      (get(outcome, 'limitations') as string[]).some((limit) =>
        limit.includes('cannot verify login'),
      ),
    );
  }
});

test('test_conflicts_and_missing_executables', () => {
  const report = assess();
  const lint = result(report, 'local-lint', 'claude');
  assert.equal(get(lint, 'state'), 'conflict');
  assert.ok(
    (get(lint, 'diagnostics') as string[]).some((d) =>
      d.includes('disabledMcpjsonServers'),
    ),
  );
  for (const client of ['codex', 'opencode']) {
    const outcome = result(report, 'local-lint', client);
    assert.equal(get(outcome, 'state'), 'missing-executable');
    assert.ok(
      (get(outcome, 'diagnostics') as string[]).some((d) =>
        d.includes('lint-mcp'),
      ),
    );
  }
});

test('test_unknown_unsupported_and_proposed_states', () => {
  const report = assess();
  const docsApi: Record<string, string> = {
    claude: 'unknown-inspection',
    codex: 'unsupported',
    opencode: 'unsupported',
  };
  for (const [client, state] of Object.entries(docsApi)) {
    assert.equal(get(result(report, 'docs-api', client), 'state'), state);
  }
  for (const client of mc.CLIENTS) {
    const outcome = result(report, 'docs-search', client);
    assert.equal(get(outcome, 'state'), 'proposed');
  }
  for (const client of mc.CLIENTS) {
    const outcome = result(report, 'declared-only', client);
    assert.equal(get(outcome, 'state'), 'unknown-inspection');
    assert.ok(
      (get(outcome, 'limitations') as string[]).some((limit) =>
        limit.includes('unknown'),
      ),
    );
  }
});

test('test_results_name_client_environment_service_state', () => {
  const report = assess();
  assert.equal(get(report, 'environment'), 'workstation');
  const declared = new Set(get(get(report, 'manifest'), 'services') as string[]);
  const seen = new Set<string>();
  for (const entry of get(report, 'results') as Dict[]) {
    seen.add(`${get(entry, 'service')} ${get(entry, 'client')}`);
    assert.ok((mc.CLIENTS as readonly string[]).includes(get(entry, 'client') as string));
    assert.equal(get(entry, 'environment'), 'workstation');
    assert.ok((mc.STATES as readonly string[]).includes(get(entry, 'state') as string));
    assert.ok(Array.isArray(get(entry, 'limitations')));
    assert.ok(Array.isArray(get(entry, 'diagnostics')));
  }
  assert.equal(seen.size, declared.size * mc.CLIENTS.length);
  for (const service of declared) {
    for (const client of mc.CLIENTS) {
      assert.ok(seen.has(`${service} ${client}`));
    }
  }
});

test('test_optional_failures_leave_unrelated_services_usable', () => {
  const report = assess();
  const states = new Map<string, string>();
  for (const entry of get(report, 'results') as Dict[]) {
    if (get(entry, 'client') === 'codex') {
      states.set(get(entry, 'service') as string, get(entry, 'state') as string);
    }
  }
  assert.equal(states.get('local-lint'), 'missing-executable');
  assert.equal(states.get('issue-tracker'), 'auth-unverified');
  assert.equal(states.get('basic-memory'), 'satisfied');
});

// --- MappingTests --------------------------------------------------------

test('test_unconfirmed_equivalence_is_proposed_not_satisfied', () => {
  const report = assess({ mapping: {} });
  let outcome = result(report, 'basic-memory', 'claude');
  assert.equal(get(outcome, 'state'), 'proposed');
  assert.deepEqual(get(outcome, 'candidates'), ['basic_memory_nas']);
  assert.ok(
    (get(outcome, 'limitations') as string[]).some((limit) =>
      limit.includes('owner selection'),
    ),
  );
  // Codex registration carries a trailing slash; the URL heuristic
  // still proposes it after single-slash normalization.
  outcome = result(report, 'basic-memory', 'codex');
  assert.equal(get(outcome, 'state'), 'proposed');
  assert.deepEqual(get(outcome, 'candidates'), ['memory']);
  // The stdio heuristic matches the resolved command, args included.
  outcome = result(report, 'local-lint', 'opencode');
  assert.equal(get(outcome, 'state'), 'proposed');
  assert.deepEqual(get(outcome, 'candidates'), ['lint']);
});

test('test_explicit_selection_overrides_proposals', () => {
  // A confirmed name pointing elsewhere is a conflict, not a silent
  // accept; the heuristic candidate for the same service stays data.
  const report = assess({ mapping: { 'issue-tracker': { opencode: 'memory' } } });
  const outcome = result(report, 'issue-tracker', 'opencode');
  assert.equal(get(outcome, 'state'), 'conflict');
  assert.equal(get(outcome, 'registration'), 'memory');
  assert.ok(
    (get(outcome, 'diagnostics') as string[]).some((d) =>
      d.includes('different'),
    ),
  );
});

test('test_confirmed_absent_registration_is_proposed', () => {
  const report = assess({ mapping: { 'basic-memory': { claude: 'not-there' } } });
  const outcome = result(report, 'basic-memory', 'claude');
  assert.equal(get(outcome, 'state'), 'proposed');
  assert.equal(get(outcome, 'registration'), 'not-there');
});

test('test_confirmed_shadowed_registration_is_conflict', () => {
  const report = assess({ mapping: { 'docs-api': { opencode: 'shadow' } } });
  const outcome = result(report, 'docs-api', 'opencode');
  assert.equal(get(outcome, 'state'), 'conflict');
  assert.ok(
    (get(outcome, 'diagnostics') as string[]).some((d) =>
      d.includes('shadow'),
    ),
  );
});

// --- ManifestTests --------------------------------------------------------

test('test_absent_manifest_reports_no_requirements', () => {
  const report = mc.assess(join(FIXTURES, 'no-manifest'), {
    machine: MACHINE as unknown as Dict,
  });
  assert.equal(get(get(report, 'manifest'), 'present'), false);
  assert.ok(
    (get(get(report, 'manifest'), 'note') as string).includes(
      'no MCP requirements',
    ),
  );
  assert.deepEqual(get(report, 'results'), []);
  const entries = get(get(get(report, 'clients'), 'claude'), 'entries');
  assert.ok(has(entries, 'solo'));
});

test('test_invalid_manifest_is_a_diagnostic_not_a_crash', () => {
  const temp = makeTemp();
  try {
    mkdirSync(join(temp, '.agents'));
    writeFileSync(
      join(temp, '.agents', 'mcp-requirements.json'),
      '{"version": 9, "services": {}}',
    );
    const report = mc.assess(temp, { machine: {} as Dict });
    assert.equal(get(get(report, 'manifest'), 'present'), true);
    assert.ok((get(get(report, 'manifest'), 'error') as string).includes('version'));
    assert.deepEqual(get(report, 'results'), []);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// --- RedactionTests --------------------------------------------------------

test('test_sentinel_never_appears_in_any_emitted_structure', () => {
  const emitted = [
    mc.inspectProject(PROJECT),
    assess(),
    assess({ mapping: {} }),
    mc.assess(join(FIXTURES, 'broad-grant'), {
      machine: MACHINE as unknown as Dict,
    }),
  ];
  for (const structure of emitted) {
    const text = jsonDumps(structure);
    assert.ok(!text.includes(SENTINEL));
    for (const value of strings(structure)) {
      assert.ok(!value.includes(SENTINEL));
    }
  }
});

test('test_literal_secret_values_are_counted_never_echoed', () => {
  const unrelated = get(
    get(get(mc.inspectProject(PROJECT), 'claude'), 'entries'),
    'unrelated',
  );
  assert.deepEqual(get(unrelated, 'env_names'), ['API_KEY']);
  assert.ok(
    (get(unrelated, 'notes') as string[]).some((note) =>
      note.includes('redacted'),
    ),
  );
  const headers = get(
    get(get(mc.inspectProject(PROJECT), 'codex'), 'entries'),
    'unrelated',
  );
  assert.deepEqual(get(headers, 'header_names'), ['X-Api-Key']);
});

// --- PlanTests ------------------------------------------------------------

function planFor(
  selections: unknown,
  options: {
    mapping?: unknown;
    root?: string;
    machine?: unknown;
  } = {},
): Dict {
  return mc.buildPlan(
    options.root ?? APPLY_PROJECT,
    options.mapping ?? APPLY_MAPPING,
    selections,
    { machine: (options.machine ?? APPLY_MACHINE) as Dict },
  );
}

test('test_plan_classifies_every_selected_pair', () => {
  const plan = planFor(['memory', 'tracker', 'lint', 'blocked', 'moved']);
  assert.equal(get(action(plan, 'memory', 'claude'), 'action'), 'approval-grant');
  assert.deepEqual(get(action(plan, 'memory', 'claude'), 'approvals'), ['mcp__mem']);
  for (const client of ['codex', 'opencode']) {
    assert.equal(get(action(plan, 'memory', client), 'action'), 'reuse');
  }
  for (const client of mc.CLIENTS) {
    assert.equal(get(action(plan, 'tracker', client), 'action'), 'add');
    assert.equal(get(action(plan, 'lint', client), 'action'), 'add');
    assert.equal(
      get(action(plan, 'blocked', client), 'action'),
      'conflict-needs-resolution',
    );
    assert.equal(
      get(action(plan, 'moved', client), 'action'),
      'conflict-needs-resolution',
    );
  }
});

test('test_plan_entries_follow_documented_client_shapes', () => {
  const plan = planFor(['tracker', 'lint']);
  assert.deepEqual(toPlain(get(action(plan, 'tracker', 'claude'), 'entry')), {
    type: 'http',
    url: 'https://tracker.example.test/mcp',
    headers: { Authorization: 'Bearer ${TRACKER_API_TOKEN}' },
  });
  assert.deepEqual(toPlain(get(action(plan, 'lint', 'claude'), 'entry')), {
    command: 'lint-mcp',
    args: ['--stdio'],
    env: { LINT_BACKEND_TOKEN: '${LINT_BACKEND_TOKEN}' },
  });
  assert.deepEqual(toPlain(get(action(plan, 'tracker', 'codex'), 'entry')), {
    url: 'https://tracker.example.test/mcp',
    bearer_token_env_var: 'TRACKER_API_TOKEN',
  });
  assert.deepEqual(toPlain(get(action(plan, 'lint', 'codex'), 'entry')), {
    command: 'lint-mcp',
    args: ['--stdio'],
    env_vars: ['LINT_BACKEND_TOKEN'],
  });
  assert.deepEqual(
    toPlain(get(action(plan, 'tracker', 'opencode'), 'entry')),
    {
      type: 'remote',
      url: 'https://tracker.example.test/mcp',
      headers: { Authorization: 'Bearer {env:TRACKER_API_TOKEN}' },
      oauth: false,
    },
  );
  assert.deepEqual(toPlain(get(action(plan, 'lint', 'opencode'), 'entry')), {
    type: 'local',
    command: ['lint-mcp', '--stdio'],
    environment: { LINT_BACKEND_TOKEN: '{env:LINT_BACKEND_TOKEN}' },
  });
});

test('test_plan_is_redacted', () => {
  const plan = planFor({
    memory: true,
    tracker: true,
    lint: true,
    blocked: true,
    moved: true,
    'oauth-docs': true,
    'partner-api': {
      source: { client: 'opencode', registration: 'partner' },
    },
  });
  const text = jsonDumps(plan);
  assert.ok(!text.includes(SENTINEL));
  for (const value of strings(plan)) {
    assert.ok(!value.includes(SENTINEL));
  }
});

test('test_untranslatable_source_fields_are_reported_not_copied', () => {
  const plan = planFor({
    'partner-api': {
      source: { client: 'opencode', registration: 'partner' },
    },
  });
  const entry = action(plan, 'partner-api', 'codex');
  assert.equal(get(entry, 'action'), 'add');
  assert.deepEqual(toPlain(get(entry, 'entry')), {
    url: 'https://partner.example.test/mcp',
    bearer_token_env_var: 'PARTNER_TOKEN',
  });
  const reported = (get(entry, 'untranslated') as string[]).join('\n');
  assert.ok(reported.includes('X-Partner-Key'));
  assert.ok(reported.includes('timeout'));
  // The selected source stays a reuse on its own client and gains
  // only the missing approval on Claude.
  assert.equal(get(action(plan, 'partner-api', 'opencode'), 'action'), 'reuse');
  assert.equal(
    get(action(plan, 'partner-api', 'claude'), 'action'),
    'approval-grant',
  );
});

test('test_oauth_is_an_interactive_prerequisite', () => {
  const plan = planFor(['oauth-docs']);
  for (const client of mc.CLIENTS) {
    const entry = action(plan, 'oauth-docs', client);
    assert.equal(get(entry, 'action'), 'add');
    const entryKeys = new Set(
      keysOf(get(entry, 'entry')).map((key) => key.toLowerCase()),
    );
    assert.ok(!entryKeys.has('oauth'));
    assert.ok(!has(get(entry, 'entry'), 'headers'));
    assert.ok(
      (get(entry, 'prerequisites') as string[]).some((note) =>
        note.includes('interactive'),
      ),
    );
  }
});

test('test_absent_manifest_leaves_selections_unplanned', () => {
  const plan = planFor(['tracker'], { root: join(FIXTURES, 'no-manifest') });
  assert.deepEqual(get(plan, 'actions'), []);
  assert.ok((get(plan, 'diagnostics') as string[]).length);
  assert.equal(get(get(plan, 'manifest'), 'present'), false);
});

test('test_duplicate_registration_claims_are_conflicts', () => {
  const mapping = JSON.parse(JSON.stringify(APPLY_MAPPING));
  mapping['tracker'] = { ...mapping['tracker'], claude: 'mem' };
  const plan = planFor(['memory', 'tracker'], { mapping });
  assert.equal(
    get(action(plan, 'memory', 'claude'), 'action'),
    'conflict-needs-resolution',
  );
  assert.equal(
    get(action(plan, 'tracker', 'claude'), 'action'),
    'conflict-needs-resolution',
  );
});

test('test_digest_records_cover_write_destinations', () => {
  const plan = planFor(['tracker']);
  assert.deepEqual(
    new Set(keysOf(get(plan, 'files'))),
    new Set([
      '.mcp.json',
      '.claude/settings.local.json',
      '.codex/config.toml',
      'opencode.json',
    ]),
  );
  for (const rel of keysOf(get(plan, 'files'))) {
    const meta = get(get(plan, 'files'), rel);
    assert.equal(get(meta, 'present'), true);
    assert.ok((get(meta, 'digest') as string).startsWith('sha256:'));
  }
  const reuse = planFor(['memory']);
  assert.ok(!has(get(reuse, 'files'), '.mcp.json'));
  assert.ok(!has(get(reuse, 'files'), '.codex/config.toml'));
  assert.ok(has(get(reuse, 'files'), '.claude/settings.local.json'));
});

test('test_shadowed_registration_is_a_conflict', () => {
  const plan = planFor({ shadowed: { clients: ['opencode'] } });
  const entry = action(plan, 'shadowed', 'opencode');
  assert.equal(get(entry, 'action'), 'conflict-needs-resolution');
  assert.ok(
    (get(entry, 'diagnostics') as string[]).some((note) =>
      note.includes('shadow'),
    ),
  );
});

// --- ApplyTests ------------------------------------------------------------

let applyTemp: string | null = null;
let applyRoot: string | null = null;

function applySetup(): void {
  applyTemp = makeTemp();
  applyRoot = join(applyTemp, 'project');
  cpSync(APPLY_PROJECT, applyRoot, { recursive: true });
}

/** The ApplyTests scratch copy, created on first use. */
function ensureApplyRoot(): string {
  if (applyRoot === null) applySetup();
  return applyRoot as string;
}

afterEach(() => {
  if (applyTemp) rmSync(applyTemp, { recursive: true, force: true });
  applyTemp = applyRoot = null;
})

function rootPlan(
  selections: unknown,
  options: { mapping?: unknown; root?: string | null; machine?: unknown } = {},
): Dict {
  return mc.buildPlan(
    options.root ?? ensureApplyRoot(),
    options.mapping ?? APPLY_MAPPING,
    selections,
    { machine: (options.machine ?? APPLY_MACHINE) as Dict },
  );
}

function texts(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of DESTINATIONS) {
    const path = join(root, rel);
    if (existsSync(path)) out[rel] = readFileSync(path, 'utf8');
  }
  return out;
}

test('test_unconfirmed_plan_refuses_and_writes_nothing', () => {
  const plan = rootPlan(['tracker', 'lint']);
  const before = texts(ensureApplyRoot());
  throwsRegex(() => mc.apply(plan));
  assert.deepEqual(texts(ensureApplyRoot()), before);
});

test('test_malformed_plan_and_root_mismatch_refuse', () => {
  throwsRegex(() => mc.apply({}));
  const bad = rootPlan(['tracker']);
  set(bad, 'confirmed', true);
  set(bad, 'actions', [new Map([['action', 'bogus']])]);
  throwsRegex(() => mc.apply(bad));
  const plan = rootPlan(['tracker']);
  set(plan, 'confirmed', true);
  const other = makeTemp();
  try {
    throwsRegex(() => mc.apply(plan, other));
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

test('test_round_trip_per_client_and_unrelated_preserved', () => {
  const root = ensureApplyRoot();
  const plan = confirm(rootPlan(['tracker', 'lint']));
  const outcome = mc.apply(plan);
  assert.deepEqual(
    new Set(get(outcome, 'files_written') as string[]),
    new Set(DESTINATIONS),
  );
  const claude = readJson(join(root, '.mcp.json'));
  assert.deepEqual(toPlain(get(get(claude, 'mcpServers'), 'tracker')), {
    type: 'http',
    url: 'https://tracker.example.test/mcp',
    headers: { Authorization: 'Bearer ${TRACKER_API_TOKEN}' },
  });
  assert.deepEqual(toPlain(get(get(claude, 'mcpServers'), 'lint')), {
    command: 'lint-mcp',
    args: ['--stdio'],
    env: { LINT_BACKEND_TOKEN: '${LINT_BACKEND_TOKEN}' },
  });
  assert.deepEqual(toPlain(get(get(claude, 'mcpServers'), 'unrelated')), {
    command: 'secret-runner',
    args: ['--api-key', SENTINEL],
    env: { API_KEY: SENTINEL },
  });
  const codexText = readFileSync(join(root, '.codex/config.toml'), 'utf8');
  const codex = tomlLoads(codexText);
  assert.deepEqual(toPlain(get(get(codex, 'mcp_servers'), 'tracker')), {
    url: 'https://tracker.example.test/mcp',
    bearer_token_env_var: 'TRACKER_API_TOKEN',
  });
  assert.deepEqual(toPlain(get(get(codex, 'mcp_servers'), 'lint')), {
    command: 'lint-mcp',
    args: ['--stdio'],
    env_vars: ['LINT_BACKEND_TOKEN'],
  });
  // Comments and unrelated tables survive the targeted TOML edit.
  assert.ok(codexText.includes('# Codex project configuration fixture.'));
  assert.ok(codexText.includes('model = "gpt-5"'));
  assert.deepEqual(toPlain(get(get(codex, 'mcp_servers'), 'unrelated')), {
    command: 'secret-runner',
    env: { API_KEY: SENTINEL },
  });
  const opencode = readJson(join(root, 'opencode.json'));
  assert.deepEqual(
    toPlain(get(get(get(opencode, 'mcp'), 'servers'), 'tracker')),
    {
      type: 'remote',
      url: 'https://tracker.example.test/mcp',
      headers: { Authorization: 'Bearer {env:TRACKER_API_TOKEN}' },
      oauth: false,
    },
  );
  assert.deepEqual(
    toPlain(get(get(get(opencode, 'mcp'), 'servers'), 'lint')),
    {
      type: 'local',
      command: ['lint-mcp', '--stdio'],
      environment: { LINT_BACKEND_TOKEN: '{env:LINT_BACKEND_TOKEN}' },
    },
  );
  assert.deepEqual(
    toPlain(
      get(
        get(get(get(opencode, 'mcp'), 'servers'), 'unrelated'),
        'environment',
      ),
    ),
    { API_KEY: SENTINEL },
  );
  assert.equal(get(opencode, 'theme'), 'fixture');
  // The secret-bearing unrelated values remain byte-identical:
  // every sentinel occurrence survives the edit verbatim.
  for (const rel of DESTINATIONS) {
    if (rel === '.claude/settings.local.json') continue;
    const countOccurrences = (text: string): number =>
      text.split(SENTINEL).length - 1;
    assert.equal(
      countOccurrences(readFileSync(join(root, rel), 'utf8')),
      countOccurrences(readFileSync(join(APPLY_PROJECT, rel), 'utf8')),
    );
  }
});

test('test_stale_plan_refusal_names_the_file_and_writes_nothing', () => {
  const root = ensureApplyRoot();
  const plan = confirm(rootPlan(['tracker']));
  const path = join(root, '.mcp.json');
  const mutated = readFileSync(path, 'utf8').replace('"unrelated"', '"owner-edit"');
  writeFileSync(path, mutated);
  const caught = throwsRegex(() => mc.apply(plan));
  assert.ok(caught.message.includes('.mcp.json'));
  assert.equal(readFileSync(path, 'utf8'), mutated);
});

test('test_absent_destination_appearing_is_stale', () => {
  const temp = makeTemp();
  try {
    const bare = join(temp, 'bare');
    cpSync(APPLY_BARE, bare, { recursive: true });
    const plan = confirm(rootPlan(['tracker'], { root: bare }));
    writeFileSync(join(bare, 'opencode.json'), '{"mcp": {}}');
    const caught = throwsRegex(() => mc.apply(plan));
    assert.ok(caught.message.includes('opencode.json'));
    assert.equal(
      readFileSync(join(bare, 'opencode.json'), 'utf8'),
      '{"mcp": {}}',
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('test_double_apply_is_a_no_op', () => {
  const root = ensureApplyRoot();
  const plan = confirm(rootPlan(['tracker', 'lint']));
  mc.apply(plan);
  const after = texts(root);
  const outcome = mc.apply(plan);
  assert.deepEqual(get(outcome, 'files_written'), []);
  assert.deepEqual(texts(root), after);
  const settings = readJson(join(root, '.claude/settings.local.json'));
  const allow = get(get(settings, 'permissions'), 'allow') as string[];
  assert.equal(allow.length, new Set(allow).size);
});

test('test_conflict_without_resolution_refuses_all_writes', () => {
  const root = ensureApplyRoot();
  const plan = confirm(rootPlan(['blocked', 'tracker']));
  const before = texts(root);
  const caught = throwsRegex(() => mc.apply(plan));
  assert.ok(caught.message.includes('blocked'));
  assert.deepEqual(texts(root), before);
});

test('test_keep_resolution_writes_nothing', () => {
  const root = ensureApplyRoot();
  const resolutions: Record<string, Dict> = {};
  for (const client of mc.CLIENTS) {
    resolutions[`moved ${client}`] = { kind: 'keep' };
  }
  const plan = confirm(rootPlan(['moved']), resolutions);
  const before = texts(root);
  const outcome = mc.apply(plan);
  assert.deepEqual(get(outcome, 'files_written'), []);
  assert.deepEqual(texts(root), before);
});

test('test_reenable_resolution_clears_only_the_named_disable', () => {
  const root = ensureApplyRoot();
  const resolutions: Record<string, Dict> = {};
  for (const client of mc.CLIENTS) {
    resolutions[`blocked ${client}`] = { kind: 'reenable' };
  }
  const plan = confirm(rootPlan(['blocked']), resolutions);
  const outcome = mc.apply(plan);
  assert.deepEqual(
    new Set(get(outcome, 'files_written') as string[]),
    new Set([
      '.claude/settings.local.json',
      '.codex/config.toml',
      'opencode.json',
    ]),
  );
  const settings = readJson(join(root, '.claude/settings.local.json'));
  assert.ok(
    !(get(settings, 'disabledMcpjsonServers') as string[]).includes('blocked'),
  );
  assert.ok(
    (get(get(settings, 'permissions'), 'allow') as string[]).includes(
      'mcp__blocked',
    ),
  );
  const codex = tomlLoads(
    readFileSync(join(root, '.codex/config.toml'), 'utf8'),
  );
  assert.equal(get(get(get(codex, 'mcp_servers'), 'blocked'), 'enabled'), true);
  assert.equal(
    get(get(get(codex, 'mcp_servers'), 'blocked'), 'url'),
    'https://blocked.example.test/mcp',
  );
  const opencode = readJson(join(root, 'opencode.json'));
  assert.equal(
    get(get(get(opencode, 'mcp'), 'blocked'), 'enabled'),
    true,
  );
});

test('test_replace_resolution_overwrites_only_the_named_entry', () => {
  const root = ensureApplyRoot();
  const resolutions: Record<string, Dict> = {};
  for (const client of mc.CLIENTS) {
    resolutions[`moved ${client}`] = { kind: 'replace' };
  }
  const plan = confirm(rootPlan(['moved']), resolutions);
  mc.apply(plan);
  const claude = readJson(join(root, '.mcp.json'));
  assert.equal(
    get(get(get(claude, 'mcpServers'), 'moved'), 'url'),
    'https://moved.example.test/mcp',
  );
  const codex = tomlLoads(
    readFileSync(join(root, '.codex/config.toml'), 'utf8'),
  );
  assert.deepEqual(toPlain(get(get(codex, 'mcp_servers'), 'moved')), {
    url: 'https://moved.example.test/mcp',
  });
  assert.deepEqual(toPlain(get(get(codex, 'mcp_servers'), 'unrelated')), {
    command: 'secret-runner',
    env: { API_KEY: SENTINEL },
  });
  const opencode = readJson(join(root, 'opencode.json'));
  assert.equal(
    get(get(get(get(opencode, 'mcp'), 'servers'), 'moved'), 'url'),
    'https://moved.example.test/mcp',
  );
});

test('test_shadowed_replace_consolidates_layers', () => {
  const root = ensureApplyRoot();
  const plan = confirm(rootPlan({ shadowed: { clients: ['opencode'] } }), {
    'shadowed opencode': { kind: 'replace' },
  });
  mc.apply(plan);
  const opencode = readJson(join(root, 'opencode.json'));
  const mcpKeys = keysOf(get(opencode, 'mcp')).filter((key) => key !== 'servers');
  assert.ok(!mcpKeys.includes('shadowed'));
  assert.deepEqual(
    toPlain(get(get(get(opencode, 'mcp'), 'servers'), 'shadowed')),
    { type: 'remote', url: 'https://shadow.example.test/mcp' },
  );
});

test('test_reuse_and_approval_grant_write_nothing_else', () => {
  const root = ensureApplyRoot();
  const plan = confirm(rootPlan(['memory']));
  const before = texts(root);
  const outcome = mc.apply(plan);
  assert.deepEqual(get(outcome, 'files_written'), ['.claude/settings.local.json']);
  const after = texts(root);
  assert.equal(after['.mcp.json'], before['.mcp.json']);
  assert.equal(after['.codex/config.toml'], before['.codex/config.toml']);
  assert.equal(after['opencode.json'], before['opencode.json']);
  const settings = readJson(join(root, '.claude/settings.local.json'));
  assert.ok(
    (get(get(settings, 'permissions'), 'allow') as string[]).includes('mcp__mem'),
  );
});

test('test_approvals_stay_scoped_and_preserve_unrelated_entries', () => {
  const root = ensureApplyRoot();
  const resolutions: Record<string, Dict> = {};
  for (const client of mc.CLIENTS) {
    resolutions[`blocked ${client}`] = { kind: 'reenable' };
  }
  const plan = confirm(
    rootPlan(['memory', 'tracker', 'lint', 'blocked']),
    resolutions,
  );
  mc.apply(plan);
  const settings = readJson(join(root, '.claude/settings.local.json'));
  const allow = get(get(settings, 'permissions'), 'allow') as string[];
  assert.deepEqual(allow.slice(0, 2), ['mcp__unrelated', 'Bash(git status)']);
  assert.deepEqual(
    new Set(
      allow.filter(
        (item) => !['mcp__unrelated', 'Bash(git status)'].includes(item),
      ),
    ),
    new Set(['mcp__mem', 'mcp__tracker', 'mcp__lint', 'mcp__blocked']),
  );
  assert.deepEqual(
    toPlain(get(get(settings, 'permissions'), 'deny')),
    ['WebFetch(domain:example.test)'],
  );
  assert.ok(!has(settings, 'enableAllProjectMcpServers'));
  assert.deepEqual(toPlain(get(settings, 'statusLine')), {
    type: 'command',
    command: 'fixture-status',
  });
  assert.deepEqual(toPlain(get(settings, 'enabledMcpjsonServers')), ['mem']);
});

test('test_bare_project_creates_destination_files', () => {
  const temp = makeTemp();
  try {
    const bare = join(temp, 'bare');
    cpSync(APPLY_BARE, bare, { recursive: true });
    const plan = confirm(rootPlan(['tracker', 'lint'], { root: bare }));
    const outcome = mc.apply(plan);
    assert.deepEqual(
      new Set(get(outcome, 'files_written') as string[]),
      new Set(DESTINATIONS),
    );
    const claude = readJson(join(bare, '.mcp.json'));
    assert.equal(
      get(get(get(claude, 'mcpServers'), 'tracker'), 'url'),
      'https://tracker.example.test/mcp',
    );
    const codex = tomlLoads(
      readFileSync(join(bare, '.codex/config.toml'), 'utf8'),
    );
    assert.equal(
      get(get(get(codex, 'mcp_servers'), 'lint'), 'command'),
      'lint-mcp',
    );
    const opencode = readJson(join(bare, 'opencode.json'));
    assert.equal(
      get(get(get(get(opencode, 'mcp'), 'servers'), 'tracker'), 'type'),
      'remote',
    );
    const settings = readJson(join(bare, '.claude/settings.local.json'));
    assert.deepEqual(toPlain(settings), {
      permissions: { allow: ['mcp__lint', 'mcp__tracker'] },
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('test_tracked_files_are_edited_without_git_consultation', () => {
  const root = ensureApplyRoot();
  const git = (args: string[]): void => {
    const result = spawnSync('git', args, { cwd: root });
    assert.equal(result.status, 0, String(result.stderr));
  };
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=test@example.test', '-c', 'user.name=test',
    'commit', '-qm', 'fixture']);
  const plan = confirm(rootPlan(['tracker']));
  const outcome = mc.apply(plan);
  assert.ok((get(outcome, 'files_written') as string[]).includes('.mcp.json'));
  const diff = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.ok((diff.stdout as string).includes('.mcp.json'));
});

test('test_jsonc_destination_refuses_without_changing_files', () => {
  const root = ensureApplyRoot();
  const path = join(root, 'opencode.json');
  writeFileSync(path, '{"mcp": /* pinned */ {}}\n');
  const plan = confirm(rootPlan(['tracker']));
  const caught = throwsRegex(() => mc.apply(plan));
  assert.ok(caught.message.includes('opencode.json'));
  assert.equal(
    readFileSync(path, 'utf8'),
    '{"mcp": /* pinned */ {}}\n',
  );
});

test('test_apply_preserves_unrelated_toml_dates', () => {
  // Re-parsing an untouched [unrelated] table must not read as a
  // change: a pyEq that cannot compare TomlDates refuses the edit.
  const temp = makeTemp();
  try {
    const bare = join(temp, 'bare');
    cpSync(APPLY_BARE, bare, { recursive: true });
    const toml =
      '[unrelated]\n' +
      'day = 1979-05-27\n' +
      'at = 07:32:00\n' +
      'stamp = 1979-05-27T07:32:00Z\n';
    const codex = join(bare, '.codex', 'config.toml');
    mkdirSync(dirname(codex), { recursive: true });
    writeFileSync(codex, toml);
    const outcome = mc.apply(
      confirm(rootPlan(['tracker'], { root: bare })),
    );
    assert.ok(
      (get(outcome, 'files_written') as string[]).includes(
        '.codex/config.toml',
      ),
    );
    assert.ok(readFileSync(codex, 'utf8').startsWith(toml));
    const parsed = tomlLoads(readFileSync(codex, 'utf8'));
    assert.ok(has(parsed, 'unrelated'));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('test_toml_dates_compare_by_kind_and_value', () => {
  const load = (text: string): unknown => get(tomlLoads(text), 'd');
  const date = load('d = 1979-05-27');
  const time = load('d = 07:32:00');
  const stamp = load('d = 1979-05-27T07:32:00Z');
  const local = load('d = 1979-05-27T07:32:00');
  // Two parses of the same calendar token compare equal.
  assert.ok(mc.pyEq(date, load('d = 1979-05-27')));
  assert.ok(mc.pyEq(time, load('d = 07:32:00')));
  assert.ok(mc.pyEq(stamp, load('d = 1979-05-27T07:32:00Z')));
  assert.ok(mc.pyEq(local, load('d = 1979-05-27T07:32:00')));
  // Python keeps the kinds distinct: a date is not a time or
  // datetime, and a naive datetime never equals an aware one.
  assert.ok(!mc.pyEq(date, time));
  assert.ok(!mc.pyEq(date, stamp));
  assert.ok(!mc.pyEq(time, stamp));
  assert.ok(!mc.pyEq(local, stamp));
  // A TomlDate is never equal to a string or number.
  assert.ok(!mc.pyEq(date, '1979-05-27'));
  assert.ok(!mc.pyEq('1979-05-27', date));
  assert.ok(!mc.pyEq(stamp, '1979-05-27T07:32:00Z'));
  assert.ok(!mc.pyEq(time, 732));
});

// --- CliTests ---------------------------------------------------------------

let cliTemp: string | null = null;
let cliRoot: string | null = null;
let cliMachineFile: string | null = null;
let cliMappingFile: string | null = null;

function cliSetup(): void {
  cliTemp = makeTemp();
  cliRoot = join(cliTemp, 'project');
  cpSync(APPLY_PROJECT, cliRoot, { recursive: true });
  cliMachineFile = join(cliTemp, 'machine.json');
  writeFileSync(
    cliMachineFile,
    JSON.stringify({
      ...APPLY_MACHINE,
      env: [...APPLY_MACHINE.env].sort(),
      executables: [...APPLY_MACHINE.executables].sort(),
    }),
  );
  cliMappingFile = join(cliTemp, 'mapping.json');
  writeFileSync(cliMappingFile, JSON.stringify(APPLY_MAPPING));
}

function cliTeardown(): void {
  if (cliTemp) rmSync(cliTemp, { recursive: true, force: true });
  cliTemp = cliRoot = cliMachineFile = cliMappingFile = null;
}

function buildPlanFile(
  selections: string[] = ['tracker', 'lint'],
): string {
  const selectionsFile = join(cliTemp as string, 'selections.json');
  writeFileSync(selectionsFile, JSON.stringify(selections));
  const planFile = join(cliTemp as string, 'plan.json');
  const [code, out, err] = runCli([
    'plan',
    '--root',
    cliRoot as string,
    '--mapping',
    cliMappingFile as string,
    '--machine',
    cliMachineFile as string,
    '--selections',
    selectionsFile,
    '--out',
    planFile,
  ]);
  assert.equal(code, 0, err);
  assert.equal(out, '');
  return planFile;
}

test('test_check_emits_a_redacted_report_and_writes_nothing', () => {
  cliSetup();
  try {
    const machine = join(cliTemp as string, 'inspect-machine.json');
    writeFileSync(
      machine,
      JSON.stringify({
        ...MACHINE,
        env: [...MACHINE.env].sort(),
        executables: [...MACHINE.executables].sort(),
      }),
    );
    const mapping = join(cliTemp as string, 'inspect-mapping.json');
    writeFileSync(mapping, JSON.stringify(MAPPING));
    const listFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return listFiles(path);
        return [path];
      });
    const files = listFiles(PROJECT).filter((p) => lstatSync(p).isFile());
    const before = new Map(files.map((p) => [p, readFileSync(p)]));
    const [code, out] = runCli([
      'check',
      '--root',
      PROJECT,
      '--clients',
      'claude,codex,opencode',
      '--mapping',
      mapping,
      '--machine',
      machine,
    ]);
    assert.equal(code, 0);
    assert.ok(!out.includes(SENTINEL));
    const report = readJsonText(out);
    const states = new Map<string, string>();
    for (const entry of report['results'] as Record<string, unknown>[]) {
      states.set(
        `${entry['service']} ${entry['client']}`,
        entry['state'] as string,
      );
    }
    assert.equal(states.get('basic-memory claude'), 'satisfied');
    assert.equal(states.get('issue-tracker codex'), 'auth-unverified');
    for (const p of files) {
      assert.ok(readFileSync(p).equals(before.get(p) as Buffer));
    }
  } finally {
    cliTeardown();
  }
});

function readJsonText(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

test('test_check_without_manifest_reports_no_requirements', () => {
  const [code, out] = runCli(['check', '--root', join(FIXTURES, 'no-manifest')]);
  assert.equal(code, 0);
  const report = readJsonText(out);
  assert.equal(
    (report['manifest'] as Record<string, unknown>)['present'],
    false,
  );
  assert.ok(
    ((report['manifest'] as Record<string, unknown>)['note'] as string).includes(
      'no MCP requirements',
    ),
  );
  assert.deepEqual(report['results'], []);
});

test('test_plan_then_apply_via_files_is_idempotent', () => {
  cliSetup();
  try {
    const planFile = buildPlanFile();
    const plan = readJsonText(readFileSync(planFile, 'utf8'));
    assert.equal(plan['confirmed'], false);
    // An unconfirmed plan refuses even with --confirm.
    let [code, , err] = runCli(['apply', '--plan', planFile, '--confirm']);
    assert.equal(code, 1);
    assert.ok(err.includes('confirm'));
    // The owner acknowledges the reviewed plan; apply then succeeds.
    plan['confirmed'] = true;
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    let out: string;
    [code, out, err] = runCli(['apply', '--plan', planFile, '--confirm']);
    assert.equal(code, 0, err);
    let outcome = readJsonText(out);
    assert.deepEqual(
      new Set(outcome['files_written'] as string[]),
      new Set(DESTINATIONS),
    );
    const claude = readJsonText(
      readFileSync(join(cliRoot as string, '.mcp.json'), 'utf8'),
    );
    assert.equal(
      (
        (claude['mcpServers'] as Record<string, unknown>)['tracker'] as
          Record<string, unknown>
      )['url'],
      'https://tracker.example.test/mcp',
    );
    // The refreshed plan file re-applies as a verified no-op.
    [code, out, err] = runCli(['apply', '--plan', planFile, '--confirm']);
    assert.equal(code, 0, err);
    outcome = readJsonText(out);
    assert.deepEqual(outcome['files_written'], []);
  } finally {
    cliTeardown();
  }
});

test('test_apply_without_confirm_flag_refuses', () => {
  cliSetup();
  try {
    const planFile = buildPlanFile();
    const before = Object.fromEntries(
      DESTINATIONS.map((rel) => [
        rel,
        readFileSync(join(cliRoot as string, rel)),
      ]),
    );
    const [code, , err] = runCli(['apply', '--plan', planFile]);
    assert.equal(code, 1);
    assert.ok(err.includes('--confirm'));
    for (const rel of DESTINATIONS) {
      assert.ok(
        readFileSync(join(cliRoot as string, rel)).equals(
          before[rel] as Buffer,
        ),
      );
    }
  } finally {
    cliTeardown();
  }
});

test('test_apply_refuses_a_stale_plan_naming_the_file', () => {
  cliSetup();
  try {
    const planFile = buildPlanFile(['tracker']);
    const plan = readJsonText(readFileSync(planFile, 'utf8'));
    plan['confirmed'] = true;
    writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
    const target = join(cliRoot as string, '.mcp.json');
    const mutated = readFileSync(target, 'utf8').replace(
      '"unrelated"',
      '"owner-edit"',
    );
    writeFileSync(target, mutated);
    const [code, , err] = runCli(['apply', '--plan', planFile, '--confirm']);
    assert.equal(code, 1);
    assert.ok(err.includes('.mcp.json'));
    assert.equal(readFileSync(target, 'utf8'), mutated);
  } finally {
    cliTeardown();
  }
});

test('test_unknown_client_is_a_usage_error', () => {
  const [code] = runCli(['check', '--clients', 'vim']);
  assert.equal(code, 2);
});

test('test_cli_runs_as_a_script', () => {
  const proc = spawnSync(
    process.execPath,
    [SCRIPT, 'check', '--root', PROJECT, '--clients', 'claude'],
    { encoding: 'utf8' },
  );
  assert.equal(proc.status, 0, proc.stderr);
  assert.ok(!(proc.stdout as string).includes(SENTINEL));
  const report = JSON.parse(proc.stdout as string);
  assert.deepEqual(
    new Set(
      (report['results'] as Record<string, unknown>[]).map(
        (entry) => entry['client'],
      ),
    ),
    new Set(['claude']),
  );
});

// --- ReviewFindingTests -----------------------------------------------------

function reviewSetup(): void {
  cliSetup();
}

function writeMalformedDestinations(root: string): void {
  writeFileSync(
    join(root, '.codex', 'config.toml'),
    '[mcp_servers.good]\nurl = "https://good.example.test/mcp"\n' +
      '\n[mcp_servers.bad]\nurl = "https://x.example.test/mcp"\n' +
      'env_vars = true\n' +
      '\n[mcp_servers.leaky]\n' +
      `url = "https://h:${REVIEW_SENTINEL}/mcp"\n`,
  );
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        'claude-good': {
          type: 'http',
          url: 'https://good.example.test/mcp',
        },
        'claude-bad': {
          type: 'http',
          url: `https://h:${REVIEW_SENTINEL}/mcp`,
        },
      },
    }),
  );
  writeFileSync(
    join(root, 'opencode.json'),
    JSON.stringify({
      mcp: {
        servers: {
          'oc-good': {
            type: 'remote',
            url: 'https://good.example.test/mcp',
          },
          'oc-bad': {
            type: 'remote',
            url: `https://h:${REVIEW_SENTINEL}/mcp`,
          },
        },
      },
    }),
  );
}

test('test_secret_value_argument_is_refused_not_copied', () => {
  cliSetup();
  try {
    const machine = {
      ...APPLY_MACHINE,
      secret_values: new Set([REVIEW_SENTINEL]),
      local_config_refs: {
        ...APPLY_MACHINE.local_config_refs,
        LINT_MCP_COMMAND: {
          command: ['lint-mcp', '--stdio', REVIEW_SENTINEL],
        },
      },
    };
    const plan = rootPlan(['lint'], { root: cliRoot, machine });
    for (const client of mc.CLIENTS) {
      const entry = action(plan, 'lint', client);
      assert.equal(get(entry, 'action'), 'unsupported');
      assert.equal(get(entry, 'entry'), null);
    }
    assert.ok(!jsonDumps(plan).includes(REVIEW_SENTINEL));
    const outcome = mc.apply(confirm(plan));
    assert.deepEqual(get(outcome, 'files_written'), []);
    const codexText = readFileSync(
      join(cliRoot as string, '.codex', 'config.toml'),
      'utf8',
    );
    assert.ok(!codexText.includes(REVIEW_SENTINEL));
    assert.ok(!has(tomlLoads(codexText)['mcp_servers'], 'lint'));
  } finally {
    cliTeardown();
  }
});

test('test_credential_flag_followed_by_value_is_refused', () => {
  cliSetup();
  try {
    const machine = {
      ...APPLY_MACHINE,
      local_config_refs: {
        ...APPLY_MACHINE.local_config_refs,
        LINT_MCP_COMMAND: {
          command: ['lint-mcp', '--stdio', '--backend-token', 'OPAQUE'],
        },
      },
    };
    const plan = rootPlan(['lint'], { root: cliRoot, machine });
    for (const client of mc.CLIENTS) {
      const entry = action(plan, 'lint', client);
      assert.equal(get(entry, 'action'), 'unsupported');
      const diagnostics = (get(entry, 'diagnostics') as string[]).join('\n');
      assert.ok(diagnostics.includes('--backend-token'));
      assert.ok(diagnostics.includes('credential'));
    }
    // The flag is named; the argument value never appears anywhere.
    assert.ok(!jsonDumps(plan).includes('OPAQUE'));
  } finally {
    cliTeardown();
  }
});

test('test_source_secret_args_refuse_translation', () => {
  cliSetup();
  try {
    const mapping = Object.fromEntries(
      mc.CLIENTS.map((client) => [client, 'newreg']),
    );
    const plan = rootPlan(
      { 'partner-api': {
        source: { client: 'claude', registration: 'unrelated' },
      } },
      {
        root: cliRoot,
        mapping: { 'partner-api': mapping },
        machine: { ...APPLY_MACHINE, secret_values: new Set([SENTINEL]) },
      },
    );
    // On the source's own client the same registration would be a
    // duplicate — a conflict; elsewhere the secret-bearing command
    // refuses translation outright. Both refuse to copy the args.
    const expected: Record<string, string> = {
      claude: 'conflict-needs-resolution',
      codex: 'unsupported',
      opencode: 'unsupported',
    };
    for (const client of mc.CLIENTS) {
      const entry = action(plan, 'partner-api', client);
      assert.equal(get(entry, 'action'), expected[client]);
      assert.ok(
        (get(entry, 'diagnostics') as string[]).some((d) =>
          d.includes('--api-key'),
        ),
      );
    }
    assert.ok(!jsonDumps(plan).includes(SENTINEL));
  } finally {
    cliTeardown();
  }
});

test('test_symlinked_destination_directory_is_refused', () => {
  cliSetup();
  try {
    const root = cliRoot as string;
    const external = join(cliTemp as string, 'external');
    mkdirSync(external);
    rmSync(join(root, '.codex'), { recursive: true, force: true });
    symlinkSync(external, join(root, '.codex'));
    const plan = confirm(rootPlan(['tracker', 'lint'], { root }));
    const before = texts(root);
    const caught = throwsRegex(() => mc.apply(plan));
    assert.ok(caught.message.includes('.codex/config.toml'));
    assert.ok(caught.message.includes('outside the project root'));
    assert.deepEqual(readdirSync(external), []);
    assert.deepEqual(texts(root), before);
  } finally {
    cliTeardown();
  }
});

test('test_sse_source_is_unsupported_not_silenced', () => {
  cliSetup();
  try {
    const root = cliRoot as string;
    const mcp = readJson(join(root, '.mcp.json'));
    set(get(mcp, 'mcpServers'), 'sse-src', {
      type: 'sse',
      url: 'https://sse.example.test/mcp',
      headers: { Authorization: 'Bearer ${SSE_TOKEN}' },
    });
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(toPlain(mcp), null, 2));
    const mapping = Object.fromEntries(
      mc.CLIENTS.map((client) => [client, 'newreg']),
    );
    const plan = rootPlan(
      { 'partner-api': {
        source: { client: 'claude', registration: 'sse-src' },
      } },
      { root, mapping: { 'partner-api': mapping } },
    );
    // On the source's own client the same registration would be a
    // duplicate — a conflict; elsewhere 'unsupported'. Never a silent
    // sse→http translation either way.
    const expected: Record<string, string> = {
      claude: 'conflict-needs-resolution',
      codex: 'unsupported',
      opencode: 'unsupported',
    };
    for (const client of mc.CLIENTS) {
      const entry = action(plan, 'partner-api', client);
      assert.equal(get(entry, 'action'), expected[client]);
      assert.equal(get(entry, 'entry'), null);
      assert.ok(
        (get(entry, 'diagnostics') as string[]).some(
          (d) => d.includes('sse') && d.includes('cannot be expressed'),
        ),
      );
    }
  } finally {
    cliTeardown();
  }
});

test('test_non_bearer_authorization_is_untranslated_not_carried', () => {
  cliSetup();
  try {
    const root = cliRoot as string;
    const opencode = readJson(join(root, 'opencode.json'));
    set(get(get(opencode, 'mcp'), 'servers'), 'basic-src', {
      type: 'remote',
      url: 'https://basic.example.test/mcp',
      headers: { Authorization: 'Basic {env:TRACKER_API_TOKEN}' },
    });
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify(toPlain(opencode), null, 2),
    );
    const mapping = Object.fromEntries(
      mc.CLIENTS.map((client) => [client, 'newreg']),
    );
    const plan = rootPlan(
      { 'partner-api': {
        source: { client: 'opencode', registration: 'basic-src' },
      } },
      { root, mapping: { 'partner-api': mapping } },
    );
    // On the source's own client the same registration would be a
    // duplicate — a conflict; the others stay 'add'. Either way the
    // untranslated Authorization is listed, not dropped, and the
    // translated entry carries no auth at all.
    const expected: Record<string, string> = {
      claude: 'add',
      codex: 'add',
      opencode: 'conflict-needs-resolution',
    };
    for (const client of mc.CLIENTS) {
      const entry = action(plan, 'partner-api', client);
      assert.equal(get(entry, 'action'), expected[client]);
      assert.ok(
        (get(entry, 'untranslated') as string[]).some((item) =>
          item.includes('Authorization'),
        ),
      );
      assert.ok(
        (get(entry, 'diagnostics') as string[]).some((d) =>
          d.includes('Authorization'),
        ),
      );
      assert.ok(!has(get(entry, 'entry'), 'headers'));
      assert.ok(!has(get(entry, 'entry'), 'bearer_token_env_var'));
      assert.ok(!jsonDumps(get(entry, 'entry')).includes('TRACKER_API_TOKEN'));
    }
  } finally {
    cliTeardown();
  }
});

test('test_mismatched_bearer_env_is_untranslated_not_swapped', () => {
  cliSetup();
  try {
    const root = cliRoot as string;
    // The manifest declares TRACKER_API_TOKEN; a source Bearer ref to a
    // different env name is reported, not silently adopted.
    const opencode = readJson(join(root, 'opencode.json'));
    set(get(get(opencode, 'mcp'), 'servers'), 'tracker-src', {
      type: 'remote',
      url: 'https://tracker.example.test/mcp',
      headers: { Authorization: 'Bearer {env:PARTNER_TOKEN}' },
    });
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify(toPlain(opencode), null, 2),
    );
    const mapping = Object.fromEntries(
      mc.CLIENTS.map((client) => [client, 'newreg']),
    );
    const plan = rootPlan(
      { tracker: {
        source: { client: 'opencode', registration: 'tracker-src' },
      } },
      { root, mapping: { tracker: mapping } },
    );
    const expected: Record<string, string> = {
      claude: 'add',
      codex: 'add',
      opencode: 'conflict-needs-resolution',
    };
    for (const client of mc.CLIENTS) {
      const entry = action(plan, 'tracker', client);
      assert.equal(get(entry, 'action'), expected[client]);
      assert.ok(
        (get(entry, 'untranslated') as string[]).some((item) =>
          item.includes('Authorization'),
        ),
      );
      assert.ok(!jsonDumps(get(entry, 'entry')).includes('PARTNER_TOKEN'));
    }
    assert.deepEqual(
      toPlain(get(get(action(plan, 'tracker', 'claude'), 'entry'), 'headers')),
      { Authorization: 'Bearer ${TRACKER_API_TOKEN}' },
    );
    assert.equal(
      get(
        get(action(plan, 'tracker', 'codex'), 'entry'),
        'bearer_token_env_var',
      ),
      'TRACKER_API_TOKEN',
    );
    assert.deepEqual(
      toPlain(
        get(get(action(plan, 'tracker', 'opencode'), 'entry'), 'headers'),
      ),
      { Authorization: 'Bearer {env:TRACKER_API_TOKEN}' },
    );
  } finally {
    cliTeardown();
  }
});

test('test_wildcard_mapping_name_is_refused_at_input', () => {
  cliSetup();
  try {
    const mapping = JSON.parse(JSON.stringify(APPLY_MAPPING));
    mapping['tracker'] = { ...mapping['tracker'], codex: '*' };
    const caught = throwsRegex(() =>
      rootPlan(['tracker'], { root: cliRoot, mapping }),
    );
    assert.ok(caught.message.includes('*'));
    throwsRegex(() =>
      mc.assess(PROJECT, {
        machine: MACHINE as unknown as Dict,
        mapping: { 'basic-memory': { claude: '*' } },
      }),
    );
  } finally {
    cliTeardown();
  }
});

test('test_plan_validation_rejects_bad_names_and_approvals', () => {
  cliSetup();
  try {
    const base = confirm(rootPlan(['memory'], { root: cliRoot }));
    const before = texts(cliRoot as string);
    for (const tampered of ['mcp__*', 'mcp__other', 'mcp__mem__*']) {
      const plan = pyJsonLoads(jsonDumps(base)) as Dict;
      set(action(plan, 'memory', 'claude'), 'approvals', [tampered]);
      throwsRegex(() => mc.apply(plan));
      assert.deepEqual(texts(cliRoot as string), before);
    }
    const plan = pyJsonLoads(jsonDumps(base)) as Dict;
    set(action(plan, 'memory', 'claude'), 'registration', '*');
    throwsRegex(() => mc.apply(plan));
    assert.deepEqual(texts(cliRoot as string), before);
  } finally {
    cliTeardown();
  }
});

test('test_malformed_entries_do_not_abort_unrelated_inspection', () => {
  cliSetup();
  try {
    writeMalformedDestinations(cliRoot as string);
    const snapshot = mc.inspectProject(cliRoot as string);
    const codexEntries = get(get(snapshot, 'codex'), 'entries');
    assert.ok(has(codexEntries, 'good'));
    assert.equal(get(get(codexEntries, 'bad'), 'inspection'), 'unknown');
    assert.equal(get(get(codexEntries, 'leaky'), 'inspection'), 'unknown');
    const claudeEntries = get(get(snapshot, 'claude'), 'entries');
    assert.ok(has(claudeEntries, 'claude-good'));
    assert.equal(
      get(get(claudeEntries, 'claude-bad'), 'inspection'),
      'unknown',
    );
    const opencodeEntries = get(get(snapshot, 'opencode'), 'entries');
    assert.ok(has(opencodeEntries, 'oc-good'));
    assert.equal(get(get(opencodeEntries, 'oc-bad'), 'inspection'), 'unknown');
    assert.ok(!jsonDumps(snapshot).includes(REVIEW_SENTINEL));
  } finally {
    cliTeardown();
  }
});

test('test_check_cli_completes_and_never_echoes_values', () => {
  cliSetup();
  try {
    writeMalformedDestinations(cliRoot as string);
    const [code, out, err] = runCli(['check', '--root', cliRoot as string]);
    assert.equal(code, 0, err);
    assert.ok(!out.includes(REVIEW_SENTINEL));
    assert.ok(!err.includes(REVIEW_SENTINEL));
    const report = JSON.parse(out) as Record<string, unknown>;
    const entries = (
      (report['clients'] as Record<string, unknown>)['codex'] as
        Record<string, unknown>
    )['entries'] as Record<string, Record<string, unknown>>;
    assert.ok('good' in entries);
    assert.equal(entries['bad']['inspection'], 'unknown');
    assert.equal(entries['leaky']['inspection'], 'unknown');
    assert.ok(
      (entries['leaky']['notes'] as string[]).some((note) =>
        note.includes('invalid port'),
      ),
    );
  } finally {
    cliTeardown();
  }
});

test('test_codex_trust_is_a_standing_prerequisite', () => {
  cliSetup();
  try {
    const report = mc.assess(cliRoot as string, {
      machine: APPLY_MACHINE as unknown as Dict,
      mapping: APPLY_MAPPING,
    });
    assert.ok(
      (get(report, 'prerequisites') as string[]).includes(mc.CODEX_TRUST_NOTE),
    );
    const narrowed = mc.assess(cliRoot as string, {
      machine: APPLY_MACHINE as unknown as Dict,
      mapping: APPLY_MAPPING,
      clients: ['claude'],
    });
    assert.ok(
      !(get(narrowed, 'prerequisites') as string[]).includes(
        mc.CODEX_TRUST_NOTE,
      ),
    );
    const plan = rootPlan(['tracker'], { root: cliRoot });
    assert.ok(
      (get(plan, 'prerequisites') as string[]).includes(mc.CODEX_TRUST_NOTE),
    );
    assert.ok(
      (get(action(plan, 'tracker', 'codex'), 'prerequisites') as string[]).includes(
        mc.CODEX_TRUST_NOTE,
      ),
    );
    const [code, out] = runCli(['check', '--root', cliRoot as string]);
    assert.equal(code, 0);
    assert.ok(out.includes('Codex project trust'));
  } finally {
    cliTeardown();
  }
});

test('test_double_underscore_mapping_name_is_refused_at_input', () => {
  // Claude reads mcp__victim__read as a tool grant on victim, so '__'
  // in a registration name must refuse before anything is planned.
  throwsRegex(
    () => mc.checkMapping({ tracker: { claude: 'victim__read' } }),
    /must not contain '__'/,
  );
});

test('test_double_underscore_name_is_refused_at_plan_build', () => {
  cliSetup();
  try {
    throwsRegex(
      () =>
        rootPlan(['tracker'], {
          root: cliRoot,
          mapping: { tracker: { claude: 'victim__read' } },
        }),
      /must not contain '__'/,
    );
  } finally {
    cliTeardown();
  }
});

test('test_double_underscore_persisted_plan_is_refused_at_apply', () => {
  cliSetup();
  try {
    const plan = rootPlan(['tracker'], {
      root: cliRoot,
      mapping: { tracker: { claude: 'ok' } },
    });
    confirm(plan);
    const entry = action(plan, 'tracker', 'claude');
    set(entry, 'registration', 'victim__read');
    set(entry, 'approvals', ['mcp__victim__read']);
    const before = texts(cliRoot as string);
    throwsRegex(
      () => mc.apply(plan, cliRoot as string),
      /must not contain '__'/,
    );
    assert.deepEqual(texts(cliRoot as string), before);
  } finally {
    cliTeardown();
  }
});

test('test_single_underscore_names_remain_valid', () => {
  assert.equal(mc.registrationNameProblem('basic_memory_nas'), null);
  assert.equal(mc.registrationNameProblem('x_y'), null);
  assert.ok(mc.registrationNameProblem('victim__read') !== null);
});
