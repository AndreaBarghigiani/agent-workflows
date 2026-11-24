/**
 * `node:test` counterpart of `tests/test_memory_preflight.py` (issue #114).
 * Test names keep the Python method names so the mapping in
 * docs/node-port.md stays one-to-one.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as installer from '../scripts/install.ts';
import { jsonDumpsDefault } from '../scripts/memory_connections.ts';
import { pyJsonLoads } from '../scripts/lib/pyloads.ts';
import * as preflight from '../scripts/memory_preflight.ts';
import * as setup from '../scripts/setup_memory.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFLIGHT_SCRIPT = join(ROOT, 'scripts/memory_preflight.ts');

const CONFIG = `schema_version = 2
[project]
id = "pilot"
[memory]
write_project = "pilot"
search_projects = ["pilot"]
related_projects = []
mcp_server = "basic_memory_test"
`;
const LEGACY = 'd1f5c5265254de258fd928228291c261fb4c99b6';

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', [...(cwd ? ['-C', cwd] : []), ...args], {
    encoding: 'utf8',
  });
}

/** Every regular file under `root`, like the Python suite's rglob map. */
function treeBytes(root: string): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const walk = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory)) {
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

class Consumer {
  temp: string;
  root: string;
  library: string;

  constructor(cleanup: (fn: () => void) => void) {
    this.temp = mkdtempSync(join(tmpdir(), 'memory-preflight-'));
    this.root = join(this.temp, 'consumer');
    mkdirSync(this.root, { recursive: true });
    writeText(join(this.root, 'AGENTS.md'), '# Consumer\n');
    this.library = join(this.root, '.agent-workflows');
    cpSync(
      join(ROOT, '.agents/skills'),
      join(this.library, '.agents/skills'),
      { recursive: true },
    );
    installer.write_capabilities(this.root, 'enabled');
    writeText(join(this.root, '.agents/memory/config.toml'), CONFIG);
    cleanup(() => rmSync(this.temp, { recursive: true, force: true }));
  }

  /** `upstream(ref, names, source)` — a local upstream install plus lock. */
  upstream(
    ref: unknown,
    names: readonly string[] = installer.RETIRED_MEMORY_SKILLS,
    source = preflight.UPSTREAM,
  ): void {
    const entries: Record<string, Record<string, unknown>> = {};
    for (const name of names) {
      const skill = join(this.root, '.agents/skills', name);
      mkdirSync(skill, { recursive: true });
      writeFileSync(join(skill, 'SKILL.md'), `# ${name}\n`);
      const entry: Record<string, unknown> = {
        source,
        sourceType: 'github',
      };
      if (ref) entry['ref'] = ref;
      entries[name] = entry;
    }
    const lock = join(this.root, installer.SKILLS_LOCK);
    const current = existsSync(lock)
      ? ((pyJsonLoads(readText(lock)) as Map<string, unknown>).get(
          'skills',
        ) as Record<string, unknown>)
      : {};
    const currentEntries =
      current instanceof Map ? Object.fromEntries(current) : { ...current };
    writeText(
      lock,
      jsonDumpsDefault({
        version: 2,
        skills: { ...currentEntries, ...entries },
      }),
    );
  }

  verdict(server: string | null = null): [string, string] {
    const record = preflight.preflight(this.root, server);
    return [
      record['verdict'] as string,
      (record['reasons'] as string[]).join(' '),
    ];
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

test('test_matching_and_mismatched_releases', withConsumer((c) => {
  c.upstream('v1.0.0');
  let [verdict, reason] = c.verdict('1.0.0');
  assert.equal(verdict, 'compatible');
  assert.match(reason, /not checked/);
  assert.equal(c.verdict('v1.0.0')[0], 'compatible');
  [verdict, reason] = c.verdict('0.23.2');
  assert.equal(verdict, 'incompatible');
  assert.match(reason, /unknown tool/);
  c.upstream(LEGACY);
  assert.equal(c.verdict('0.23.2')[0], 'compatible');
  assert.equal(c.verdict('0.24.1')[0], 'compatible');
  assert.equal(c.verdict('1.0.0')[0], 'incompatible');
}));

test('test_unknowns_are_never_reported_as_compatible', withConsumer((c) => {
  assert.equal(c.verdict('1.0.0')[0], 'unknown'); // no skills at all
  c.upstream('v1.0.0');
  const [verdict, reason] = c.verdict();
  assert.equal(verdict, 'unknown');
  assert.match(reason, /--server-release/);
  // Only the reviewed releases count; neighbours are not assumed.
  for (const unreviewed of [
    '1.0.1', '1.1.0', '2.0.0', '0.22.0', '0.1.0', 'latest',
    '01.0.0', '1.0', '',
  ]) {
    assert.equal(c.verdict(unreviewed)[0], 'unknown', unreviewed);
  }
  for (const ref of [
    null, 'main', 'v1.0.1', 'v1.1.0', 'v0.23.2', '1.0.0', 'd1f5c52',
    '0123456789abcdef0123456789abcdef01234567', 123, ['v1.0.0'], true,
  ]) {
    c.upstream(ref);
    assert.equal(c.verdict('1.0.0')[0], 'unknown', String(ref));
    assert.equal(c.verdict('0.23.2')[0], 'unknown', String(ref));
  }
  c.upstream('v1.0.0', undefined, 'someone/else');
  assert.equal(c.verdict('1.0.0')[0], 'unknown');
}));

test('test_mixed_missing_and_broken_skills', withConsumer((c) => {
  c.upstream('v1.0.0');
  c.upstream(LEGACY, ['memory-notes']);
  let [verdict, reason] = c.verdict('1.0.0');
  assert.equal(verdict, 'incompatible');
  assert.match(reason, /different tool surfaces/);
  rmSync(join(c.root, '.agents/skills/memory-notes'), { recursive: true });
  [verdict, reason] = c.verdict('1.0.0');
  assert.equal(verdict, 'unknown');
  assert.match(reason, /memory-notes \(missing\)/);
  symlinkSync(
    '../../.agent-workflows/.agents/skills/memory-notes',
    join(c.root, '.agents/skills/memory-notes'),
  );
  assert.match(c.verdict('1.0.0')[1], /broken link/);
}));

test('test_declined_and_unrecorded_choices_are_not_applicable', withConsumer((c) => {
  c.upstream('v1.0.0');
  for (const choice of ['declined', null] as const) {
    if (choice) {
      installer.write_capabilities(c.root, choice);
    } else {
      unlinkSync(join(c.root, installer.CAPABILITIES_FILE));
    }
    const record = preflight.preflight(c.root, '0.23.2');
    assert.equal(record['verdict'], 'not applicable');
    assert.ok(!('skills' in record));
  }
}));

test('test_record_reports_instruction_state_and_writes_nothing', withConsumer((c) => {
  c.upstream('v1.0.0');
  const before = treeBytes(c.root);
  const record = preflight.preflight(c.root, '1.0.0');
  assert.equal(record['generated_instructions'], 'missing');
  assert.equal(record['library_pin'], null); // a plain copy is not a pin
  git(['init', '-q', c.root]);
  assert.equal(preflight.preflight(c.root, '1.0.0')['library_pin'], null);
  git(['init', '-q', c.library]);
  git(
    [
      '-c', 'user.name=t', '-c', 'user.email=t@example.invalid',
      'commit', '-q', '--allow-empty', '-m', 'pin',
    ],
    c.library,
  );
  const pin = git(['rev-parse', 'HEAD'], c.library).trim();
  assert.equal(preflight.preflight(c.root, '1.0.0')['library_pin'], pin);
  rmSync(join(c.library, '.git'), { recursive: true });
  rmSync(join(c.root, '.git'), { recursive: true });
  assert.equal(
    (record['skills'] as Record<string, Record<string, unknown>>)[
      'memory-schema'
    ]['ref'],
    'v1.0.0',
  );
  assert.ok(treeEqual(before, treeBytes(c.root)));
  const generated = setup.expected_instructions(c.root)[0];
  const instructions = join(c.root, '.agents/memory/config.md');
  writeText(instructions, generated + '\nLocal note.\n');
  assert.equal(
    preflight.preflight(c.root)['generated_instructions'],
    'customized',
  );
  writeText(instructions, setup.previous_generated(generated)[0]);
  assert.equal(
    preflight.preflight(c.root)['generated_instructions'],
    'stale',
  );
}));

test('test_cli_exit_codes_and_unreadable_lock', withConsumer((c) => {
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [PREFLIGHT_SCRIPT, '--project', c.root, ...args],
      { encoding: 'utf8' },
    );
  c.upstream('v1.0.0');
  assert.equal(run('--server-release', '1.0.0').status, 0);
  assert.equal(run('--server-release', '0.23.2').status, 3);
  assert.equal(run('--no-such-flag').status, 2); // usage, not a verdict
  let result = run();
  assert.equal(result.status, 4);
  assert.equal(
    (pyJsonLoads(result.stdout) as Map<string, unknown>).get('verdict'),
    'unknown',
  );
  assert.match(result.stderr, /does not assess MCP connectivity/);
  writeText(join(c.root, installer.SKILLS_LOCK), '{broken');
  result = run('--server-release', '1.0.0');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unreadable skills-lock\.json/);
  // A JSON scalar is not a dict either: `float.get` fails like Python's.
  writeText(join(c.root, installer.SKILLS_LOCK), '1.5\n');
  result = run('--server-release', '1.0.0');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unreadable skills-lock\.json/);
  assert.match(result.stderr, /'float' object has no attribute 'get'/);
}));

test('test_cli_short_help_tails_print_help', () => {
  for (const arg of ['-h', '--help', '-hfoo', '-hh', '-hx']) {
    const result = spawnSync(process.execPath, [PREFLIGHT_SCRIPT, arg], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, arg);
    assert.match(result.stdout, /^usage: /);
  }
  // `=`-separated and `-`-leading remainders stay argparse errors.
  for (const arg of ['-h=foo', '-h-x']) {
    const result = spawnSync(process.execPath, [PREFLIGHT_SCRIPT, arg], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, arg);
    assert.match(result.stderr, /ignored explicit argument/);
  }
});
