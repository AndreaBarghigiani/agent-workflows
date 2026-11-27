/**
 * `node:test` counterpart of `tests/test_install.py`, plus the install
 * cases `tests/test_milestone_delivery.py` collects in `DistributionTests`.
 * Test names keep the Python method names so the mapping in
 * docs/node-port.md stays one-to-one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ValueError } from '../scripts/lib/pyerrors.ts';
import type { GitResult } from '../scripts/lib/git.ts';
import { runGit } from '../scripts/lib/git.ts';
import * as installer from '../scripts/install.ts';
import type { InstallOptions } from '../scripts/install.ts';
import { compareTrees, fileTree } from './testlib/tree.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL_SCRIPT = join(ROOT, 'scripts/install.ts');
const RETIRED_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/retired-skills',
);

// -- Python-builtin mirrors used by the fixtures -----------------------------

function writeText(path: string, text: string): void {
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

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
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

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** `contextlib.redirect_stdout` for the installer helpers. */
function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.map((line) => `${line}\n`).join('');
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

function gitOk(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `git -C ${root} ${args.join(' ')}: ${result.stderr}`,
  );
  return (result.stdout as string).trim();
}

function commit(root: string, message: string): void {
  gitOk(
    root,
    '-c', 'user.name=Test',
    '-c', 'user.email=test@example.invalid',
    'commit', '-qm', message,
  );
}

// -- InstallTests ------------------------------------------------------------

