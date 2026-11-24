/**
 * `node:test` coverage for `scripts/validate.ts` YAML frontmatter
 * semantics (issue #118): PyYAML `safe_load` is YAML 1.1, so an unquoted
 * `description: yes` resolves to a boolean and must be rejected. The
 * `yaml` package only agrees when the parser uses the 1.1 schema.
 *
 * Each case runs the validator against a disposable repo root — a copied
 * `scripts/` tree plus one skill — so no repository skills are touched.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function makeRoot(description: string, name = 'yaml-words'): string {
  const root = mkdtempSync(join(tmpdir(), 'validate-'));
  cpSync(join(ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
  // Bare `yaml` imports resolve through this link; the Markdown walk
  // skips `node_modules` like the real root's.
  symlinkSync(join(ROOT, 'node_modules'), join(root, 'node_modules'));
  const skill = join(root, '.agents', 'skills', name);
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n`,
  );
  return root;
}

function validate(root: string) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'validate.ts')], {
    encoding: 'utf8',
  });
}

describe('ValidateYaml11Tests', () => {
  for (const word of ['yes', 'no', 'on', 'off']) {
    test(`description: ${word} is not a string`, () => {
      const result = validate(makeRoot(word));
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Duplicate name or missing description/);
    });
  }

  test('description: "yes" stays a string', () => {
    const result = validate(makeRoot('"yes"'));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Validated 1 skills/);
  });

  test('description: !custom fails on the unresolved tag', () => {
    const result = validate(makeRoot('!custom hello'));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unresolved tag/);
    assert.doesNotMatch(result.stdout, /Validated/);
  });

  test('an unresolved tag in agents/openai.yaml fails', () => {
    const root = makeRoot('a string');
    const agents = join(root, '.agents', 'skills', 'yaml-words', 'agents');
    mkdirSync(agents);
    writeFileSync(join(agents, 'openai.yaml'), 'display_name: !custom hello\n');
    const result = validate(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unresolved tag/);
    assert.doesNotMatch(result.stdout, /Validated/);
  });

  test('the repository itself validates', () => {
    const result = validate(ROOT);
    assert.equal(result.status, 0, result.stderr);
  });
});
