/**
 * TypeScript port of `scripts/validate.py` (issue #118): validate shared
 * metadata, profiles, and relative Markdown supporting links.
 *
 * `main` ignores argv exactly like the Python entry point — the script
 * never had a command-line interface. YAML goes through the `yaml`
 * devDependency (PyYAML `safe_load` is permissive, so `uniqueKeys` is off)
 * and TOML through the vendored smol-toml load path carrying the
 * `tomllib` verdict (`tomlLoads`), so accepted and rejected documents
 * agree with the Python original.
 */
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument, YAMLParseError } from 'yaml';
import { third_party_skills } from './install.ts';
import { pyResolve } from './install.ts';
import { pyTruthy, tomlLoads } from './memory_connections.ts';
import { load as loadManifestFile, MANIFEST } from './mcp_requirements.ts';
import { ValueError } from './lib/pyerrors.ts';
import { readText } from './lib/pyio.ts';

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** `yaml.safe_load` — PyYAML is YAML 1.1 and permissive on duplicate keys. */
function safeLoad(text: string): unknown {
  const doc = parseDocument(text, {
    version: '1.1',
    schema: 'yaml-1.1',
    uniqueKeys: false,
  });
  if (doc.errors.length > 0) throw doc.errors[0];
  // `parse` only logs an unresolved tag; PyYAML `safe_load` raises a
  // ConstructorError for it, so promote the warning to a parse error.
  const unresolved = doc.warnings.find(
    (warning) => warning.code === 'TAG_RESOLVE_FAILED',
  );
  if (unresolved !== undefined) {
    throw new YAMLParseError(
      unresolved.pos,
      unresolved.code,
      unresolved.message,
    );
  }
  return doc.toJS();
}

/** `.get()` on the frontmatter mapping — a non-mapping raises like Python. */
function yamlGet(metadata: unknown, key: string): unknown {
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new TypeError(
      `'${metadata === null ? 'NoneType' : typeof metadata}' object has no attribute 'get'`,
    );
  }
  return (metadata as Record<string, unknown>)[key];
}

/**
 * `Path(root).rglob('*.md')`: recursive descent that — like CPython
 * 3.12's pathlib glob — descends only into real directories while still
 * yielding `*.md` symlinks, which `read_text` then follows.
 */
function* markdownFiles(root: string, dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === '.git' || name === 'node_modules') continue;
      yield* markdownFiles(root, path);
    } else if (name.endsWith('.md')) {
      yield path;
    }
  }
}

function run(): number {
  const root = dirname(dirname(pyResolve(fileURLToPath(import.meta.url))));
  const names = new Set<string>();
  const third_party = third_party_skills(root);
  const skillsDir = join(root, '.agents/skills');
  let entries: string[] = [];
  try {
    entries = readdirSync(skillsDir).sort();
  } catch {
    // Python's glob yields nothing for a missing directory.
  }
  for (const name of entries) {
    const skill = join(skillsDir, name, 'SKILL.md');
    if (!isFile(skill)) continue;
    if (third_party.has(name)) continue;
    const content = readText(skill);
    if (!content.startsWith('---\n')) {
      throw new ValueError(`Missing frontmatter: ${skill}`);
    }
    const metadata = safeLoad(content.split('---', 3)[1]);
    const skillName = yamlGet(metadata, 'name');
    if (
      typeof skillName !== 'string' ||
      skillName !== name ||
      !/^[a-z0-9-]{1,63}$/.test(skillName)
    ) {
      throw new ValueError(`Invalid skill name: ${skill}`);
    }
    if (
      names.has(skillName) ||
      typeof yamlGet(metadata, 'description') !== 'string'
    ) {
      throw new ValueError(`Duplicate name or missing description: ${skill}`);
    }
    const distribution = yamlGet(metadata, 'distribution');
    if (
      distribution !== null &&
      distribution !== undefined &&
      distribution !== 'reference-only'
    ) {
      throw new ValueError(`Invalid distribution: ${skill}`);
    }
    names.add(skillName);
    const ui = join(skillsDir, name, 'agents/openai.yaml');
    if (existsSync(ui)) {
      safeLoad(readText(ui));
    }
  }

  for (const file of markdownFiles(root, root)) {
    const parts = relative(root, file).split('/');
    if (basename(file).startsWith('._') || basename(file) === '.DS_Store') {
      continue;
    }
    // Retired skills are verbatim historical content, not active documentation.
    if (
      parts.length > 3 &&
      parts[0] === 'tests' &&
      parts[1] === 'fixtures' &&
      parts[2] === 'retired-skills'
    ) {
      continue;
    }
    if (
      parts.length > 2 &&
      parts[0] === '.agents' &&
      parts[1] === 'skills' &&
      third_party.has(parts[2])
    ) {
      continue;
    }
    for (const match of readText(file).matchAll(/\]\(([^)]+)\)/g)) {
      let target = match[1];
      if (target.includes('://') || target.startsWith('#')) continue;
      target = target.split('#', 1)[0];
      if (!existsSync(join(dirname(file), target))) {
        throw new ValueError(
          `Broken supporting link: ${relative(root, file)} -> ${target}`,
        );
      }
    }
  }

  const agentsDir = join(root, '.codex/agents');
  let profiles: string[] = [];
  try {
    profiles = readdirSync(agentsDir);
  } catch {
    // Python's glob yields nothing for a missing directory.
  }
  for (const name of profiles) {
    if (!name.endsWith('.toml')) continue;
    const profile = join(agentsDir, name);
    if (!isFile(profile)) continue;
    const data = tomlLoads(readText(profile));
    for (const field of ['name', 'description', 'developer_instructions']) {
      if (!pyTruthy(data[field])) {
        throw new ValueError(`Missing ${field}: ${profile}`);
      }
    }
  }
  // The manifest is optional and consumer-owned; absence changes nothing.
  const manifest = join(root, MANIFEST);
  if (isFile(manifest)) {
    loadManifestFile(manifest, root);
    console.log(`Validated ${MANIFEST}`);
  }
  console.log(
    `Validated ${names.size} skills, supporting links, and Codex profiles`,
  );
  if (third_party.size) {
    // Named so a lock entry can never hide a library skill unnoticed.
    console.log(
      'Skipped third-party skills named in skills-lock.json: ' +
        [...third_party].sort().join(', '),
    );
  }
  return 0;
}

function isReportable(error: unknown): boolean {
  const named = error as Error;
  return (
    error instanceof ValueError ||
    error instanceof YAMLParseError ||
    named.name === 'UnicodeDecodeError' ||
    [
      'OSError',
      'FileNotFoundError',
      'NotADirectoryError',
      'IsADirectoryError',
      'FileExistsError',
      'PermissionError',
    ].includes(named.name)
  );
}

export function main(_argv: string[] = process.argv.slice(2)): number {
  try {
    return run();
  } catch (error) {
    if (isReportable(error)) {
      console.error((error as Error).message);
      return 1;
    }
    throw error;
  }
}

// `if __name__ == "__main__"`: Node resolves the invoked entry to its real
// path for import.meta.url while argv[1] keeps the typed spelling, so an
// invocation through a symlink must be resolved before comparing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(pyResolve(process.argv[1])).href
) {
  process.exitCode = main();
}