describe('InstallTests', () => {
  const ctx = { tmp: '', base: '', project: '', source: '' };

  beforeEach(() => {
    ctx.tmp = mkdtempSync(join(tmpdir(), 'install-test-'));
    ctx.base = ctx.tmp;
    ctx.project = join(ctx.base, 'project');
    mkdirSync(ctx.project);
    writeText(join(ctx.project, 'AGENTS.md'), '# Consumer rules\n');
    ctx.source = join(ctx.project, '.agent-workflows');
    mkdirSync(ctx.source);
    const policy = join(ctx.source, 'docs/worktrees.md');
    mkdirSync(dirname(policy), { recursive: true });
    writeText(policy, '# Shared worktree policy\n');
    for (const name of [
      'shape-issue', 'review-issue', 'setup-basic-memory',
      'deliver-milestone',
    ]) {
      const skill = join(ctx.source, '.agents/skills', name);
      mkdirSync(skill, { recursive: true });
      writeText(join(skill, 'SKILL.md'), `# ${name}\n`);
    }
    const recurringConfig = join(
      ctx.source, '.agents/skills/configure-delivery-profiles',
    );
    mkdirSync(recurringConfig, { recursive: true });
    writeText(
      join(recurringConfig, 'SKILL.md'),
      '---\nname: configure-delivery-profiles\n' +
        'description: Refresh delivery profiles.\n---\n' +
        '# Configure delivery profiles\n',
    );
    const inventory = join(
      ctx.source, '.agents/skills/inventory-delivery-capabilities',
    );
    mkdirSync(inventory, { recursive: true });
    writeText(
      join(inventory, 'SKILL.md'),
      '---\nname: inventory-delivery-capabilities\n' +
        'description: List delivery capabilities.\n---\n' +
        '# Inventory delivery capabilities\n',
    );
    const oneshot = join(ctx.source, '.agents/skills/tailscale-web-dev');
    mkdirSync(oneshot, { recursive: true });
    writeText(
      join(oneshot, 'SKILL.md'),
      '---\nname: tailscale-web-dev\n' +
        'distribution: reference-only\ndescription: One-shot.\n---\n' +
        '# tailscale-web-dev\n',
    );
    const agents = join(ctx.source, '.codex/agents');
    mkdirSync(agents, { recursive: true });
    writeText(join(agents, 'issue-reviewer.toml'), 'name = "issue-reviewer"\n');
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  function install(options: InstallOptions = {}): string {
    return captureStdout(() =>
      installer.install(ctx.source, ctx.project, options),
    );
  }

  function capabilities(choice: string): void {
    installer.write_capabilities(ctx.project, choice);
  }

  /** Links an older pin created to skills the library no longer ships. */
  function retiredLinks(directory = '.agents/skills'): string[] {
    const root = join(ctx.project, directory);
    mkdirSync(root, { recursive: true });
    const links: string[] = [];
    for (const name of installer.RETIRED_MEMORY_SKILLS) {
      const link = join(root, name);
      symlinkSync(
        relative(root, join(ctx.source, '.agents/skills', name)),
        link,
      );
      links.push(link);
    }
    return links;
  }

  /** A managed link an older pin created for a now-retired toolkit skill. */
  function retiredSkillLink(name: string, directory = '.agents/skills'): string {
    const root = join(ctx.project, directory);
    mkdirSync(root, { recursive: true });
    const link = join(root, name);
    symlinkSync(
      relative(root, join(ctx.source, '.agents/skills', name)),
      link,
    );
    return link;
  }

  /** A byte-exact real copy of a retired toolkit skill. */
  function retiredCopy(name: string, directory = '.agents/skills'): string {
    const root = join(ctx.project, directory);
    mkdirSync(root, { recursive: true });
    cpSync(join(RETIRED_FIXTURES, name), join(root, name), {
      recursive: true,
    });
    return join(root, name);
  }

  /** Make the fixture source ship the retired skills, like an older pin. */
  function shipRetiredSkills(): string[] {
    const made: string[] = [];
    for (const name of ['add-integration', 'use-integration']) {
      const skill = join(ctx.source, '.agents/skills', name);
      mkdirSync(skill, { recursive: true });
      writeText(join(skill, 'SKILL.md'), `# ${name}\n`);
      made.push(skill);
    }
    return made;
  }

  function legacyBlock(): string {
    const reference = relative(
      ctx.project,
      join(ctx.source, 'docs/worktrees.md'),
    );
    return (
      `${installer.START}\n## Worktrees\n\n` +
      'Create a worktree only when requested by the user or selected through the harness.\n' +
      'Keep linked worktrees under `<main-checkout-parent>/worktrees/<project>/<task>/`.\n' +
      `Read \`${reference}\` before creating, moving or removing a worktree.\n` +
      'After a verified PR merge, remove its task worktree once preservation checks pass;\n' +
      'submodules alone do not prevent cleanup. Preserve existing work and authorization.\n' +
      `${installer.END}`
    );
  }

  function claudeLink(name: string): string {
    return join(ctx.project, '.claude/skills', name);
  }

  test('test_failed_preflight_records_no_capability_choice', () => {
    unlinkSync(join(ctx.project, 'AGENTS.md')); // preflight will fail
    throwsRegex(
      () => install({ memory: 'declined' }),
      /Missing consumer contract/,
    );
    assert.ok(!existsSync(join(ctx.project, '.agent-workflows-capabilities.json')));
    // A successful run still records the explicit choice after preflight.
    writeText(join(ctx.project, 'AGENTS.md'), '# Consumer rules\n');
    install({ memory: 'declined' });
    assert.equal(installer.read_capabilities(ctx.project), 'declined');
  });

  test('test_stale_library_link_is_refused_not_removed', () => {
    capabilities('declined');
    install();
    const skills = join(ctx.project, '.agents/skills');
    const stale = join(skills, 'retired-skill');
    symlinkSync(join(ctx.source, '.agents/skills/retired-skill'), stale);
    const before = names(skills).sort();
    throwsRegex(() => install({ check: true }), /Stale library skill link/);
    assert.deepEqual(names(skills).sort(), before);
  });

  test('test_consumer_owned_files_and_foreign_links_are_ignored', () => {
    capabilities('declined');
    install();
    const skills = join(ctx.project, '.agents/skills');
    mkdirSync(join(skills, 'own-skill'));
    writeText(join(skills, 'own-skill/SKILL.md'), '# local\n');
    symlinkSync(join(ctx.base, 'elsewhere'), join(skills, 'foreign'));
    install({ check: true }); // unrelated work stays untouched and passes
  });

  test('test_mcp_requirements_manifest_is_never_touched', () => {
    // The consumer-owned .agents/mcp-requirements.json is preserved
    // byte-for-byte by install and update runs; the helpers never create,
    // modify or delete it, valid or not.
    const manifest = join(ctx.project, '.agents/mcp-requirements.json');
    install();
    assert.ok(!existsSync(manifest));
    install({ check: true });
    assert.ok(!existsSync(manifest));
    mkdirSync(dirname(manifest), { recursive: true });
    const content = '{"version": 1, "services": []}\n';
    writeText(manifest, content);
    for (const check of [false, true, false]) {
      install({ check });
      assert.equal(readText(manifest), content);
    }
    writeText(manifest, 'not json {');
    install();
    assert.equal(readText(manifest), 'not json {');
    install({ check: true });
    assert.equal(readText(manifest), 'not json {');
  });

  test('reports missing Antigravity registration during install and check', () => {
    install();
    const manifest = join(ctx.project, '.agents/mcp-requirements.json');
    cpSync(join(ROOT, 'tests/fixtures/mcp-requirements/public-remote.json'), manifest);
    const destination = join(ctx.project, '.agents/mcp_config.json');
    for (const check of [false, true]) {
      assert.match(install({ check }), /mcp_config.json is absent/);
      assert.ok(!existsSync(destination));
    }
    const original = '{"mcpServers":{"owner":{"serverUrl":"https://example.test/mcp"}}}\n';
    writeText(destination, original);
    assert.doesNotMatch(install(), /mcp_config.json is absent/);
    assert.equal(readText(destination), original);
  });

  test('test_memory_links_require_enabled_capability', () => {
    capabilities('declined');
    install(); // baseline issue-only installation
    const skills = join(ctx.project, '.agents/skills');
    const link = join(skills, 'setup-basic-memory');
    symlinkSync(join(ctx.source, '.agents/skills/setup-basic-memory'), link);
    throwsRegex(() => install({ check: true }), /Unexpected memory skill link/);
    assert.ok(isSym(link)); // reported, never removed
    capabilities('enabled');
    install({ check: true }); // enablement makes the link expected
  });

  test('test_broken_retired_memory_links_are_reported_then_removed', () => {
    capabilities('enabled');
    install();
    const links = [...retiredLinks(), ...retiredLinks('.claude/skills')];
    const caught = throwsRegex(
      () => install({ check: true }),
      /Retired memory skill link/,
    );
    assert.ok(caught.message.includes('.agents/skills/memory-notes'));
    assert.ok(caught.message.includes('.claude/skills/memory-schema'));
    assert.ok(caught.message.includes('install --project .'));
    assert.ok(links.every((link) => isSym(link))); // check never removes
    const output = install();
    assert.ok(output.includes('retired: .agents/skills/memory-capture'));
    assert.ok(!links.some((link) => isSym(link) || existsSync(link)));
    install({ check: true });
    assert.ok(!install().includes('retired:')); // idempotent
  });

  test('test_retired_links_in_an_aliased_claude_folder_are_removed_once', () => {
    capabilities('enabled');
    install();
    mkdirSync(join(ctx.project, '.claude'));
    symlinkSync('../.agents/skills', join(ctx.project, '.claude/skills'));
    const links = retiredLinks();
    const caught = throwsRegex(
      () => install({ check: true }),
      /Retired memory skill link/,
    );
    assert.equal(caught.message.split('memory-notes').length - 1, 1);
    throwsRegex(
      () => install({ claude_skills: true, check: true }),
      /Retired memory skill link/,
    );
    assert.equal(
      install({ claude_skills: true }).split('retired:').length - 1,
      links.length,
    );
    assert.ok(!links.some((link) => isSym(link)));
    install({ check: true });
    install({ claude_skills: true, check: true });
  });

  test('test_declined_consumer_sheds_retired_links_without_enabling_memory', () => {
    capabilities('declined');
    const links = retiredLinks();
    const caught = throwsRegex(
      () => install({ check: true }),
      /Retired memory skill link/,
    );
    assert.ok(!caught.message.includes('install the upstream skills'));
    install();
    assert.ok(!links.some((link) => isSym(link)));
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/setup-basic-memory')));
    assert.ok(!existsSync(join(ctx.project, '.agents/memory')));
    install({ check: true });
  });

  test('test_upstream_installed_memory_skills_are_left_alone', () => {
    capabilities('enabled');
    const skills = join(ctx.project, '.agents/skills');
    const claude = join(ctx.project, '.claude/skills');
    mkdirSync(claude, { recursive: true });
    for (const name of installer.RETIRED_MEMORY_SKILLS) {
      mkdirSync(join(skills, name), { recursive: true });
      writeText(join(skills, name, 'SKILL.md'), `# upstream ${name}\n`);
      symlinkSync(relative(claude, join(skills, name)), join(claude, name));
    }
    const before = new Map(
      installer.RETIRED_MEMORY_SKILLS.map((name) => [
        join(skills, name, 'SKILL.md'),
        readText(join(skills, name, 'SKILL.md')),
      ]),
    );
    const output = install({ claude_skills: true });
    assert.ok(!output.includes('retired:'));
    install({ claude_skills: true, check: true });
    for (const [path, content] of before) {
      assert.equal(readText(path), content);
    }
    assert.ok(
      installer.RETIRED_MEMORY_SKILLS.every(
        (name) =>
          installer.pyResolve(join(claude, name)) ===
          installer.pyResolve(join(skills, name)),
      ),
    );
  });

  test('test_broken_retired_name_linked_outside_the_library_is_not_removed', () => {
    capabilities('enabled');
    install();
    const skills = join(ctx.project, '.agents/skills');
    const elsewhere = join(skills, 'memory-notes');
    symlinkSync(join(ctx.base, 'missing-elsewhere'), elsewhere);
    assert.ok(!install().includes('retired:'));
    assert.ok(isSym(elsewhere));
    install({ check: true });
  });

  test('test_retired_toolkit_links_and_copies_are_reported_then_removed', () => {
    capabilities('declined');
    install();
    const links = [
      retiredSkillLink('add-integration'),
      retiredSkillLink('use-integration', '.claude/skills'),
    ];
    const copies = [
      retiredCopy('use-integration'),
      retiredCopy('add-integration', '.claude/skills'),
    ];
    const caught = throwsRegex(
      () => install({ check: true }),
      /Retired toolkit skill/,
    );
    const message = caught.message;
    for (const entry of [...links, ...copies]) {
      assert.ok(message.includes(relative(ctx.project, entry)));
      assert.ok(isSym(entry) || existsSync(entry));
    }
    assert.ok(message.includes('install --project .'));
    const output = install();
    assert.ok(output.includes('retired: .agents/skills/add-integration (broken link'));
    assert.ok(output.includes('retired: .agents/skills/use-integration (exact copy'));
    assert.ok(
      ![...links, ...copies].some((entry) => isSym(entry) || existsSync(entry)),
    );
    install({ check: true });
    assert.ok(!install().includes('retired:')); // idempotent
  });

  test('test_retired_exact_copy_with_incoming_harness_links_is_preserved', () => {
    capabilities('declined');
    install();
    const copy = retiredCopy('add-integration');
    const links: string[] = [];
    for (const directory of ['.claude/skills', '.cursor/skills']) {
      const link = join(ctx.project, directory, 'add-integration');
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(relative(dirname(link), copy), link);
      links.push(link);
    }
    for (const check of [false, true, false]) {
      const output = install({ check });
      assert.ok(output.includes('incoming harness link'));
      assert.ok(!output.includes('retired:'));
      assert.ok(isDir(copy));
      assert.ok(links.every((link) => existsSync(link)));
    }
  });

  test('test_retired_adopted_exact_copy_and_manifest_are_preserved', () => {
    capabilities('declined');
    install();
    const copy = retiredCopy('use-integration');
    const manifest = join(ctx.project, '.agents/adopted-skills.json');
    const content =
      '{"schema_version": 1, "skills": {"use-integration": {"hash": "consumer-adoption"}}}\n';
    writeText(manifest, content);
    for (const check of [false, true, false]) {
      const output = install({ check });
      assert.ok(output.includes('consumer adoption record'));
      assert.ok(!output.includes('retired:'));
      assert.ok(isDir(copy));
      assert.equal(readText(manifest), content);
    }
  });

  test('test_adopt_then_refresh_keeps_copy_links_and_provenance_consistent', () => {
    capabilities('declined');
    install();
    const name = 'add-integration';
    retiredCopy(name, '.claude/skills');
    retiredCopy(name, '.cursor/skills');
    // Python runs scripts/adopt_skills.py --apply here; that script has no
    // TypeScript counterpart in this slice. Its --apply end state is
    // replicated directly: a canonical real copy under .agents/skills,
    // relative harness links back to it, and the provenance manifest.
    const canonical = retiredCopy(name);
    for (const directory of ['.claude/skills', '.cursor/skills']) {
      const link = join(ctx.project, directory, name);
      rmSync(link, { recursive: true });
      symlinkSync(relative(dirname(link), canonical), link);
    }
    const manifest = join(ctx.project, '.agents/adopted-skills.json');
    writeText(
      manifest,
      '{"schema_version": 1, "skills": {"add-integration": {"hash": "sha256:0"}}}\n',
    );
    const before = readFileSync(manifest);
    for (const check of [false, true, false]) {
      const output = install({ check });
      assert.ok(output.includes('consumer adoption record'));
      for (const directory of [
        '.agents/skills', '.claude/skills', '.cursor/skills',
      ]) {
        assert.ok(isFile(join(ctx.project, directory, name, 'SKILL.md')));
      }
      assert.deepEqual(readFileSync(manifest), before);
    }
  });

  test('test_unreadable_adoption_provenance_preserves_exact_copy', () => {
    capabilities('declined');
    install();
    const copy = retiredCopy('add-integration');
    const manifest = join(ctx.project, '.agents/adopted-skills.json');
    for (const content of ['{invalid', '{"skills": []}']) {
      writeText(manifest, content);
      const output = install();
      assert.ok(output.includes('review provenance'));
      assert.ok(isDir(copy));
      assert.equal(readText(manifest), content);
    }
  });

  test('test_other_contained_harness_retired_links_and_copies_are_removed', () => {
    capabilities('declined');
    install();
    const link = retiredSkillLink('add-integration', '.cursor/skills');
    const copy = retiredCopy('use-integration', '.codex/skills');
    throwsRegex(() => install({ check: true }), /Retired toolkit skill/);
    const output = install();
    assert.ok(output.includes('retired: .cursor/skills/add-integration'));
    assert.ok(output.includes('retired: .codex/skills/use-integration'));
    assert.ok(!isSym(link));
    assert.ok(!existsSync(copy));
    install({ check: true });
  });

  test('test_external_retirement_folders_preserve_copies', () => {
    for (const layout of ['.claude', '.claude/skills', '.agents/skills']) {
      const project = join(ctx.base, layout.replace(/\//g, '-'));
      mkdirSync(project);
      const external = join(ctx.base, `${basename(project)}-shared`);
      mkdirSync(external);
      const redirect = join(project, layout);
      mkdirSync(dirname(redirect), { recursive: true });
      symlinkSync(external, redirect);
      const folder = join(
        project,
        layout,
        layout === '.claude' ? 'skills' : '',
      );
      mkdirSync(folder, { recursive: true });
      const copy = join(folder, 'use-integration');
      cpSync(join(RETIRED_FIXTURES, 'use-integration'), copy, {
        recursive: true,
      });
      const before = readFileSync(join(copy, 'SKILL.md'));
      for (let i = 0; i < 2; i += 1) {
        const [removable, preserved] = installer.retired_skill_entries(
          ctx.source,
          project,
          [join(project, '.agents/skills'), join(project, '.claude/skills')],
        );
        assert.deepEqual(removable, []);
        assert.ok(
          preserved.some(
            ([path, reason]) =>
              path === copy && reason.includes('outside the consumer project'),
          ),
        );
        assert.deepEqual(readFileSync(join(copy, 'SKILL.md')), before);
      }
    }
  });

  test('test_external_claude_copy_survives_install_and_check', () => {
    capabilities('declined');
    install();
    const external = join(ctx.base, 'shared-skills');
    mkdirSync(external);
    mkdirSync(join(ctx.project, '.claude'));
    symlinkSync(external, join(ctx.project, '.claude/skills'));
    const copy = join(external, 'use-integration');
    cpSync(join(RETIRED_FIXTURES, 'use-integration'), copy, {
      recursive: true,
    });
    for (const check of [true, false, true]) {
      const output = install({ check });
      assert.ok(output.includes('preserved: .claude/skills/use-integration'));
      assert.ok(output.includes('outside the consumer project'));
      assert.ok(isFile(join(copy, 'SKILL.md')));
    }
  });

  test('test_retired_entries_in_an_aliased_claude_folder_are_removed_once', () => {
    capabilities('declined');
    install();
    mkdirSync(join(ctx.project, '.claude'));
    symlinkSync('../.agents/skills', join(ctx.project, '.claude/skills'));
    const link = retiredSkillLink('add-integration');
    const copy = retiredCopy('use-integration');
    const caught = throwsRegex(
      () => install({ claude_skills: true, check: true }),
      /Retired toolkit skill/,
    );
    assert.equal(caught.message.split('add-integration').length - 1, 1);
    assert.equal(caught.message.split('use-integration').length - 1, 1);
    const output = install({ claude_skills: true });
    assert.equal(output.split('retired:').length - 1, 2);
    assert.ok(!isSym(link) && !existsSync(copy));
    install({ check: true });
    install({ claude_skills: true, check: true });
  });

  test('test_memory_choice_does_not_change_retirement', () => {
    for (const choice of ['declined', 'enabled']) {
      capabilities(choice);
      const link = retiredSkillLink('add-integration');
      const copy = retiredCopy('use-integration');
      install();
      assert.ok(!isSym(link) && !existsSync(copy));
      install({ check: true });
    }
  });

  test('test_same_name_content_is_preserved_and_reported', () => {
    capabilities('declined');
    install();
    const skills = join(ctx.project, '.agents/skills');
    const customized = join(skills, 'use-integration');
    mkdirSync(customized);
    writeText(join(customized, 'SKILL.md'), '# consumer override\n');
    const extra = join(skills, 'add-integration');
    cpSync(join(RETIRED_FIXTURES, 'add-integration'), extra, {
      recursive: true,
    });
    writeText(join(extra, 'notes.md'), 'owner notes\n');
    const foreign = join(ctx.project, '.claude/skills/use-integration');
    mkdirSync(dirname(foreign), { recursive: true });
    symlinkSync(join(ctx.base, 'elsewhere'), foreign);
    const manifest = join(ctx.project, '.agents/adopted-skills.json');
    writeText(
      manifest,
      '{"schema_version": 1, "skills": {"use-integration": {"hash": "sha256:0"}}}\n',
    );
    const index = join(ctx.project, 'docs/integrations/index.md');
    mkdirSync(dirname(index), { recursive: true });
    writeText(index, '# Consumer integrations\n');
    const before = new Map(
      [
        join(customized, 'SKILL.md'),
        join(extra, 'SKILL.md'),
        join(extra, 'notes.md'),
        manifest,
        index,
      ].map((path) => [path, readFileSync(path)]),
    );
    for (const check of [false, true]) {
      const output = install({ check });
      assert.ok(output.includes('preserved: .agents/skills/use-integration'));
      assert.ok(output.includes('preserved: .agents/skills/add-integration'));
      assert.ok(output.includes('preserved: .claude/skills/use-integration'));
      assert.ok(!output.includes('retired:'));
    }
    assert.ok(isSym(foreign));
    for (const [path, content] of before) {
      assert.deepEqual(readFileSync(path), content);
    }
  });

  test('test_check_names_preserved_entries_with_the_repair', () => {
    capabilities('declined');
    install();
    const link = retiredSkillLink('add-integration');
    const customized = retiredCopy('use-integration');
    writeText(join(customized, 'SKILL.md'), '# customized\n');
    const caught = throwsRegex(
      () => install({ check: true }),
      /Retired toolkit skill/,
    );
    const message = caught.message;
    assert.ok(message.includes('Preserved same-name entries'));
    assert.ok(message.includes('.agents/skills/use-integration'));
    assert.ok(isSym(link));
    const output = install();
    assert.ok(output.includes('retired: .agents/skills/add-integration'));
    assert.ok(output.includes('preserved: .agents/skills/use-integration'));
    assert.ok(!isSym(link));
    assert.equal(readText(join(customized, 'SKILL.md')), '# customized\n');
  });

  test('test_ambiguous_same_name_entries_are_never_removed', () => {
    capabilities('declined');
    install();
    const skills = join(ctx.project, '.agents/skills');
    const entries = new Map<string, string>();
    const empty = join(skills, 'add-integration');
    mkdirSync(empty);
    entries.set('empty dir', empty);
    const marker = join(skills, 'use-integration');
    mkdirSync(marker);
    symlinkSync('missing-target', join(marker, 'SKILL.md'));
    entries.set('linked SKILL.md', marker);
    const output = install();
    for (const [, entry] of entries) {
      assert.ok(output.includes(`preserved: ${relative(ctx.project, entry)}`));
      assert.ok(isDir(entry) || isSym(entry) || existsSync(entry));
    }
    install({ check: true });
  });

  test('test_refresh_from_a_pin_containing_both_skills', () => {
    // The previous pin still ships the retired skills; its managed links
    // are removed only by a refresh at the retiring revision.
    const made = shipRetiredSkills();
    capabilities('declined');
    install();
    for (const name of ['add-integration', 'use-integration']) {
      const link = join(ctx.project, '.agents/skills', name);
      assert.ok(isSym(link));
      assert.ok(existsSync(link));
    }
    for (const skill of made) { // the pin moves to the retiring revision
      rmSync(skill, { recursive: true });
    }
    const output = install();
    assert.equal(output.split('retired:').length - 1, 2);
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/add-integration')));
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/use-integration')));
    install({ check: true });
  });

  test('test_returning_to_an_older_pin_restores_the_skills', () => {
    const made = shipRetiredSkills();
    capabilities('declined');
    install();
    for (const skill of made) { // update past the retirement removes the links
      rmSync(skill, { recursive: true });
    }
    install();
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/add-integration')));
    shipRetiredSkills(); // the old pin restores them
    install();
    for (const name of ['add-integration', 'use-integration']) {
      const link = join(ctx.project, '.agents/skills', name);
      assert.ok(isSym(link));
      assert.equal(
        installer.pyResolve(link),
        installer.pyResolve(join(ctx.source, '.agents/skills', name)),
      );
    }
    install({ check: true });
  });

  test('test_retired_content_hashes_match_the_fixtures', () => {
    assert.deepEqual(
      Object.keys(installer.RETIRED_TOOLKIT_SKILLS).sort(),
      ['add-integration', 'use-integration'],
    );
    for (const [name, files] of Object.entries(
      installer.RETIRED_TOOLKIT_SKILLS,
    )) {
      for (const [relativeName, expected] of Object.entries(files)) {
        const fixture = join(RETIRED_FIXTURES, name, relativeName);
        assert.ok(isFile(fixture), `missing fixture ${fixture}`);
        assert.equal(
          createHash('sha256').update(readFileSync(fixture)).digest('hex'),
          expected,
        );
      }
    }
    assert.ok(
      !Object.keys(installer.RETIRED_TOOLKIT_SKILLS).some(
        (name) =>
          installer.MEMORY_SKILLS.includes(name) ||
          installer.RETIRED_MEMORY_SKILLS.includes(name),
      ),
    );
  });

  test('test_ignored_t3_skills_array_and_consumer_files_survive', () => {
    capabilities('declined');
    const config = join(ctx.project, '.agent-workflows-t3.json');
    writeText(
      config,
      '{"choice": "declined", "library": ".agent-workflows", "base": "origin/main", "profiles": [], "memory": {"routing_source": null}, "skills": ["add-integration", "use-integration"]}\n',
    );
    const link = retiredSkillLink('use-integration');
    const before = readFileSync(config);
    const output = install();
    assert.ok(output.includes('retired: .agents/skills/use-integration'));
    assert.ok(!isSym(link));
    assert.deepEqual(readFileSync(config), before);
    install({ check: true });
  });

  test('test_check_repair_commands_preserve_requested_setup_options', () => {
    let caught = throwsRegex(() =>
      install({
        codex_agents: true,
        claude_skills: true,
        delivery_profiles: true,
        check: true,
      }),
    );
    let message = caught.message;
    assert.ok(message.includes('Missing managed block(s)'));
    for (const flag of [
      '--codex-agents', '--claude-skills', '--delivery-profiles',
    ]) {
      assert.ok(message.includes(flag));
    }
    const rel = relative(
      ctx.project,
      join(ctx.source, 'bin/agent-workflows.ts'),
    );
    assert.ok(message.includes(`node ${rel} install`));
    unlinkMissing(join(ctx.project, installer.CAPABILITIES_FILE));
    caught = throwsRegex(() =>
      install({ memory: 'enabled', claude_skills: true, check: true }),
    );
    message = caught.message;
    assert.ok(message.includes('not recorded'));
    assert.ok(message.includes('--claude-skills --memory enabled'));
    install({ codex_agents: true, claude_skills: true });
    caught = throwsRegex(() =>
      install({
        codex_agents: true,
        claude_skills: true,
        delivery_profiles: true,
        check: true,
      }),
    );
    message = caught.message;
    assert.ok(message.includes('Missing installation'));
    assert.ok(message.includes('--delivery-profiles'));
  });

  test('test_relative_links_survive_relocation_and_reinstall', () => {
    install({ codex_agents: true });
    install({ codex_agents: true, check: true });
    const moved = join(ctx.base, 'moved-project');
    renameSync(ctx.project, moved);
    const link = join(moved, '.agents/skills/shape-issue');
    assert.ok(!isAbsolute(readlinkSync(link)));
    assert.equal(readText(join(link, 'SKILL.md')), '# shape-issue\n');
    assert.ok(isFile(join(moved, '.codex/agents/issue-reviewer.toml')));
  });

  test('test_derived_toolkit_excludes_memory_until_enabled', () => {
    install();
    assert.ok(isSym(join(ctx.project, '.agents/skills/shape-issue')));
    assert.ok(isSym(join(ctx.project, '.agents/skills/review-issue')));
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/setup-basic-memory')));
    const text = readText(join(ctx.project, 'AGENTS.md'));
    assert.ok(!text.includes('setup-basic-memory'));
    assert.ok(!text.includes('Basic Memory'));
    const [installed, reference] = installer.toolkit(ctx.source);
    assert.deepEqual(installed, [
      'configure-delivery-profiles', 'deliver-milestone',
      'inventory-delivery-capabilities', 'review-issue',
      'shape-issue',
    ]);
    assert.deepEqual(reference, ['tailscale-web-dev']);
    const [installedMemory, referenceMemory] = installer.toolkit(
      ctx.source,
      true,
    );
    assert.ok(installedMemory.includes('setup-basic-memory'));
    assert.ok(!referenceMemory.includes('setup-basic-memory'));
  });

  test('test_capability_choice_is_recorded_and_reused', () => {
    throwsRegex(
      () => install({ check: true, memory: 'enabled' }),
      /not recorded in/,
    );
    const output = install({ memory: 'declined' });
    assert.ok(output.includes('memory declined'));
    assert.deepEqual(
      JSON.parse(
        readText(join(ctx.project, installer.CAPABILITIES_FILE)),
      ),
      { schema_version: 1, memory: 'declined' },
    );
    // Idempotent rerun with the same choice and a check that verifies it.
    install({ memory: 'declined', check: true });
    install({ memory: 'declined' });
    throwsRegex(() => install({ memory: 'enabled' }), /conflicts/);
    throwsRegex(
      () => install({ check: true, memory: 'enabled' }),
      /conflicts/,
    );
    assert.deepEqual(
      JSON.parse(
        readText(join(ctx.project, installer.CAPABILITIES_FILE)),
      ),
      { schema_version: 1, memory: 'declined' },
    );
  });

  test('test_unknown_choice_does_not_fail_check_or_enable_memory', () => {
    install();
    const output = install({ check: true });
    assert.ok(output.includes('not recorded'));
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/setup-basic-memory')));
    assert.ok(!existsSync(join(ctx.project, installer.CAPABILITIES_FILE)));
    assert.equal(installer.read_capabilities(ctx.project), null);
  });

  test('test_malformed_capabilities_file_is_reported_not_overwritten', () => {
    const path = join(ctx.project, installer.CAPABILITIES_FILE);
    for (const content of [
      '{"schema_version": 1, "memory": "maybe"}',
      '{"schema_version": 2, "memory": "enabled"}',
      '{"schema_version": 1, "memory": "enabled", "skills": []}',
      'not json',
    ]) {
      writeText(path, content);
      const before = readFileSync(path);
      throwsRegex(() => install({ check: true }), /preserve and review/);
      assert.deepEqual(readFileSync(path), before);
    }
  });

  test('test_enabled_choice_still_installs_no_memory_assets', () => {
    // install.py never installs the memory capability; setup_memory.py does.
    capabilities('enabled');
    install();
    install({ check: true });
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/setup-basic-memory')));
  });

  test('test_conflict_preflight_does_not_install_other_skills', () => {
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    const conflict = join(ctx.project, '.agents/skills/shape-issue');
    mkdirSync(conflict, { recursive: true });
    throwsRegex(() => install());
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/review-issue')));
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
  });

  test('test_invalid_names_still_rejected_for_internal_use', () => {
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(() =>
      installer.prepare_install(ctx.source, ctx.project, ['../outside']),
    );
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
  });

  test('test_collaboration_preserves_existing_instructions_and_is_idempotent', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    const original = '# Consumer\nKeep product rules.\n\n## Local conventions\nKeep these too.';
    writeText(agents, original);
    install();
    const installed = readFileSync(agents);
    assert.ok(readText(agents).startsWith(`${original}\n\n`));
    assert.ok(!readText(agents).includes(installer.START));
    assert.ok(readText(agents).includes('## Working with the owner'));
    assert.equal(readText(agents).split(installer.START).length - 1, 0);
    assert.equal(readText(agents).split(installer.COLLAB_START).length - 1, 1);
    install();
    install({ check: true });
    assert.deepEqual(readFileSync(agents), installed);
  });

  test('test_collaboration_policy_is_embedded_and_checked', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    install();
    const text = readText(agents);
    assert.ok(!text.includes('Basic Memory'));
    assert.ok(!text.includes('`.agents/memory/config.md`'));
    assert.ok(!text.includes(installer.START));
    install({ check: true });
    writeText(agents, text.replace('## Working with the owner', '## Owner'));
    throwsRegex(
      () => install({ check: true }),
      /Customized collaboration policy block/,
    );
  });

  test('test_check_detects_missing_policy_even_when_links_exist', () => {
    install();
    const agents = join(ctx.project, 'AGENTS.md');
    writeText(agents, '# Consumer rules\n');
    const before = readFileSync(agents);
    throwsRegex(
      () => install({ check: true }),
      /Missing managed block\(s\) in .*AGENTS\.md: collaboration policy \(markers `<!-- agent-workflows:collaboration:start -->`\/`<!-- agent-workflows:collaboration:end -->`\); reference-only pointer .*Repair from the consumer root: `node \.agent-workflows\/bin\/agent-workflows\.ts install --project \.`/,
    );
    assert.deepEqual(readFileSync(agents), before);
  });

  test('test_check_names_missing_link_target_and_repair', () => {
    install();
    const link = join(ctx.project, '.agents/skills/shape-issue');
    unlinkSync(link);
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(
      () => install({ check: true }),
      /Missing installation: .*\.agents\/skills\/shape-issue; the pinned toolkit expects a managed link to .*\.agent-workflows\/\.agents\/skills\/shape-issue\. Repair from the consumer root: `node \.agent-workflows\/bin\/agent-workflows\.ts install --project \.`/,
    );
    assert.ok(!existsSync(link));
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
    install(); // the suggested repair is deterministic
    assert.ok(isSym(link));
    install({ check: true });
  });

  test('test_check_reports_each_missing_block_separately', () => {
    install();
    const agents = join(ctx.project, 'AGENTS.md');
    const text = readText(agents);
    const start = text.indexOf(installer.REF_START);
    const end = text.indexOf(installer.REF_END) + installer.REF_END.length;
    writeText(agents, text.slice(0, start) + text.slice(end));
    const before = readFileSync(agents);
    throwsRegex(
      () => install({ check: true }),
      /Missing managed block\(s\) in .*AGENTS\.md: reference-only pointer \(markers `<!-- agent-workflows:reference-only:start -->`\/`<!-- agent-workflows:reference-only:end -->`\)\. The pinned toolkit expects/,
    );
    assert.deepEqual(readFileSync(agents), before);
  });

  test('test_customized_block_identifies_file_and_markers', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    writeText(
      agents,
      `${installer.COLLAB_START}\nOwner edit\n${installer.COLLAB_END}`,
    );
    const before = readFileSync(agents);
    throwsRegex(
      () => install({ check: true }),
      /Customized collaboration policy block in .*AGENTS\.md \(markers `<!-- agent-workflows:collaboration:start -->`\/`<!-- agent-workflows:collaboration:end -->`\); preserve and review an explicit edit/,
    );
    assert.deepEqual(readFileSync(agents), before);
  });

  test('test_conflicting_link_reports_actual_and_expected_target', () => {
    install();
    const link = join(ctx.project, '.agents/skills/shape-issue');
    unlinkSync(link);
    symlinkSync(join(ctx.source, '.agents/skills/review-issue'), link);
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(
      () => install({ check: true }),
      /Conflicting symlink: .*shape-issue resolves to .*review-issue; the pinned toolkit expects .*shape-issue\. Retarget it only after a reviewed decision/,
    );
    assert.ok(isSym(link));
    assert.equal(
      installer.pyResolve(link),
      installer.pyResolve(join(ctx.source, '.agents/skills/review-issue')),
    );
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
  });

  test('test_repair_command_uses_the_actual_library_path', () => {
    const moved = join(ctx.project, 'workflow-lib');
    renameSync(ctx.source, moved);
    ctx.source = moved;
    install();
    const link = join(ctx.project, '.agents/skills/shape-issue');
    unlinkSync(link);
    throwsRegex(
      () => install({ check: true }),
      /Missing installation: .*shape-issue.*Repair from the consumer root: `node workflow-lib\/bin\/agent-workflows\.ts install --project \.`/,
    );
    assert.ok(!existsSync(link));
  });

  test('test_exact_legacy_block_migrates_and_check_is_read_only', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    const prefix = '# Consumer\nKeep this.\n\n';
    const suffix = '\n\nKeep this too.\n';
    const renamed = join(ctx.project, 'workflow library');
    renameSync(ctx.source, renamed);
    ctx.source = renamed;
    const oldWorktree = legacyBlock();
    const oldInstall =
      prefix + oldWorktree + '\n\n' + installer.COLLAB_BLOCK + '\n' + suffix;
    writeText(agents, oldInstall);
    const before = readFileSync(agents);
    const caught = throwsRegex(() => install({ check: true }));
    const message = caught.message;
    assert.ok(message.includes('requires migration'));
    const rel = relative(
      ctx.project,
      join(ctx.source, 'bin/agent-workflows.ts'),
    );
    // The path contains a space, so shlex.quote wraps it in single quotes.
    assert.ok(message.includes(`node '${rel}' install`));
    assert.deepEqual(readFileSync(agents), before);
    install();
    const expected = oldInstall.replace(oldWorktree, '');
    const text = readText(agents);
    assert.ok(text.startsWith(expected), text);
    assert.ok(text.includes(installer.REF_START));
    assert.ok(!text.includes('agent-workflows:worktrees'));
    assert.ok(text.includes(installer.COLLAB_BLOCK));
    const migrated = readFileSync(agents);
    install();
    install({ check: true });
    assert.deepEqual(readFileSync(agents), migrated);
  });

  test('test_customized_malformed_or_duplicated_legacy_block_fails_atomically', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    const exact = legacyBlock();
    for (const content of [
      exact.replace('Keep linked', 'Put linked'),
      `${exact}\n${exact}`,
      exact.replace(installer.END, ''),
      installer.END + installer.START,
    ]) {
      writeText(agents, content);
      const caught = throwsRegex(() => install());
      const message = caught.message;
      assert.ok(message.includes('legacy worktree block'));
      assert.ok(message.includes('AGENTS.md'));
      assert.ok(
        message.includes(`markers \`${installer.START}\`/\`${installer.END}\``),
      );
      assert.equal(readText(agents), content);
      assert.ok(!existsSync(join(ctx.project, '.agents')));
      throwsRegex(() => install({ check: true }));
      assert.equal(readText(agents), content);
    }
    for (const content of [
      `${installer.COLLAB_START}\nCustom policy\n${installer.COLLAB_END}`,
      installer.COLLAB_START,
      installer.COLLAB_END,
      installer.COLLAB_END + installer.COLLAB_START,
      installer.COLLAB_START + installer.COLLAB_START + installer.COLLAB_END,
    ]) {
      writeText(agents, content);
      throwsRegex(() => install(), /collaboration policy block/);
      assert.equal(readText(agents), content);
      assert.ok(!existsSync(join(ctx.project, '.agents')));
    }
  });

  test('test_migration_preflight_precedes_link_creation', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    writeText(agents, legacyBlock());
    const conflict = join(ctx.project, '.agents/skills/review-issue');
    mkdirSync(conflict, { recursive: true });
    throwsRegex(() => install(), /Local skill conflict/);
    assert.equal(readText(agents), legacyBlock());
    assert.ok(isDir(conflict));
  });

  test('test_linked_agents_instructions_are_preserved', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    const external = join(ctx.base, 'shared-instructions.md');
    writeText(external, 'Keep external rules');
    unlinkSync(agents);
    symlinkSync(external, agents);
    throwsRegex(() => install(), /Linked consumer instructions/);
    assert.equal(readText(external), 'Keep external rules');
    assert.ok(!existsSync(join(ctx.project, '.agents')));
  });

  test('test_reference_only_skill_is_pointer_not_installed', () => {
    capabilities('declined');
    install();
    assert.ok(isSym(join(ctx.project, '.agents/skills/review-issue')));
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/tailscale-web-dev')));
    const text = readText(join(ctx.project, 'AGENTS.md'));
    assert.ok(text.includes(installer.REF_START));
    assert.ok(text.includes('Discovery depends on this pointer existing'));
    assert.ok(
      text.includes('`.agent-workflows/.agents/skills/tailscale-web-dev/SKILL.md`'),
    );
    const installed = readFileSync(join(ctx.project, 'AGENTS.md'));
    install();
    install({ check: true });
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), installed);
  });

  test('test_delivery_capability_skills_are_installed', () => {
    capabilities('declined');
    install();
    for (const name of [
      'configure-delivery-profiles', 'inventory-delivery-capabilities',
    ]) {
      const link = join(ctx.project, '.agents/skills', name);
      assert.ok(isSym(link));
      assert.equal(
        readText(join(link, 'SKILL.md')),
        readText(join(ctx.source, '.agents/skills', name, 'SKILL.md')),
      );
      assert.ok(!readText(join(ctx.project, 'AGENTS.md')).includes(name));
    }
  });

  test('test_installed_reference_only_symlink_is_rejected', () => {
    const link = join(ctx.project, '.agents/skills/tailscale-web-dev');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(ctx.source, '.agents/skills/tailscale-web-dev'), link);
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(
      () => install({ check: true }),
      /Reference-only skill installed/,
    );
    assert.ok(isSym(link));
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
  });

  test('test_customized_reference_only_block_fails_like_other_policies', () => {
    const agents = join(ctx.project, 'AGENTS.md');
    capabilities('declined');
    install();
    const text = readText(agents);
    writeText(agents, text.replace('Shared, not installed', 'Shared differently'));
    const before = readFileSync(agents);
    throwsRegex(
      () => install(),
      /Customized reference-only pointer block/,
    );
    assert.deepEqual(readFileSync(agents), before);
  });

  test('test_claude_skills_mirror_installed_toolkit_with_relative_links', () => {
    capabilities('declined');
    install({ claude_skills: true });
    const link = claudeLink('shape-issue');
    assert.ok(isSym(link));
    assert.ok(!isAbsolute(readlinkSync(link)));
    assert.equal(readText(join(link, 'SKILL.md')), '# shape-issue\n');
    assert.ok(isSym(claudeLink('review-issue')));
    assert.ok(!existsSync(claudeLink('tailscale-web-dev')));
    assert.ok(!existsSync(claudeLink('setup-basic-memory')));
    install({ claude_skills: true, check: true });
  });

  test('test_claude_skills_are_idempotent_and_opt_in', () => {
    capabilities('declined');
    install();
    assert.ok(!existsSync(join(ctx.project, '.claude')));
    install({ claude_skills: true });
    const agents = readFileSync(join(ctx.project, 'AGENTS.md'));
    const links = Object.fromEntries(
      names(join(ctx.project, '.claude/skills')).map((name) => [
        name,
        readlinkSync(join(ctx.project, '.claude/skills', name)),
      ]),
    );
    install({ claude_skills: true });
    install({ claude_skills: true, check: true });
    assert.deepEqual(
      Object.fromEntries(
        names(join(ctx.project, '.claude/skills')).map((name) => [
          name,
          readlinkSync(join(ctx.project, '.claude/skills', name)),
        ]),
      ),
      links,
    );
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), agents);
    // Omitting the flag later neither removes recorded links nor fails the check.
    install({ check: true });
    assert.ok(isSym(claudeLink('shape-issue')));
  });

  test('test_claude_skill_conflict_is_refused_before_any_link', () => {
    capabilities('declined');
    const conflict = claudeLink('review-issue');
    mkdirSync(conflict, { recursive: true });
    writeText(join(conflict, 'SKILL.md'), '# local\n');
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(() => install({ claude_skills: true }), /Local skill conflict/);
    assert.ok(!existsSync(claudeLink('shape-issue')));
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    assert.equal(readText(join(conflict, 'SKILL.md')), '# local\n');
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
  });

  test('test_claude_skills_path_that_is_a_file_blocks_preflight', () => {
    capabilities('declined');
    mkdirSync(join(ctx.project, '.claude'));
    writeText(join(ctx.project, '.claude/skills'), 'not a directory\n');
    throwsRegex(() => install({ claude_skills: true }), /Local skill conflict/);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    assert.equal(readText(join(ctx.project, '.claude/skills')), 'not a directory\n');
  });

  test('test_stale_and_reference_only_claude_links_are_refused_not_removed', () => {
    capabilities('declined');
    install({ claude_skills: true });
    const skills = join(ctx.project, '.claude/skills');
    const stale = join(skills, 'retired-skill');
    symlinkSync(join(ctx.source, '.agents/skills/retired-skill'), stale);
    throwsRegex(
      () => install({ claude_skills: true, check: true }),
      /Stale library skill link/,
    );
    assert.ok(isSym(stale));
    unlinkSync(stale);
    const reference = join(skills, 'tailscale-web-dev');
    symlinkSync(join(ctx.source, '.agents/skills/tailscale-web-dev'), reference);
    throwsRegex(
      () => install({ claude_skills: true, check: true }),
      /Reference-only skill installed/,
    );
    assert.ok(isSym(reference));
  });

  test('test_claude_check_detects_missing_links_and_memory_links_need_enablement', () => {
    capabilities('declined');
    install();
    throwsRegex(
      () => install({ claude_skills: true, check: true }),
      /Missing installation/,
    );
    install({ claude_skills: true });
    const link = claudeLink('setup-basic-memory');
    symlinkSync(join(ctx.source, '.agents/skills/setup-basic-memory'), link);
    throwsRegex(
      () => install({ claude_skills: true, check: true }),
      /Unexpected memory skill link/,
    );
    assert.ok(isSym(link));
  });

  test('test_claude_links_survive_relocation_and_preserve_consumer_files', () => {
    capabilities('declined');
    const own = claudeLink('own-skill');
    mkdirSync(own, { recursive: true });
    writeText(join(own, 'SKILL.md'), '# local\n');
    const settings = join(ctx.project, '.claude/settings.json');
    writeText(settings, '{}\n');
    const foreign = claudeLink('foreign');
    symlinkSync(join(ctx.base, 'elsewhere'), foreign);
    install({ claude_skills: true });
    install({ claude_skills: true, check: true });
    const moved = join(ctx.base, 'moved-project');
    renameSync(ctx.project, moved);
    const link = join(moved, '.claude/skills/shape-issue');
    assert.ok(!isAbsolute(readlinkSync(link)));
    assert.equal(readText(join(link, 'SKILL.md')), '# shape-issue\n');
    assert.equal(readText(join(moved, '.claude/skills/own-skill/SKILL.md')), '# local\n');
    assert.ok(isSym(join(moved, '.claude/skills/foreign')));
    assert.equal(readText(join(moved, '.claude/settings.json')), '{}\n');
  });

  test('test_embedded_blocks_stay_in_sync_with_library_agents_md', () => {
    const library = readText(join(ROOT, 'AGENTS.md'));
    // The library's own AGENTS.md must pass its own installer unchanged.
    const [, , existing, updated] = installer.prepare_install(ROOT, ROOT, []);
    assert.equal(updated, existing);
    const start = library.indexOf(installer.COLLAB_START);
    const end = library.indexOf(installer.COLLAB_END) + installer.COLLAB_END.length;
    assert.equal(library.slice(start, end), installer.COLLAB_BLOCK);
  });

  test('test_claude_install_imports_existing_consumer_instructions_idempotently', () => {
    capabilities('declined');
    const claude = join(ctx.project, 'CLAUDE.md');
    const original = '# Claude notes\nKeep this content.';
    writeText(claude, original);
    install({ claude_skills: true });
    const installed = readText(claude);
    assert.ok(installed.startsWith(`${original}\n`));
    assert.equal(installed.split('@AGENTS.md').length - 1, 1);
    install({ claude_skills: true });
    install({ claude_skills: true, check: true });
    assert.equal(readText(claude), installed);
  });

  test('test_claude_markdown_import_semantics', () => {
    const cases: [string, boolean][] = [
      ['See @AGENTS.md for rules.\n', true],
      ['- instructions @./AGENTS.md\n', true],
      ['```md\n@AGENTS.md\n```\n', false],
      ['~~~md\n@AGENTS.md\n~~~\n', false],
      ['Use `@AGENTS.md` as an example.\n', false],
      ['Use ``a ` @AGENTS.md`` as an example.\n', false],
      ['@AGENTS.md\n```\n@AGENTS.md\n```\n', true],
    ];
    const claude = join(ctx.project, 'CLAUDE.md');
    for (const [original, active] of cases) {
      writeText(claude, original);
      install({ claude_skills: true });
      const expected = active ? original : `${original}@AGENTS.md\n`;
      assert.equal(readText(claude), expected);
      install({ claude_skills: true });
      install({ claude_skills: true, check: true });
      assert.equal(readText(claude), expected);
    }
  });

  test('test_claude_import_code_spans_respect_paragraphs_and_escapes', () => {
    for (const content of [
      '`unclosed\n\n@AGENTS.md\n\nclosing`\n',
      '\\` @AGENTS.md \\`\n',
    ]) {
      assert.deepEqual(installer.claude_imports(content), ['AGENTS.md']);
    }
  });

  test('test_claude_container_fences_refused_before_writes', () => {
    for (const content of [
      '> ~~~md\n> @AGENTS.md\n> ~~~\n',
      '- ~~~md\n  @AGENTS.md\n  ~~~\n',
      '- example\n    ~~~md\n    @AGENTS.md\n    ~~~\n',
    ]) {
      const claude = join(ctx.project, 'CLAUDE.md');
      writeText(claude, content);
      throwsRegex(() => install({ claude_skills: true }), /Markdown fence/);
      assert.equal(readText(claude), content);
      assert.ok(!existsSync(join(ctx.project, '.agents')));
    }
  });

  test('test_claude_fences_preserve_inline_block_boundaries', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    const original = '`open\n```text\nsample\n```\n@AGENTS.md\nclose`\n';
    writeText(claude, original);
    install({ claude_skills: true });
    install({ claude_skills: true, check: true });
    assert.equal(readText(claude), original);
  });

  test('test_claude_escaped_backtick_runs_refused_before_writes', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    const original = '\\``@AGENTS.md`\n';
    writeText(claude, original);
    throwsRegex(
      () => install({ claude_skills: true }),
      /Ambiguous escaped backticks/,
    );
    assert.equal(readText(claude), original);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
  });

  test('test_alternate_claude_instructions_require_review', () => {
    for (const name of [
      '.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.local.md',
    ]) {
      const alternate = join(ctx.project, name);
      mkdirSync(dirname(alternate), { recursive: true });
      writeText(alternate, '# Local instructions\n');
      for (const check of [false, true]) {
        throwsRegex(
          () => install({ claude_skills: true, check }),
          /Alternate Claude instructions/,
        );
      }
      assert.equal(readText(alternate), '# Local instructions\n');
      assert.ok(!existsSync(join(ctx.project, 'CLAUDE.md')));
      assert.ok(!existsSync(join(ctx.project, '.agents')));
      unlinkSync(alternate);
    }
  });

  test('test_claude_indented_code_refused_before_writes', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    for (const content of [
      '    @AGENTS.md\n', '\t@AGENTS.md\n',
      'Example:\n\n    @AGENTS.md\n',
      'Example:\n\n\t@AGENTS.md\n',
    ]) {
      writeText(claude, content);
      for (const check of [false, true]) {
        throwsRegex(
          () => install({ claude_skills: true, check }),
          /Indented Markdown/,
        );
      }
      assert.equal(readText(claude), content);
      assert.ok(!existsSync(join(ctx.project, '.agents')));
      assert.ok(!existsSync(join(ctx.project, '.claude/skills')));
    }
  });

  test('test_claude_thematic_breaks_refused_before_writes', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    for (const separator of ['***', '___', '---', '* * *', '_ _ _', '- - -']) {
      const original = '`open\n' + separator + '\n@AGENTS.md\nclose`\n';
      writeText(claude, original);
      for (const check of [false, true]) {
        throwsRegex(
          () => install({ claude_skills: true, check }),
          /Ambiguous Markdown code span/,
        );
      }
      assert.equal(readText(claude), original);
      assert.ok(!existsSync(join(ctx.project, '.agents')));
      assert.ok(!existsSync(join(ctx.project, '.claude/skills')));
    }
  });

  test('test_claude_unclosed_fence_preflights_without_writes', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    const original = '```md\n@AGENTS.md\n';
    writeText(claude, original);
    throwsRegex(
      () => install({ claude_skills: true }),
      /Unclosed Markdown fence/,
    );
    assert.equal(readText(claude), original);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
  });

  test('test_claude_import_preserves_crlf', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    writeFileSync(claude, Buffer.from('# Notes\r\n', 'utf8'));
    install({ claude_skills: true });
    assert.deepEqual(
      readFileSync(claude),
      Buffer.from('# Notes\r\n@AGENTS.md\r\n', 'utf8'),
    );
  });

  test('test_claude_check_reports_missing_import_without_writing', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    writeText(claude, '# Claude notes\n');
    const before = readFileSync(claude);
    throwsRegex(
      () => install({ claude_skills: true, check: true }),
      /Missing @AGENTS.md import/,
    );
    assert.deepEqual(readFileSync(claude), before);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
  });

  test('test_claude_import_is_not_created_when_claude_md_is_absent', () => {
    install({ claude_skills: true });
    assert.ok(!existsSync(join(ctx.project, 'CLAUDE.md')));
  });

  test('test_existing_resolved_claude_import_is_preserved', () => {
    const claude = join(ctx.project, 'CLAUDE.md');
    const original = '# Claude notes\n@./AGENTS.md\n';
    writeText(claude, original);
    install({ claude_skills: true });
    assert.equal(readText(claude), original);
  });

  test('test_claude_import_conflict_preflights_before_writes', () => {
    const external = join(ctx.base, 'external-claude.md');
    writeText(external, '# linked\n');
    const claude = join(ctx.project, 'CLAUDE.md');
    symlinkSync(external, claude);
    const beforeAgents = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(
      () => install({ claude_skills: true }),
      /Linked Claude instructions/,
    );
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    assert.ok(!existsSync(join(ctx.project, '.claude/skills/shape-issue')));
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), beforeAgents);
  });

  test('test_claude_directory_at_instruction_path_is_reported', () => {
    mkdirSync(join(ctx.project, 'CLAUDE.md'));
    throwsRegex(
      () => install({ claude_skills: true }),
      /Ambiguous Claude instruction setup/,
    );
  });

  test('test_symlinked_claude_file_with_existing_import_is_preserved', () => {
    const target = join(ctx.base, 'shared-claude.md');
    writeText(target, '# Claude notes\n@./AGENTS.md\n');
    const claude = join(ctx.project, 'CLAUDE.md');
    symlinkSync(target, claude);
    install({ claude_skills: true });
    assert.ok(isSym(claude));
    assert.equal(readText(target), '# Claude notes\n@./AGENTS.md\n');
  });

  test('test_claude_import_preflight_runs_before_capability_recording', () => {
    const external = join(ctx.base, 'external.md');
    writeText(external, '# linked\n');
    const claude = join(ctx.project, 'CLAUDE.md');
    symlinkSync(external, claude);
    throwsRegex(
      () => install({ claude_skills: true, memory: 'declined' }),
      /Linked Claude instructions/,
    );
    assert.ok(!existsSync(join(ctx.project, installer.CAPABILITIES_FILE)));
  });

  test('test_consumer_install_reports_links_never_self', () => {
    const output = install();
    assert.ok(output.includes('installed: .agents/skills/shape-issue'));
    assert.ok(!output.includes('self:'));
    const checked = install({ check: true });
    assert.ok(checked.includes('linked: .agents/skills/shape-issue'));
    assert.ok(!checked.includes('self:'));
  });

  test('test_consumer_real_directory_conflict_is_still_refused', () => {
    const conflict = join(ctx.project, '.agents/skills/shape-issue');
    mkdirSync(conflict, { recursive: true });
    writeText(join(conflict, 'SKILL.md'), '# local\n');
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(
      () => install(),
      /Local skill conflict: .*shape-issue; a consumer file occupies the managed path the pinned toolkit expects to link to .*shape-issue; choose one source explicitly/,
    );
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
    // With a clean baseline, check mode reaches the same refusal.
    rmSync(conflict, { recursive: true });
    install();
    unlinkSync(conflict);
    mkdirSync(conflict);
    writeText(join(conflict, 'SKILL.md'), '# local\n');
    throwsRegex(() => install({ check: true }), /Local skill conflict/);
    assert.ok(isDir(conflict));
  });
});

