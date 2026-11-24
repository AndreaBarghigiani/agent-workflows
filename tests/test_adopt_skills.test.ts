/**
 * TypeScript counterparts of `tests/test_adopt_skills.py`
 * (`AdoptSkillsTests`, 32 tests). The suite mirrors the Python file
 * test-for-test — see docs/node-port.md for the mapping.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, test, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as adopt_skills from '../scripts/adopt_skills.ts';
import { pyJsonLoads } from '../scripts/lib/pyloads.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ADOPT_TS = join(ROOT, 'scripts', 'adopt_skills.ts');
const ADOPTED_FIXTURE = join(ROOT, 'tests', 'fixtures', 'adopted-consumer');

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
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

function throwsRegex(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern);
}

describe('AdoptSkillsTests', () => {
  const ctx = { base: '', project: '', library: '' };

  beforeEach(() => {
    ctx.base = mkdtempSync(join(tmpdir(), 'adopt-skills-'));
    ctx.project = join(ctx.base, 'project');
    mkdirSync(ctx.project);
    ctx.library = join(ctx.base, 'library');
    for (const name of ['shape-issue', 'setup-basic-memory']) {
      const skill = join(ctx.library, '.agents/skills', name);
      mkdirSync(skill, { recursive: true });
      writeText(
        join(skill, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Toolkit skill.\n---\n` +
          `# ${name}\n`,
      );
    }
  });

  afterEach(() => {
    rmSync(ctx.base, { recursive: true, force: true });
  });

  function copy(
    folder: string,
    name: string,
    options: { marker?: string; extra?: Record<string, string> } = {},
  ): string {
    const path = join(ctx.project, folder, 'skills', name);
    mkdirSync(path, { recursive: true });
    const body = options.marker ?? `# ${name}\n`;
    writeText(
      join(path, 'SKILL.md'),
      `---\nname: ${name}\nsource: vendortool\nversion: 1.0\n---\n${body}`,
    );
    for (const [rel, content] of Object.entries(options.extra ?? {})) {
      writeText(join(path, rel), content);
    }
    return path;
  }

  function adopt(options: adopt_skills.AdoptOptions = {}): string[] {
    return adopt_skills.adopt(ctx.project, ctx.library, options);
  }

  function manifest(): Map<string, unknown> {
    return (pyJsonLoads(
      readText(join(ctx.project, adopt_skills.MANIFEST)),
    ) as Map<string, unknown>).get('skills') as Map<string, unknown>;
  }

  function record(name: string): Map<string, unknown> {
    return manifest().get(name) as Map<string, unknown>;
  }

  function canonical(name: string): string {
    return join(ctx.project, '.agents/skills', name);
  }

  test('test_external_skills_folder_refused_before_mutation', () => {
    const external = join(ctx.base, 'external');
    mkdirSync(external);
    mkdirSync(join(external, 'demo'));
    writeText(join(external, 'demo/SKILL.md'), '# demo');
    mkdirSync(join(ctx.project, '.claude'));
    symlinkSync(external, join(ctx.project, '.claude/skills'));
    throwsRegex(() => adopt({ apply: true }), /escapes project/);
    assert.ok(isFile(join(external, 'demo/SKILL.md')));
    assert.ok(!existsSync(canonical('demo')));
  });

  test('test_manifest_collisions_refused_before_mutation', () => {
    const copyPath = copy('.claude', 'demo');
    const manifestPath = join(ctx.project, adopt_skills.MANIFEST);
    mkdirSync(dirname(manifestPath));
    const external = join(ctx.base, 'manifest.json');
    const content = '{"schema_version": 1, "skills": {}}';
    writeText(external, content);
    symlinkSync(external, manifestPath);
    throwsRegex(() => adopt({ apply: true }), /Unsafe manifest/);
    assert.equal(readText(external), content);
    assert.ok(isDir(copyPath));
    unlinkSync(manifestPath);
    mkdirSync(manifestPath);
    throwsRegex(() => adopt({ apply: true }), /Unsafe manifest/);
    assert.ok(isDir(copyPath));
  });

  test('test_redirected_storage_refused', () => {
    const copyPath = copy('.claude', 'demo');
    const external = join(ctx.base, 'external');
    mkdirSync(external);
    symlinkSync(external, join(ctx.project, '.agents'));
    throwsRegex(() => adopt({ apply: true }), /Unsafe storage/);
    assert.ok(isDir(copyPath));
    assert.deepEqual(readdirSync(external), []);
  });

  test('test_unknown_alias_of_native_folder_keeps_loading', () => {
    copy('.codex', 'demo');
    mkdirSync(join(ctx.project, '.windsurf'));
    symlinkSync('../.codex/skills', join(ctx.project, '.windsurf/skills'));
    adopt({ apply: true });
    for (const folder of ['.codex', '.windsurf']) {
      const link = join(ctx.project, folder, 'skills/demo');
      assert.ok(isSym(link));
      assert.equal(realpathSync(link), realpathSync(canonical('demo')));
    }
    assert.deepEqual(adopt({ apply: true }), ['nothing to do']);
  });

  test('test_quoted_secrets_redacted_completely', () => {
    const commands: [string, string][] = [
      ['install --token="abc123"', 'install --token=<redacted>'],
      ["install --password 'two words'", 'install --password=<redacted>'],
      ["AUTH_TOKEN='two words' install", 'AUTH_TOKEN=<redacted> install'],
      [
        'install --token="two words" --safe=yes',
        'install --token=<redacted> --safe=yes',
      ],
    ];
    for (const [command, expected] of commands) {
      assert.equal(adopt_skills.redact_command(command), expected);
    }
  });

  test('test_manifest_traversal_names_refused_before_mutation', () => {
    const copyPath = copy('.claude', 'demo');
    const manifestPath = join(ctx.project, adopt_skills.MANIFEST);
    mkdirSync(dirname(manifestPath));
    for (const name of ['../../escaped', '/tmp/escaped', '.', '..', 'a/b', 'a\\b']) {
      writeText(
        manifestPath,
        JSON.stringify({ schema_version: 1, skills: { [name]: {} } }),
      );
      throwsRegex(
        () => adopt({ apply: true }),
        /Invalid manifest skill name/,
      );
      assert.ok(isDir(copyPath));
      assert.ok(!existsSync(canonical('demo')));
    }
  });

  test('test_aliases_into_excluded_storage_refused', () => {
    for (const excluded of ['.agents', '.agent-workflows', '.git']) {
      const target = join(ctx.project, excluded, 'vendor-skills');
      mkdirSync(join(target, 'demo'), { recursive: true });
      writeText(join(target, 'demo/SKILL.md'), '# demo');
      const folder = join(ctx.project, '.claude');
      mkdirSync(folder, { recursive: true });
      const link = join(folder, 'skills');
      symlinkSync(target, link);
      throwsRegex(() => adopt({ apply: true }), /excluded storage/);
      assert.ok(isFile(join(target, 'demo/SKILL.md')));
      unlinkSync(link);
    }
  });

  test('test_shell_option_names_and_underscore_secrets_redacted', () => {
    copy('.claude', 'demo');
    adopt({
      apply: true,
      command:
        'install "--token" "synthetic secret" --api_key synthetic-key ' +
        '--client_secret="other secret"',
    });
    const command = record('demo').get('command') as string;
    for (const secret of ['synthetic secret', 'synthetic-key', 'other secret']) {
      assert.ok(!command.includes(secret));
    }
    assert.equal(command.split('<redacted>').length - 1, 3);
    assert.equal(
      adopt_skills.redact_command('install --token "bad'),
      '<redacted: unparseable command>',
    );
  });

  test('test_dedupe_preserves_source_when_canonical_changes_after_plan', () => {
    for (const change of ['delete', 'edit']) {
      const name = `demo-${change}`;
      const source = copy('.claude', name);
      const target = canonical(name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true });
      const plan = adopt_skills.plan_adoption(ctx.project, ctx.library);
      if (change === 'delete') {
        rmSync(target, { recursive: true });
      } else {
        writeText(join(target, 'SKILL.md'), '# owner edit');
      }
      const lines = adopt_skills.apply_adoption(ctx.project, plan);
      assert.ok(isDir(source));
      assert.ok(!isSym(source));
      assert.ok(lines.join('\n').includes('canonical changed'));
    }
  });

  test('test_update_preserves_concurrent_canonical_and_source_edits', () => {
    copy('.claude', 'demo');
    adopt({ apply: true });
    const link = join(ctx.project, '.claude/skills/demo');
    unlinkSync(link);
    const source = copy('.claude', 'demo', { marker: '# vendor update' });
    let plan = adopt_skills.plan_adoption(ctx.project, ctx.library);
    writeText(join(canonical('demo'), 'SKILL.md'), '# owner edit');
    let lines = adopt_skills.apply_adoption(ctx.project, plan);
    assert.ok(lines.join('\n').includes('canonical changed'));
    assert.ok(isDir(source));
    assert.equal(
      readText(join(canonical('demo'), 'SKILL.md')),
      '# owner edit',
    );
    plan = adopt_skills.plan_adoption(ctx.project, ctx.library);
    // A separate fresh adoption must also preserve a source edited after
    // planning.
    const fresh = copy('.claude', 'fresh');
    plan = adopt_skills.plan_adoption(ctx.project, ctx.library);
    writeText(join(fresh, 'SKILL.md'), '# changed source');
    lines = adopt_skills.apply_adoption(ctx.project, plan);
    assert.ok(lines.join('\n').includes('selected copy changed'));
    assert.ok(isDir(fresh));
    assert.ok(!existsSync(canonical('fresh')));
  });

  test('test_retargeted_alias_cannot_redirect_planned_source', () => {
    const internal = join(ctx.project, 'vendor');
    const external = join(ctx.base, 'external');
    mkdirSync(join(internal, 'demo'), { recursive: true });
    writeText(join(internal, 'demo/SKILL.md'), '# demo');
    cpSync(internal, external, { recursive: true });
    mkdirSync(join(ctx.project, '.claude'));
    const alias = join(ctx.project, '.claude/skills');
    symlinkSync(internal, alias);
    const plan = adopt_skills.plan_adoption(ctx.project, ctx.library);
    unlinkSync(alias);
    symlinkSync(external, alias);
    adopt_skills.apply_adoption(ctx.project, plan);
    assert.ok(isFile(join(external, 'demo/SKILL.md')));
    assert.ok(!isSym(join(external, 'demo')));
    assert.ok(isDir(canonical('demo')));
  });

  test('test_replaced_physical_source_parent_preserved', () => {
    const internal = join(ctx.project, 'vendor');
    const external = join(ctx.base, 'external');
    mkdirSync(join(internal, 'demo'), { recursive: true });
    writeText(join(internal, 'demo/SKILL.md'), '# demo');
    cpSync(internal, external, { recursive: true });
    mkdirSync(join(ctx.project, '.claude'));
    symlinkSync(internal, join(ctx.project, '.claude/skills'));
    const plan = adopt_skills.plan_adoption(ctx.project, ctx.library);
    renameSync(internal, join(ctx.project, 'original-vendor'));
    symlinkSync(external, internal);
    const lines = adopt_skills.apply_adoption(ctx.project, plan);
    assert.ok(lines.join('\n').includes('source location changed'));
    assert.ok(isFile(join(external, 'demo/SKILL.md')));
    assert.ok(!existsSync(canonical('demo')));
  });

  test('test_check_and_apply_are_mutually_exclusive', () => {
    const source = copy('.claude', 'demo');
    const result = spawnSync(
      process.execPath,
      [ADOPT_TS, '--project', ctx.project, '--apply', '--check'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.ok(isDir(source));
    assert.ok(!isSym(source));
    assert.ok(!existsSync(canonical('demo')));
  });

  test('test_relink_refuses_redirected_parent', () => {
    copy('.claude', 'demo');
    adopt({ apply: true });
    const folder = join(ctx.project, '.gemini/skills');
    mkdirSync(folder, { recursive: true });
    const plan = adopt_skills.plan_adoption(ctx.project, ctx.library);
    rmdirSync(folder);
    mkdirSync(join(ctx.project, '.git'));
    symlinkSync('../.git', folder);
    const lines = adopt_skills.apply_adoption(ctx.project, plan);
    assert.ok(lines.join('\n').includes('link location changed'));
    assert.ok(!existsSync(join(ctx.project, '.git/demo')));
    assert.ok(isDir(canonical('demo')));
  });

  test('test_identical_copies_across_three_folders', () => {
    for (const folder of ['.claude', '.codex', '.opencode']) {
      copy(folder, 'palette', { extra: { 'refs/guide.md': 'guide\n' } });
    }
    const lines = adopt({ apply: true, today: '2026-11-16' });
    const joined = lines.join('\n');
    assert.ok(joined.includes('adopted: .agents/skills/palette'));
    const target = canonical('palette');
    assert.ok(isDir(target));
    assert.ok(!isSym(target));
    // Native readers lose the copy outright; Claude gets a relative link.
    assert.ok(!existsSync(join(ctx.project, '.codex/skills/palette')));
    assert.ok(!existsSync(join(ctx.project, '.opencode/skills/palette')));
    const link = join(ctx.project, '.claude/skills/palette');
    assert.ok(isSym(link));
    assert.equal(realpathSync(link), realpathSync(target));
    const palette = record('palette');
    assert.ok((palette.get('hash') as string).startsWith('sha256:'));
    assert.equal(palette.get('adopted'), '2026-11-16');
    assert.equal(palette.get('source'), 'vendortool');
    assert.equal(palette.get('version'), '1.0');
    assert.ok((palette.get('paths') as string[]).includes(
      '.claude/skills/palette'));
  });

  test('test_differing_copies_refused', () => {
    copy('.claude', 'palette', { marker: '# v1\n' });
    copy('.codex', 'palette', { marker: '# v2\n' });
    const lines = adopt({ apply: true });
    assert.ok(lines.join('\n').includes('copies differ'));
    assert.ok(!existsSync(canonical('palette')));
    assert.ok(isDir(join(ctx.project, '.claude/skills/palette')));
    assert.ok(isDir(join(ctx.project, '.codex/skills/palette')));
  });

  test('test_single_folder_skill_adopted', () => {
    copy('.claude', 'solo');
    adopt({ apply: true, today: '2026-11-16' });
    assert.ok(isDir(canonical('solo')));
    const link = join(ctx.project, '.claude/skills/solo');
    assert.ok(isSym(link));
    assert.equal(realpathSync(link), realpathSync(canonical('solo')));
  });

  test('test_existing_identical_canonical_dedupes', () => {
    const target = copy('.agents', 'palette');
    copy('.claude', 'palette');
    copy('.codex', 'palette');
    const lines = adopt({ apply: true, today: '2026-11-16' });
    assert.ok(lines.join('\n').includes('dedupe'));
    assert.ok(isDir(target));
    assert.ok(!isSym(target));
    assert.ok(!existsSync(join(ctx.project, '.codex/skills/palette')));
    const link = join(ctx.project, '.claude/skills/palette');
    assert.ok(isSym(link));
    assert.equal(realpathSync(link), realpathSync(target));
  });

  test('test_existing_different_canonical_refused', () => {
    const target = canonical('palette');
    mkdirSync(target, { recursive: true });
    writeText(join(target, 'SKILL.md'), '# local version\n');
    copy('.claude', 'palette');
    const lines = adopt({ apply: true });
    assert.ok(lines.join('\n').includes('differ from existing'));
    assert.equal(readText(join(target, 'SKILL.md')), '# local version\n');
    assert.ok(isDir(join(ctx.project, '.claude/skills/palette')));
  });

  test('test_toolkit_name_clash_refused', () => {
    copy('.claude', 'shape-issue');
    const lines = adopt({ apply: true });
    assert.ok(lines.join('\n').includes('clashes'));
    assert.ok(!existsSync(canonical('shape-issue')));
    assert.ok(isDir(join(ctx.project, '.claude/skills/shape-issue')));
  });

  test('test_existing_symlink_entries_skipped', () => {
    const skills = join(ctx.project, '.claude/skills');
    mkdirSync(skills, { recursive: true });
    const link = join(skills, 'shape-issue');
    symlinkSync(join(ctx.library, '.agents/skills/shape-issue'), link);
    const lines = adopt({ apply: true });
    assert.deepEqual(lines, ['nothing to do']);
    assert.ok(isSym(link));
    assert.ok(!existsSync(join(ctx.project, adopt_skills.MANIFEST)));
  });

  test('test_unknown_hidden_folder_linked', () => {
    copy('.windsurf', 'palette');
    adopt({ apply: true, today: '2026-11-16' });
    assert.ok(isDir(canonical('palette')));
    const link = join(ctx.project, '.windsurf/skills/palette');
    assert.ok(isSym(link));
    assert.equal(realpathSync(link), realpathSync(canonical('palette')));
  });

  test('test_non_hidden_skills_folders_ignored', () => {
    copy('packages', 'palette');
    copy('vendor', 'other');
    const lines = adopt({ apply: true });
    assert.deepEqual(lines, ['nothing to do']);
    assert.ok(isDir(join(ctx.project, 'packages/skills/palette')));
    assert.ok(!existsSync(canonical('palette')));
  });

  test('test_secret_redaction_in_recorded_command', () => {
    copy('.claude', 'palette');
    adopt({
      apply: true,
      today: '2026-11-16',
      command:
        'npx skills add palette --token=abc123 --key mykey' +
        ' AUTH_TOKEN=zzz --verbose',
    });
    const command = record('palette').get('command') as string;
    assert.ok(!command.includes('abc123'));
    assert.ok(!command.includes('mykey'));
    assert.ok(!command.includes('zzz'));
    assert.ok(command.includes('--token=<redacted>'));
    assert.ok(command.includes('--key=<redacted>'));
    assert.ok(command.includes('AUTH_TOKEN=<redacted>'));
    assert.ok(command.includes('--verbose'));
  });

  test('test_drift_after_vendor_recopy_updates_canonical', () => {
    copy('.claude', 'palette', { marker: '# v1\n' });
    adopt({ apply: true, today: '2026-11-15' });
    const original = record('palette').get('hash') as string;
    // A vendor re-install recreates identical copies with new content.
    unlinkSync(join(ctx.project, '.claude/skills/palette'));
    for (const folder of ['.claude', '.codex']) {
      copy(folder, 'palette', { marker: '# v2\n' });
    }
    const lines = adopt({ apply: true, today: '2026-11-16' });
    assert.ok(lines.join('\n').includes('updated:'));
    const target = canonical('palette');
    assert.ok(readText(join(target, 'SKILL.md')).includes('# v2'));
    const palette = record('palette');
    assert.notEqual(palette.get('hash'), original);
    assert.equal(palette.get('adopted'), '2026-11-15');
    assert.equal(palette.get('updated'), '2026-11-16');
  });

  test('test_drift_refused_when_canonical_was_edited', () => {
    copy('.claude', 'palette', { marker: '# v1\n' });
    adopt({ apply: true, today: '2026-11-15' });
    const target = canonical('palette');
    writeText(join(target, 'SKILL.md'), '# owner edit\n');
    unlinkSync(join(ctx.project, '.claude/skills/palette'));
    copy('.claude', 'palette', { marker: '# v2\n' });
    const lines = adopt({ apply: true });
    assert.ok(lines.join('\n').includes('differ from existing'));
    assert.equal(readText(join(target, 'SKILL.md')), '# owner edit\n');
  });

  test('test_idempotent_rerun', () => {
    for (const folder of ['.claude', '.codex']) {
      copy(folder, 'palette');
    }
    adopt({ apply: true, today: '2026-11-16' });
    const lines = adopt({ apply: true });
    assert.deepEqual(lines, ['nothing to do']);
    assert.ok(isDir(canonical('palette')));
    assert.ok(isSym(join(ctx.project, '.claude/skills/palette')));
  });

  test('test_dry_run_writes_nothing', () => {
    copy('.claude', 'palette');
    copy('.codex', 'palette');
    const lines = adopt();
    const joined = lines.join('\n');
    assert.ok(joined.includes('adopt:'));
    assert.ok(joined.includes('link:'));
    assert.ok(!existsSync(canonical('palette')));
    assert.ok(isDir(join(ctx.project, '.claude/skills/palette')));
    assert.ok(!isSym(join(ctx.project, '.claude/skills/palette')));
    assert.ok(!existsSync(join(ctx.project, adopt_skills.MANIFEST)));
  });

  test('test_unsafe_internal_symlink_refused', () => {
    const path = copy('.claude', 'palette');
    symlinkSync('SKILL.md', join(path, 'linked.md'));
    const lines = adopt({ apply: true });
    assert.ok(lines.join('\n').includes('unsafe'));
    assert.ok(isSym(join(path, 'linked.md')));
    assert.ok(!existsSync(canonical('palette')));
  });

  test('test_skills_dir_alias_of_canonical_not_scanned', () => {
    const target = canonical('palette');
    mkdirSync(target, { recursive: true });
    writeText(join(target, 'SKILL.md'), '# palette\n');
    const claude = join(ctx.project, '.claude');
    mkdirSync(claude);
    symlinkSync('../.agents/skills', join(claude, 'skills'));
    const lines = adopt({ apply: true });
    const joined = lines.join('\n');
    assert.ok(joined.includes('alias of .agents/skills'));
    assert.ok(!joined.includes('adopted:'));
    assert.ok(isDir(target));
    assert.ok(!isSym(target));
  });

  test('test_hidden_top_level_symlink_skipped', () => {
    copy('.claude', 'palette');
    const alias = join(ctx.project, '.mirror');
    symlinkSync('.claude', alias);
    const lines = adopt({ apply: true, today: '2026-11-16' });
    assert.ok(lines.join('\n').includes('hidden folder is a symlink'));
    assert.ok(isDir(canonical('palette')));
  });

  test('test_new_harness_folder_gets_links_for_known_skills', () => {
    copy('.claude', 'palette');
    adopt({ apply: true, today: '2026-11-16' });
    mkdirSync(join(ctx.project, '.gemini/skills'), { recursive: true });
    const lines = adopt({ apply: true });
    assert.ok(lines.join('\n').includes('linked: .gemini/skills/palette'));
    const link = join(ctx.project, '.gemini/skills/palette');
    assert.ok(isSym(link));
    assert.equal(realpathSync(link), realpathSync(canonical('palette')));
  });
});

// -- AdoptionRecordFixtureTests ---------------------------------------------
// No Python counterpart: tests/fixtures/adopted-consumer holds the on-disk
// state `adopt_skills.py --apply` produced (canonical copy, provenance
// manifest, harness link). The TypeScript port must verify the recorded
// hash and adoption record unchanged against that shared fixture.

describe('AdoptionRecordFixtureTests', () => {
  test('test_python_recorded_hash_and_manifest_verify_unchanged', () => {
    const canonical = join(ADOPTED_FIXTURE, '.agents/skills', 'palette');
    const manifest = adopt_skills.read_manifest(ADOPTED_FIXTURE);
    const records = manifest.get('skills') as Map<string, unknown>;
    const record = records.get('palette') as Map<string, unknown>;
    const [digest, unsafe] = adopt_skills.skill_signature(canonical);
    assert.deepEqual(unsafe, []);
    assert.equal(record.get('hash'), `sha256:${digest}`);
    // A fully-adopted consumer with intact links plans no further work.
    const library = mkdtempSync(join(tmpdir(), 'adopt-library-'));
    try {
      const lines = adopt_skills.adopt(ADOPTED_FIXTURE, library);
      assert.deepEqual(lines, ['nothing to do']);
    } finally {
      rmSync(library, { recursive: true, force: true });
    }
  });
});
