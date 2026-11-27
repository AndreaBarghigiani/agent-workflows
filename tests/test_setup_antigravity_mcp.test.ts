import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeEntry, opencodeEntry } from '../scripts/memory_connections.ts';

const dispatcher = fileURLToPath(new URL('../bin/agent-workflows.ts', import.meta.url));
const endpoint = 'https://memory.example.test/mcp';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'antigravity-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.agents'));
  const path = join(root, '.agents/mcp_config.json');
  const write = (relativePath: string, data: unknown) =>
    writeFileSync(join(root, relativePath), JSON.stringify(data, null, 2) + '\n');
  writeFileSync(join(root, 'AGENTS.md'), '# Test\n');
  const manifest = (connection: unknown) => write('.agents/mcp-requirements.json', {
    version: 1,
    services: [{
      id: 'basic-memory',
      purpose: 'Project notes',
      required: true,
      workflows: ['*'],
      guidance: ['AGENTS.md'],
      connection,
      verification: { description: 'Read one project note', read_only: true },
    }],
  });
  const select = (source?: 'claude' | 'opencode') =>
    write('.agents/antigravity-mcp.json', {
      version: 1,
      services: {
        'basic-memory': {
          registration: 'basic_memory_nas',
          source: source && { client: source, registration: 'basic_memory_nas' },
        },
      },
    });
  const run = (...args: string[]) => spawnSync(
    process.execPath,
    [dispatcher, 'setup_antigravity_mcp', '--project', '.', ...args],
    { cwd: root, encoding: 'utf8' },
  );
  return { root, path, write, manifest, select, run };
}

test('portable registration is opt-in, check-only on request, and idempotent', (t) => {
  const f = fixture(t);
  f.manifest({ type: 'remote', url: endpoint });
  assert.equal(f.run().status, 0);
  assert.equal(existsSync(f.path), false);

  f.select();
  const check = f.run('--check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /registration is missing/);
  assert.equal(existsSync(f.path), false);

  const creation = f.run();
  assert.equal(creation.status, 0, creation.stderr);
  assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), {
    mcpServers: { basic_memory_nas: { serverUrl: endpoint } },
  });
  const before = statSync(f.path);
  assert.equal(f.run().status, 0);
  assert.equal(f.run('--check').status, 0);
  assert.equal(statSync(f.path).ino, before.ino);
  assert.equal(statSync(f.path).mtimeMs, before.mtimeMs);
});

for (const client of ['claude', 'opencode'] as const) {
  test(`creates registration from a freshly rendered no-auth ${client} connection`, (t) => {
    const f = fixture(t);
    f.manifest({ type: 'remote', local_config_ref: 'Machine memory connection' });
    f.select(client);
    assert.equal(f.run().status, 1);
    assert.equal(existsSync(f.path), false);

    const profile = { endpoint };
    if (client === 'claude') {
      f.write('.mcp.json', { mcpServers: { basic_memory_nas: claudeEntry(profile) } });
    } else {
      f.write('opencode.json', { mcp: { servers: { basic_memory_nas: opencodeEntry(profile) } } });
    }
    const creation = f.run();
    assert.equal(creation.status, 0, creation.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')), {
      mcpServers: { basic_memory_nas: { serverUrl: endpoint } },
    });
  });
}

test('preserves owner registrations and refuses existing files that need changes', (t) => {
  const f = fixture(t);
  f.manifest({ type: 'remote', url: endpoint });
  f.select();
  const unrelated = { serverUrl: 'https://other.example.test/mcp' };
  for (const [servers, status, diagnostic] of [
    [{ other: unrelated, basic_memory_nas: { serverUrl: endpoint } }, 0, /^$/],
    [{ other: unrelated, basic_memory_nas: unrelated }, 1, /conflict-needs-resolution/],
    [{ other: { serverUrl: endpoint } }, 1, /conflict-needs-resolution/],
    [{ basic_memory_nas: { serverUrl: endpoint, disabled: true } }, 1, /conflict-needs-resolution/],
    [{ other: unrelated }, 1, /existing .* is preserved/],
  ] as const) {
    f.write('.agents/mcp_config.json', { ownerSetting: true, mcpServers: servers });
    const before = readFileSync(f.path);
    const run = f.run();
    assert.equal(run.status, status, run.stderr);
    assert.match(run.stderr, diagnostic);
    assert.deepEqual(readFileSync(f.path), before);
  }
});

test('refuses credentials and unsafe URLs without emitting their values', (t) => {
  const f = fixture(t);
  f.select();
  for (const auth of [{ mechanism: 'oauth' }, { mechanism: 'api-key', credential_ref: 'TOKEN' }]) {
    f.manifest({ type: 'remote', url: endpoint, auth });
    const run = f.run();
    assert.equal(run.status, 1);
    assert.match(run.stderr, /requires a no-auth remote service/);
    assert.equal(existsSync(f.path), false);
  }

  f.manifest({ type: 'remote', local_config_ref: 'Machine memory connection' });
  f.select('claude');
  for (const entry of [
    claudeEntry({ endpoint, bearer_token_env: 'TEST_TOKEN' }),
    { type: 'http', url: endpoint, headers: { Authorization: 'Bearer secret-sentinel' } },
    { type: 'http', url: endpoint + '?token=secret-sentinel' },
    { type: 'http', url: endpoint + '/${TEST_TOKEN}' },
    { type: 'sse', url: endpoint },
    { type: 'stdio', command: 'test' },
  ]) {
    f.write('.mcp.json', { mcpServers: { basic_memory_nas: entry } });
    const run = f.run();
    assert.equal(run.status, 1, run.stderr);
    assert.doesNotMatch(run.stdout + run.stderr, /secret-sentinel|TEST_TOKEN/);
    assert.equal(existsSync(f.path), false);
  }
});

test('refuses a symlinked destination without touching its referent', (t) => {
  const f = fixture(t);
  f.manifest({ type: 'remote', url: endpoint });
  f.select();
  const owner = join(f.root, 'owner-config.json');
  writeFileSync(owner, 'owner\n');
  symlinkSync(owner, f.path);
  assert.equal(f.run().status, 1);
  assert.equal(readFileSync(owner, 'utf8'), 'owner\n');
});