// -- SelfConsumptionTests ----------------------------------------------------

describe('SelfConsumptionTests', () => {
  /** The library installs itself when source and project resolve equal. */
  const ctx = { tmp: '', base: '', library: '' };

  beforeEach(() => {
    ctx.tmp = mkdtempSync(join(tmpdir(), 'install-test-'));
    ctx.base = ctx.tmp;
    ctx.library = join(ctx.base, 'library');
    const skills = join(ctx.library, '.agents/skills');
    for (const name of ['shape-issue', 'review-issue', 'setup-basic-memory']) {
      const skill = join(skills, name);
      mkdirSync(skill, { recursive: true });
      writeText(join(skill, 'SKILL.md'), `# ${name}\n`);
    }
    const oneshot = join(skills, 'tailscale-web-dev');
    mkdirSync(oneshot, { recursive: true });
    writeText(
      join(oneshot, 'SKILL.md'),
      '---\nname: tailscale-web-dev\n' +
        'distribution: reference-only\ndescription: One-shot.\n---\n' +
        '# tailscale-web-dev\n',
    );
    const agents = join(ctx.library, '.codex/agents');
    mkdirSync(agents, { recursive: true });
    writeText(join(agents, 'issue-reviewer.toml'), 'name = "issue-reviewer"\n');
    writeText(join(ctx.library, 'AGENTS.md'), '# Library rules\n');
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  function install(options: InstallOptions = {}): string {
    return captureStdout(() =>
      installer.install(ctx.library, ctx.library, options),
    );
  }

  test('test_third_party_skills_in_the_lock_are_not_library_skills', () => {
    const upstream = join(ctx.library, '.agents/skills/memory-notes');
    mkdirSync(upstream);
    writeText(join(upstream, 'SKILL.md'), '# upstream memory-notes\n');
    writeText(
      join(ctx.library, installer.SKILLS_LOCK),
      '{"version": 2, "skills": {"memory-notes": {"source": "example/upstream"}}}',
    );
    const [installed, reference] = installer.toolkit(ctx.library, true);
    assert.ok(![...installed, ...reference].includes('memory-notes'));
    assert.ok(installed.includes('shape-issue'));
    assert.ok(!install({ memory: 'enabled' }).includes('memory-notes'));
    // The other installer's own Claude links resolve into this skill root.
    const claude = join(ctx.library, '.claude/skills');
    mkdirSync(claude, { recursive: true });
    symlinkSync('../../.agents/skills/memory-notes', join(claude, 'memory-notes'));
    install({ claude_skills: true });
    install({ claude_skills: true, check: true });
    // Its broken leftovers are not the library's to retire.
    rmSync(upstream, { recursive: true });
    assert.ok(!install({ claude_skills: true }).includes('retired:'));
    assert.ok(isSym(join(claude, 'memory-notes')));
    writeText(join(ctx.library, installer.SKILLS_LOCK), '{not json');
    throwsRegex(
      () => installer.toolkit(ctx.library),
      /Unreadable skills-lock\.json/,
    );
  });

  test('test_self_install_reports_source_dirs_and_records_choice', () => {
    const output = install({ memory: 'enabled' });
    assert.ok(output.includes('recorded: memory enabled'));
    assert.ok(output.includes('self: .agents/skills/shape-issue'));
    assert.ok(output.includes('self: .agents/skills/review-issue'));
    assert.ok(!output.includes('installed:'));
    assert.ok(!output.includes('linked:'));
    // Memory skills belong to setup_memory.py; reference-only skills get
    // the pointer block, not a managed destination.
    assert.ok(!output.includes('setup-basic-memory'));
    assert.ok(!output.includes('tailscale-web-dev'));
    for (const name of ['shape-issue', 'review-issue']) {
      const skill = join(ctx.library, '.agents/skills', name);
      assert.ok(isDir(skill));
      assert.ok(!isSym(skill));
    }
    assert.equal(installer.read_capabilities(ctx.library), 'enabled');
    const text = readText(join(ctx.library, 'AGENTS.md'));
    assert.ok(text.includes(installer.COLLAB_BLOCK));
    assert.ok(text.includes(installer.REF_START));
    assert.ok(text.includes('`.agents/skills/tailscale-web-dev/SKILL.md`'));
    assert.ok(!text.includes('.agent-workflows/'));
  });

  test('test_self_codex_profiles_are_self_managed_not_linked', () => {
    const output = install({ codex_agents: true });
    assert.ok(output.includes('self: .codex/agents/issue-reviewer.toml'));
    const target = join(ctx.library, '.codex/agents/issue-reviewer.toml');
    assert.ok(isFile(target));
    assert.ok(!isSym(target));
    install({ codex_agents: true, check: true });
  });

  test('test_self_check_names_each_destination_and_is_idempotent', () => {
    install({ memory: 'declined' });
    const output = install({ check: true });
    for (const name of ['shape-issue', 'review-issue']) {
      assert.ok(output.includes(`self: .agents/skills/${name}`));
    }
    assert.ok(!output.includes('linked:'));
    assert.ok(!output.includes('self: .agents/skills/setup-basic-memory'));
    assert.ok(!output.includes('self: .agents/skills/tailscale-web-dev'));
    assert.equal(install({ check: true }), output);
    const agents = readFileSync(join(ctx.library, 'AGENTS.md'));
    install();
    assert.deepEqual(readFileSync(join(ctx.library, 'AGENTS.md')), agents);
  });

  test('test_self_mode_still_refuses_conflicting_symlink', () => {
    install({ memory: 'declined' });
    const managed = join(ctx.library, '.agents/skills/shape-issue');
    const elsewhere = join(ctx.base, 'shape-issue-elsewhere');
    renameSync(managed, elsewhere);
    symlinkSync(elsewhere, managed);
    const before = readFileSync(join(ctx.library, 'AGENTS.md'));
    for (const check of [true, false]) {
      throwsRegex(
        () => install({ check }),
        /Conflicting symlink: .*shape-issue resolves to .*shape-issue-elsewhere; the pinned toolkit expects .*shape-issue\. Retarget it only after a reviewed decision/,
      );
      assert.ok(isSym(managed));
      assert.deepEqual(readFileSync(join(ctx.library, 'AGENTS.md')), before);
    }
  });

  test('test_self_mode_still_refuses_customized_managed_block', () => {
    install({ memory: 'declined' });
    const agents = join(ctx.library, 'AGENTS.md');
    writeText(
      agents,
      readText(agents).replace('## Working with the owner', '## Owner'),
    );
    const before = readFileSync(agents);
    for (const check of [true, false]) {
      throwsRegex(
        () => install({ check }),
        /Customized collaboration policy block/,
      );
      assert.deepEqual(readFileSync(agents), before);
    }
  });

  test('test_self_mode_never_retires_library_content', () => {
    // A leftover retired-skill directory in the library's own checkout is
    // library content, not consumer state: retirement is for consumers.
    const retired = join(ctx.library, '.agents/skills/add-integration');
    mkdirSync(retired, { recursive: true });
    writeText(join(retired, 'SKILL.md'), '# add-integration\n');
    const output = install({ memory: 'declined' });
    assert.ok(output.includes('self: .agents/skills/add-integration'));
    assert.ok(!output.includes('retired:'));
    assert.ok(!output.includes('preserved:'));
    assert.ok(isDir(retired));
    install({ memory: 'declined', check: true });
  });

  test('test_self_check_repair_command_uses_relative_script_path', () => {
    install({ memory: 'declined' });
    const agents = join(ctx.library, 'AGENTS.md');
    const text = readText(agents);
    const start = text.indexOf(installer.REF_START);
    const end = text.indexOf(installer.REF_END) + installer.REF_END.length;
    writeText(agents, text.slice(0, start) + text.slice(end));
    const before = readFileSync(agents);
    throwsRegex(
      () => install({ check: true }),
      /Missing managed block\(s\) in .*AGENTS\.md: reference-only pointer .*Repair from the consumer root: `node bin\/agent-workflows\.ts install --project \.`/,
    );
    assert.deepEqual(readFileSync(agents), before);
  });
});

// -- SkillsMigrationTests ----------------------------------------------------

describe('SkillsMigrationTests', () => {
  const ctx = { tmp: '', project: '', source: '' };

  beforeEach(() => {
    ctx.tmp = mkdtempSync(join(tmpdir(), 'install-test-'));
    ctx.project = join(ctx.tmp, 'project');
    mkdirSync(ctx.project);
    writeText(join(ctx.project, 'AGENTS.md'), '# Consumer rules\n');
    ctx.source = join(ctx.project, '.agent-workflows');
    const skill = join(ctx.source, '.agents/skills/shape-issue');
    mkdirSync(skill, { recursive: true });
    writeText(join(skill, 'SKILL.md'), '# x\n');
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  function runCli(...args: string[]) {
    return spawnSync(process.execPath, [INSTALL_SCRIPT, ...args], {
      encoding: 'utf8',
    });
  }

  test('test_old_skills_invocation_errors_with_guidance', () => {
    for (const extra of [
      ['--skills', 'shape-issue'],
      ['--skills=shape-issue'],
    ]) {
      const result = runCli('--project', ctx.project, ...extra);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes('--skills was removed'));
      assert.ok(result.stderr.includes('standard toolkit'));
      assert.ok(!existsSync(join(ctx.project, '.agents')));
    }
  });

  test('test_cli_installs_toolkit_and_records_choice', () => {
    let result = runCli('--project', ctx.project, '--memory', 'declined');
    assert.equal(result.status, 0, result.stderr);
    assert.ok(isSym(join(ctx.project, '.agents/skills/shape-issue')));
    assert.ok(!existsSync(join(ctx.project, '.agents/skills/setup-basic-memory')));
    assert.deepEqual(
      JSON.parse(readText(join(ctx.project, installer.CAPABILITIES_FILE))),
      { schema_version: 1, memory: 'declined' },
    );
    result = runCli('--project', ctx.project, '--check');
    assert.equal(result.status, 0, result.stderr);
  });

  test('test_cli_claude_skills_flag_mirrors_toolkit_and_checks', () => {
    let result = runCli(
      '--project', ctx.project, '--memory', 'declined', '--claude-skills',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(isSym(join(ctx.project, '.claude/skills/shape-issue')));
    assert.ok(!existsSync(join(ctx.project, '.claude/skills/setup-basic-memory')));
    result = runCli('--project', ctx.project, '--claude-skills', '--check');
    assert.equal(result.status, 0, result.stderr);
  });

  test('test_memory_skills_constant_is_shared_source_of_truth', () => {
    assert.deepEqual(installer.MEMORY_SKILLS, ['setup-basic-memory']);
    assert.deepEqual(installer.RETIRED_MEMORY_SKILLS, [
      'memory-notes', 'memory-capture', 'memory-continue', 'memory-schema',
    ]);
    assert.ok(
      !installer.MEMORY_SKILLS.some((name) =>
        installer.RETIRED_MEMORY_SKILLS.includes(name),
      ),
    );
  });
});

// -- DeliveryProfilesTests ---------------------------------------------------

describe('DeliveryProfilesTests', () => {
  const ctx = { tmp: '', project: '', source: '', profiles: '' };

  beforeEach(() => {
    ctx.tmp = mkdtempSync(join(tmpdir(), 'install-test-'));
    ctx.project = join(ctx.tmp, 'project');
    mkdirSync(ctx.project);
    writeText(join(ctx.project, 'AGENTS.md'), '# Consumer rules\n');
    ctx.source = join(ctx.project, '.agent-workflows');
    const skill = join(ctx.source, '.agents/skills/shape-issue');
    mkdirSync(skill, { recursive: true });
    writeText(join(skill, 'SKILL.md'), '# x\n');
    ctx.profiles = join(ctx.project, installer.DELIVERY_PROFILES);
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  function install(options: InstallOptions = {}): string {
    return captureStdout(() =>
      installer.install(ctx.source, ctx.project, options),
    );
  }

  function writeProfiles(content: string): void {
    mkdirSync(dirname(ctx.profiles), { recursive: true });
    writeText(ctx.profiles, content);
  }

  test('test_flag_creates_empty_profiles_file_when_missing', () => {
    const output = install({ delivery_profiles: true });
    assert.equal(readText(ctx.profiles), '{}\n');
    assert.ok(output.includes('created: .agents/delivery-profiles.json'));
    install({ delivery_profiles: true, check: true });
  });

  test('test_without_flag_no_file_is_created_or_touched', () => {
    install();
    assert.ok(!existsSync(ctx.profiles));
    install({ check: true });
    assert.ok(!existsSync(ctx.profiles));
    writeProfiles('custom\n');
    const output = install();
    assert.ok(!output.includes('delivery profiles'));
    assert.equal(readText(ctx.profiles), 'custom\n');
    install({ check: true });
    assert.equal(readText(ctx.profiles), 'custom\n');
  });

  test('test_repeated_runs_preserve_the_empty_file', () => {
    install({ delivery_profiles: true });
    const output = install({ delivery_profiles: true });
    assert.ok(output.includes('existing delivery profiles preserved'));
    assert.equal(readText(ctx.profiles), '{}\n');
  });

  test('test_existing_files_are_preserved_byte_for_byte', () => {
    for (const content of [
      '{\n  "default": {\n' +
        '    "implement": {"provider": "p", "model": "m"},\n' +
        '    "review": {"provider": "p", "model": "m", "reasoning": "high"}\n' +
        '  }\n}\n',
      'not json {',
      '{"default": {"implement": {"model": 42}}}',
    ]) {
      writeProfiles(content);
      const before = readFileSync(ctx.profiles);
      const output = install({ delivery_profiles: true });
      assert.ok(output.includes('existing delivery profiles preserved'));
      assert.deepEqual(readFileSync(ctx.profiles), before);
      install({ delivery_profiles: true, check: true });
      assert.deepEqual(readFileSync(ctx.profiles), before);
      unlinkSync(ctx.profiles);
    }
  });

  test('test_check_reports_outcome_without_writing', () => {
    install(); // baseline links so check reaches the profiles preflight
    throwsRegex(
      () => install({ delivery_profiles: true, check: true }),
      /Missing installation/,
    );
    assert.ok(!existsSync(ctx.profiles));
    writeProfiles('custom\n');
    const output = install({ delivery_profiles: true, check: true });
    assert.ok(output.includes('existing delivery profiles preserved'));
    assert.equal(readText(ctx.profiles), 'custom\n');
  });
});

// -- PinnedSubmoduleTests ----------------------------------------------------

describe('PinnedSubmoduleTests', () => {
  /** Real consumer/submodule Git fixtures for the detached-pin contract. */
  const ctx = {
    tmp: '',
    base: '',
    project: '',
    upstream: '',
    source: '',
    baseSha: '',
    pin: '',
  };

  beforeEach(() => {
    ctx.tmp = mkdtempSync(join(tmpdir(), 'install-test-'));
    ctx.base = ctx.tmp;
    ctx.project = join(ctx.base, 'consumer');
    ctx.upstream = join(ctx.base, 'library-source');
    mkdirSync(ctx.project);
    mkdirSync(ctx.upstream);
    for (const root of [ctx.project, ctx.upstream]) {
      gitOk(root, 'init', '-q');
    }
    for (const name of ['shape-issue', 'review-issue']) {
      const skill = join(ctx.upstream, '.agents/skills', name);
      mkdirSync(skill, { recursive: true });
      writeText(join(skill, 'SKILL.md'), `# ${name}\n`);
    }
    const docs = join(ctx.upstream, 'docs');
    mkdirSync(docs);
    writeText(join(docs, 'worktrees.md'), '# policy\n');
    gitOk(ctx.upstream, 'add', '.');
    commit(ctx.upstream, 'library base');
    ctx.baseSha = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
    writeText(join(ctx.upstream, 'CHANGELOG.md'), '# changelog\n');
    gitOk(ctx.upstream, 'add', '.');
    commit(ctx.upstream, 'library pin');
    ctx.pin = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
    gitOk(
      ctx.project,
      '-c', 'protocol.file.allow=always',
      'submodule', 'add', '-q', ctx.upstream, '.agent-workflows',
    );
    ctx.source = join(ctx.project, '.agent-workflows');
    writeText(join(ctx.project, 'AGENTS.md'), '# Consumer rules\n');
    gitOk(ctx.project, 'add', '.gitmodules', '.agent-workflows', 'AGENTS.md');
    commit(ctx.project, 'consumer pin');
    // `git submodule add` leaves an attached checkout; give tests a known
    // branch name regardless of the platform's default branch.
    gitOk(ctx.source, 'checkout', '-qB', 'reviewed');
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  function install(options: InstallOptions = {}): string {
    return captureStdout(() =>
      installer.install(ctx.source, ctx.project, options),
    );
  }

  function head(): string {
    return gitOk(ctx.source, 'rev-parse', 'HEAD');
  }

  function branch(): string | null {
    const result = spawnSync(
      'git',
      ['-C', ctx.source, 'symbolic-ref', '-q', 'HEAD'],
      { encoding: 'utf8' },
    );
    return result.status === 0 ? (result.stdout as string).trim() : null;
  }

  test('test_attached_submodule_at_pin_detaches_in_place', () => {
    const output = install();
    assert.ok(output.includes(`detached: .agent-workflows at ${ctx.pin}`));
    assert.ok(
      output.includes(`verified: .agent-workflows detached at ${ctx.pin}`),
    );
    assert.equal(branch(), null);
    assert.equal(head(), ctx.pin);
    // The branch is preserved, not moved or deleted.
    assert.equal(gitOk(ctx.source, 'rev-parse', 'refs/heads/reviewed'), ctx.pin);
    const again = install();
    assert.ok(!again.includes('detached:'));
    assert.ok(
      again.includes(`verified: .agent-workflows detached at ${ctx.pin}`),
    );
    install({ check: true });
  });

  test('test_fresh_detached_checkout_verifies_and_stays_idempotent', () => {
    gitOk(ctx.source, 'checkout', '-q', '--detach', 'HEAD');
    const output = install();
    assert.ok(!output.includes('detached:'));
    assert.ok(
      output.includes(`verified: .agent-workflows detached at ${ctx.pin}`),
    );
    install();
    install({ check: true });
    assert.equal(branch(), null);
    assert.equal(head(), ctx.pin);
  });

  test('test_check_reports_attached_checkout_without_changing_it', () => {
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(
      () => install({ check: true }),
      /Pinned library \.agent-workflows is attached to branch 'reviewed'.*Repair from the consumer root: `node \.agent-workflows\/bin\/agent-workflows\.ts install --project \.`/,
    );
    assert.equal(branch(), 'refs/heads/reviewed');
    assert.equal(head(), ctx.pin);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
  });

  test('test_dirty_submodule_stops_before_mutation', () => {
    const untracked = join(ctx.source, 'untracked.txt');
    writeText(untracked, 'local\n');
    throwsRegex(() => install(), /is dirty/);
    assert.equal(branch(), 'refs/heads/reviewed');
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    unlinkSync(untracked);
    const tracked = join(ctx.source, 'docs/worktrees.md');
    const original = readFileSync(tracked);
    writeText(tracked, 'edited\n');
    throwsRegex(() => install({ check: true }), /is dirty/);
    writeFileSync(tracked, original);
  });

  test('test_local_commits_ahead_of_pin_stop_before_mutation', () => {
    writeText(join(ctx.source, 'local.py'), 'x\n');
    gitOk(ctx.source, 'add', 'local.py');
    commit(ctx.source, 'local work');
    const local = head();
    assert.notEqual(local, ctx.pin);
    const before = readFileSync(join(ctx.project, 'AGENTS.md'));
    throwsRegex(() => install(), /ahead of the recorded pin.*preserve/);
    assert.equal(head(), local);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    assert.deepEqual(readFileSync(join(ctx.project, 'AGENTS.md')), before);
  });

  test('test_unexplained_pin_difference_stops_before_mutation', () => {
    gitOk(ctx.source, 'checkout', '-q', ctx.baseSha);
    throwsRegex(() => install(), /differs from the consumer's recorded pin/);
    assert.equal(head(), ctx.baseSha);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    // Attachment at another commit is a pin difference, not a detach.
    gitOk(ctx.source, 'checkout', '-qB', 'older', ctx.baseSha);
    throwsRegex(() => install(), /differs from the consumer's recorded pin/);
    assert.equal(branch(), 'refs/heads/older');
    assert.equal(head(), ctx.baseSha);
  });

  test('test_reviewed_target_adoption_verifies_after_staging_the_pin', () => {
    writeText(join(ctx.upstream, 'new.txt'), 'new\n');
    gitOk(ctx.upstream, 'add', '.');
    commit(ctx.upstream, 'reviewed target');
    const target = gitOk(ctx.upstream, 'rev-parse', 'HEAD');
    gitOk(ctx.source, 'fetch', '-q', 'origin');
    gitOk(ctx.source, 'checkout', '-q', '--detach', target);
    assert.equal(head(), target);
    // The recorded pin still names the old revision until it is staged.
    throwsRegex(() => install(), /ahead of the recorded pin/);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
    gitOk(ctx.project, 'add', '.agent-workflows');
    const output = install();
    assert.ok(
      output.includes(`verified: .agent-workflows detached at ${target}`),
    );
    assert.equal(branch(), null);
    assert.equal(head(), target);
    install({ check: true });
  });

  test('test_uninitialized_registered_submodule_reports_actionably', () => {
    gitOk(ctx.project, 'submodule', 'deinit', '-q', '--force', '.agent-workflows');
    throwsRegex(() => install(), /registered but uninitialized/);
  });

  test('test_corrupt_submodule_index_stops_before_writes', () => {
    gitOk(ctx.source, 'checkout', '-q', '--detach', ctx.pin);
    const index = join(
      gitOk(ctx.source, 'rev-parse', '--absolute-git-dir'),
      'index',
    );
    writeFileSync(index, Buffer.from('corrupt', 'utf8'));
    throwsRegex(() => install(), /Could not inspect.*status/);
    assert.ok(!existsSync(join(ctx.project, '.agents')));
  });

  test('test_nested_project_is_rejected_before_writes', () => {
    const nested = join(ctx.project, 'nested');
    mkdirSync(nested);
    gitOk(ctx.project, 'mv', '.agent-workflows', 'nested/.agent-workflows');
    ctx.project = nested;
    ctx.source = join(nested, '.agent-workflows');
    writeText(join(nested, 'AGENTS.md'), '# Nested');
    for (const check of [false, true]) {
      throwsRegex(() => install({ check }), /Git worktree root/);
    }
    assert.ok(!existsSync(join(nested, '.agents')));
    assert.equal(branch(), 'refs/heads/reviewed');
  });

  test('test_changed_pin_during_install_cannot_verify', () => {
    // The Python test patches installer.make_relative_link; the port
    // exposes the same seam as an internal linkHook option.
    let changed = false;
    const linkHook = () => {
      if (!changed) {
        changed = true;
        gitOk(ctx.source, 'checkout', '-q', '--detach', ctx.baseSha);
        gitOk(ctx.project, 'add', '.agent-workflows');
      }
    };
    throwsRegex(
      () => install({ linkHook }),
      /did not verify detached/,
    );
  });

  test('test_branch_inspection_error_stops_before_writes', () => {
    // The Python test patches installer.subprocess.run; the port exposes
    // the same seam as an internal runGitImpl option.
    const runGitImpl = (root: string, args: string[]): GitResult =>
      args.includes('symbolic-ref')
        ? { status: 128, stdout: '', stderr: 'Git error' }
        : runGit(root, args);
    throwsRegex(
      () => install({ runGitImpl }),
      /Could not inspect.*branch/,
    );
    assert.ok(!existsSync(join(ctx.project, '.agents')));
  });

  test('test_unregistered_library_checkout_keeps_its_branch', () => {
    // A plain clone inside a Git consumer is not a registered submodule.
    const clone = join(ctx.project, 'library-clone');
    gitOk(ctx.project, 'clone', '-q', ctx.upstream, clone);
    const ref = gitOk(clone, 'symbolic-ref', '-q', 'HEAD');
    assert.ok(ref !== '');
    const output = captureStdout(() => installer.install(clone, ctx.project));
    assert.ok(!output.includes('detached'));
    assert.ok(gitOk(clone, 'symbolic-ref', '-q', 'HEAD') !== '');
    // Nor is a standalone development checkout used as its own project.
    writeText(join(clone, 'AGENTS.md'), '# Library\n');
    captureStdout(() => installer.install(clone, clone));
    assert.ok(gitOk(clone, 'symbolic-ref', '-q', 'HEAD') !== '');
  });
});

// -- DistributionTests (tests/test_milestone_delivery.py install cases) -------

describe('DistributionTests', () => {
  const DELIVER_MILESTONE = join(
    ROOT, '.agents/skills/deliver-milestone/SKILL.md',
  );

  test('test_deliver_milestone_is_an_installed_toolkit_skill', () => {
    const [installed, referenceOnly] = installer.toolkit(ROOT);
    assert.ok(installed.includes('deliver-milestone'));
    assert.ok(!referenceOnly.includes('deliver-milestone'));
  });

  test('test_deliver_milestone_frontmatter_is_installable', () => {
    const frontmatter = readText(DELIVER_MILESTONE).split('---', 3)[1];
    assert.ok(!frontmatter.includes('distribution:'));
    assert.ok(frontmatter.includes('name: deliver-milestone'));
  });
});

// -- ParityHarnessTests ------------------------------------------------------
// No Python counterpart: the harness itself is TypeScript-only. These
// guard its file-tree comparison directly.

describe('ParityHarnessTests', () => {
  const ctx = { tmp: '' };

  beforeEach(() => {
    ctx.tmp = mkdtempSync(join(tmpdir(), 'parity-tree-'));
  });

  afterEach(() => {
    rmSync(ctx.tmp, { recursive: true, force: true });
  });

  test('test_file_tree_distinguishes_symlink_from_regular_file', () => {
    // A symlink whose text is `target` must not compare equal to a
    // regular file containing the bytes `target`.
    const py = join(ctx.tmp, 'py');
    const ts = join(ctx.tmp, 'ts');
    mkdirSync(py);
    mkdirSync(ts);
    symlinkSync('target', join(py, 'entry'));
    writeText(join(ts, 'entry'), 'target');
    const diffs = compareTrees(fileTree(py), fileTree(ts));
    assert.equal(diffs.length, 1);
    assert.ok(diffs[0].includes('entry'));
  });

  test('test_file_tree_still_compares_link_text_and_file_bytes', () => {
    const py = join(ctx.tmp, 'py');
    const ts = join(ctx.tmp, 'ts');
    mkdirSync(py);
    mkdirSync(ts);
    symlinkSync('target', join(py, 'link'));
    symlinkSync('target', join(ts, 'link'));
    writeText(join(py, 'file'), 'same');
    writeText(join(ts, 'file'), 'different');
    const diffs = compareTrees(fileTree(py), fileTree(ts));
    assert.equal(diffs.length, 1);
    assert.ok(diffs[0].includes('file'));
    assert.ok(!diffs[0].includes('link'));
  });
});
