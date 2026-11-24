/**
 * Install Basic Memory setup guidance and local project routing; no memory
 * I/O or hooks.
 *
 * Optional project-scope client connections (issue #100) live in
 * `memory_connections`: `[connection] clients = [...]` in the reviewed
 * routing input opts a consumer into generated, git-ignored project-scope
 * connection files. The endpoint and the credential's environment-variable
 * NAME live in one machine-local profile outside the checkout; the
 * generated files never carry a credential value.
 */
import {
  existsSync,
  lstatSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CAPABILITIES_FILE,
  MEMORY_SKILLS,
  SKILLS_MIGRATION,
  install,
  prepare_install,
  pyResolve,
  read_capabilities,
  repair_command,
} from './install.ts';
import {
  CONNECTION_CLIENTS,
  CONNECTION_IGNORE,
  CONNECTION_MARKER,
  CONNECTION_STATE_IGNORE,
  DEFAULT_RECONCILE,
  alignmentFailures,
  atomic,
  checkConnections,
  connectionClients,
  connectionGuidance,
  connectionIgnoreEvidence,
  connectionProfile,
  contained,
  defaultProfilePath,
  jsonDumps,
  jsonDumpsDefault,
  leftoverDiagnostics,
  planConnectionFiles,
  pruneCleanedOwnership,
  readState,
  renderConnections,
  shadowReport,
  tomlLoads,
} from './memory_connections.ts';
import type { Plan } from './memory_connections.ts';
import { runGit } from './lib/git.ts';
import { pyDecodeUtf8, readText } from './lib/pyio.ts';
import {
  osErrorName,
  UnicodeDecodeError,
  ValueError,
} from './lib/pyerrors.ts';
import { PyFloat } from './lib/pyloads.ts';
import { pyRepr } from './lib/pyrepr.ts';
import { TomlDate } from './vendor/smol-toml/index.js';

// --- Python value semantics ----------------------------------------------------
//
// The helpers below mirror the ones `memory_connections.ts` carries
// privately; parsed TOML arrives as plain objects while hand-built dicts
// stay plain objects too — both shapes are dicts here.

type Dict = Record<string, unknown> | Map<string, unknown>;

function isDict(value: unknown): value is Dict {
  if (value instanceof Map) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat) &&
    !(value instanceof TomlDate)
  );
}

/** `key in mapping` over either dict shape. */
function dictHas(mapping: Dict, key: string): boolean {
  return mapping instanceof Map
    ? mapping.has(key)
    : Object.hasOwn(mapping, key);
}

/** `mapping[key]` — callers check `dictHas` first. */
function dictGet(mapping: Dict, key: string): unknown {
  return mapping instanceof Map ? mapping.get(key) : mapping[key];
}

/** `mapping.get(key, default)` — the default only when absent. */
function dictGetOr(mapping: Dict, key: string, fallback: unknown): unknown {
  return dictHas(mapping, key) ? dictGet(mapping, key) : fallback;
}

/** `for key in mapping` — insertion order like Python dicts. */
function dictKeys(mapping: Dict): string[] {
  return mapping instanceof Map ? [...mapping.keys()] : Object.keys(mapping);
}

/** `for key, value in mapping.items()` — insertion order. */
function dictItems(mapping: Dict): [string, unknown][] {
  return mapping instanceof Map
    ? [...mapping.entries()]
    : Object.keys(mapping).map((key) => [key, mapping[key]]);
}

/**
 * `{**mapping, key: value}` — a copy of `mapping` with `key` set; an
 * existing key keeps its position like Python's dict spread.
 */
function dictSpread(mapping: Dict, key: string, value: unknown): Dict {
  const copy = new Map<string, unknown>();
  for (const [k, member] of dictItems(mapping)) {
    copy.set(k, k === key ? value : member);
  }
  if (!copy.has(key)) copy.set(key, value);
  return copy;
}

/**
 * Python truthiness over parsed values (`x or {}`-style expressions):
 * `None`, `False`, `0`, `0.0`, `''`, `[]` and `{}` are falsy — NaN and
 * non-empty containers are not, unlike their JavaScript counterparts.
 */
function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'bigint') return value !== 0n;
  if (value instanceof PyFloat) return value.value !== 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length !== 0;
  if (Array.isArray(value)) return value.length !== 0;
  if (value instanceof Map) return value.size !== 0;
  return Object.keys(value as Record<string, unknown>).length !== 0;
}

/**
 * The numeric tower Python's `==` and `hash()` share: `bool`, `int` and
 * `float` compare across types, so every integral value reduces to its
 * `bigint` while non-integral and non-finite floats stay doubles.
 */
function pyNumeric(value: unknown): bigint | number | undefined {
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'bigint') return value;
  if (value instanceof PyFloat) value = value.value;
  if (typeof value === 'number') {
    return Number.isInteger(value) ? BigInt(value) : value;
  }
  return undefined;
}

/**
 * `datetime`/`date`/`time` equality as `tomllib` materializes it: aware
 * datetimes compare by instant, local values by their authored fields,
 * and distinct kinds never compare equal.
 */
function tomlDateEq(a: TomlDate, b: TomlDate): boolean {
  if (a.isDateTime() !== b.isDateTime()) return false;
  if (a.isLocal() !== b.isLocal()) return false;
  if (a.isDateTime()) {
    return a.isLocal()
      ? a.toISOString() === b.toISOString()
      : a.getTime() === b.getTime();
  }
  if (a.isDate() !== b.isDate() || a.isTime() !== b.isTime()) return false;
  return a.toISOString() === b.toISOString();
}

/** Python `==` over the TOML-shaped values this module compares. */
function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof TomlDate || b instanceof TomlDate) {
    return a instanceof TomlDate && b instanceof TomlDate && tomlDateEq(a, b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((member, index) => pyEq(member, b[index]))
    );
  }
  if (isDict(a) || isDict(b)) {
    return isDict(a) && isDict(b) && pyDictEq(a, b);
  }
  if (a === null || a === undefined || b === null || b === undefined) {
    return (
      (a === null || a === undefined) &&
      (b === null || b === undefined)
    );
  }
  const numericA = pyNumeric(a);
  const numericB = pyNumeric(b);
  if (numericA === undefined || numericB === undefined) return false;
  return numericA === numericB;
}

/** Python dict `==`: the same key set with pairwise-equal values. */
function pyDictEq(a: Dict, b: Dict): boolean {
  const keys = dictKeys(a);
  if (keys.length !== dictKeys(b).length) return false;
  return keys.every(
    (key) => dictHas(b, key) && pyEq(dictGet(a, key), dictGet(b, key)),
  );
}

/** Python list `==` for the string sequences `replaceable_generated` compares. */
function pyListEq(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((member, index) => pyEq(member, b[index]));
}

/** `set(mapping) <= allowed` — key subset check over either dict shape. */
function keySubset(mapping: Dict, allowed: Set<string>): boolean {
  return dictKeys(mapping).every((key) => allowed.has(key));
}

/** `set(mapping) == expected` — exact key-set check. */
function keySetEquals(mapping: Dict, expected: Set<string>): boolean {
  const keys = dictKeys(mapping);
  return keys.length === expected.size && keys.every((k) => expected.has(k));
}

// --- Python-semantics path, string and error helpers ----------------------------

const PY_WS =
  '\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004' +
  '\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';

/** `str.strip()` over Python's whitespace set. */
function pyStrip(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WS.includes(text[start])) start += 1;
  while (end > start && PY_WS.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `str.splitlines()` — Python's full line-break set. */
function pySplitlines(text: string): string[] {
  const parts = text.split(/[\n\x0b\f\x1c-\x1e\x85\u2028\u2029\r]/);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** `text.count(fragment)` — non-overlapping occurrences. */
function countOccurrences(text: string, fragment: string): number {
  let count = 0;
  let index = 0;
  for (;;) {
    index = text.indexOf(fragment, index);
    if (index < 0) return count;
    count += 1;
    index += fragment.length;
  }
}

/** `text.replace(old, new, 1)`. */
function replaceFirst(
  text: string,
  oldText: string,
  newText: string,
): string {
  const index = text.indexOf(oldText);
  if (index < 0) return text;
  return text.slice(0, index) + newText + text.slice(index + oldText.length);
}

/** `PurePosixPath` spelling: collapse `//` and `.` segments, keep `..`. */
function purePath(value: string): string {
  const absolute = value.startsWith('/');
  const parts: string[] = [];
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue;
    parts.push(part);
  }
  const joined = parts.join('/');
  const result = (absolute ? '/' : '') + joined;
  return result === '' ? (absolute ? '/' : '.') : result;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** `Path.is_symlink()` — lstat, false on a missing path. */
function isSymlink(path: string): boolean {
  return lstatOrNull(path)?.isSymbolicLink() ?? false;
}

/** `Path.is_file()` — follows links, false on error. */
function isFile(path: string): boolean {
  return statOrNull(path)?.isFile() ?? false;
}

const OS_ERRNO: Record<string, [number, string]> = {
  EPERM: [1, 'Operation not permitted'],
  ENOENT: [2, 'No such file or directory'],
  EACCES: [13, 'Permission denied'],
  EBUSY: [16, 'Device or resource busy'],
  EEXIST: [17, 'File exists'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  EROFS: [30, 'Read-only file system'],
  ENAMETOOLONG: [36, 'File name too long'],
  ENOTEMPTY: [39, 'Directory not empty'],
  ELOOP: [40, 'Too many levels of symbolic links'],
};

/**
 * `str(OSError)` for a Node errno error: `[Errno N] {strerror}: '{path}'`,
 * named after the OSError subclass CPython raises for the same code.
 */
function pyOsError(error: unknown): Error {
  const errno = error as NodeJS.ErrnoException;
  const pair = errno?.code !== undefined ? OS_ERRNO[errno.code] : undefined;
  if (pair === undefined) return error as Error;
  const [number, strerror] = pair;
  const suffix = errno?.path !== undefined ? `: '${errno.path}'` : '';
  const renamed = new Error(`[Errno ${number}] ${strerror}${suffix}`);
  renamed.name = osErrorName(error);
  return renamed;
}

/**
 * `Path(path).read_text()` for the `--portable` input — universal newlines
 * like `readText`, but `str(error)` keeps CPython's `[Errno N]` wording the
 * CLI prints.
 */
function readPortable(path: string): string {
  let text: string;
  try {
    text = pyDecodeUtf8(readFileSync(path));
  } catch (error) {
    if (error instanceof UnicodeDecodeError) throw error;
    throw pyOsError(error);
  }
  return text.replace(/\r\n?/g, '\n');
}

/** Whether `error` lands in Python's `except (ValueError, OSError)`. */
function isValueOrOSError(error: unknown): boolean {
  const named = error as Error | undefined;
  return (
    error instanceof ValueError ||
    named?.name === 'UnicodeDecodeError' ||
    named?.name === 'OSError' ||
    named?.name === 'FileNotFoundError' ||
    named?.name === 'NotADirectoryError' ||
    named?.name === 'IsADirectoryError' ||
    named?.name === 'FileExistsError' ||
    named?.name === 'PermissionError'
  );
}

/** `str(error)` for embedding in diagnostic messages. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Module constants -----------------------------------------------------------

export const START = '<!-- agent-workflows:memory:start -->';
export const END = '<!-- agent-workflows:memory:end -->';
export const BLOCK =
  START +
  '\n## Development memory\n\nRead `.agents/memory/config.md` before using' +
  ' Basic Memory in this checkout.\n' +
  END;
export const DEFAULT_SKILLS = [...MEMORY_SKILLS];
// The capture paragraph generated while the library vendored upstream skills.
// Recognized only so setup can replace exactly that generated text.
export const VENDORED_SKILLS_GUIDANCE = `Use \`memory-notes\` for note structure, \`memory-capture\` for a coherent thread
handoff and \`memory-continue\` to retrieve prior work. Capture useful progress and
decisions during the task or at handoff; do not wait for a hook. Read the existing
thread note before updating it. Use the exact returned path, not an invented one.
`;
export const SKILLS_GUIDANCE = `Tool names and arguments belong to the connected server's release. Basic
Memory's own skills are installed in this project from that same release; use
them for note structure, capture and resume when present, and report them as
missing otherwise. Capture useful progress and decisions during the task or at
handoff; do not wait for a hook. Read the existing thread note before updating
it, and replace it using the exact returned path, with the checksum from that
read when the server returns one. Do not invent a path.
`;
export const ROUTING_GUIDANCE = `Use the configured scopes without asking the user to choose a project again.
Do not rely on or change the service's default project. Ask only if routing is
missing, contradictory or outside the configured scopes. Routing identifies the
destination; it does not authorize writes or expand the current task's scope.
`;

const SLUG_NAME = '[a-z0-9][a-z0-9-]{0,62}';
const SLUG_RE = new RegExp(`^${SLUG_NAME}$`);
const SCOPE_RE = new RegExp(`^(?:${SLUG_NAME}/)?${SLUG_NAME}$`);

export function config_data(data: unknown): unknown {
  if (
    !isDict(data) ||
    !['schema_version', 'project', 'memory'].every((key) =>
      dictHas(data, key),
    ) ||
    !keySubset(
      data,
      new Set(['schema_version', 'project', 'memory', 'connection']),
    )
  ) {
    throw new ValueError(
      'Expected schema_version, project and memory tables' +
        ' (plus an optional connection table)',
    );
  }
  const version = dictGet(data, 'schema_version');
  if (typeof version !== 'bigint' || version !== 2n) {
    throw new ValueError(
      'Use native-memory schema_version=2; see the migration guide',
    );
  }
  const project = dictGet(data, 'project');
  const memory = dictGet(data, 'memory');
  if (!isDict(project) || !keySetEquals(project, new Set(['id']))) {
    throw new ValueError('Expected project.id');
  }
  if (
    !isDict(memory) ||
    !keySetEquals(
      memory,
      new Set([
        'write_project',
        'search_projects',
        'related_projects',
        'mcp_server',
      ]),
    )
  ) {
    throw new ValueError(
      'Expected memory scopes and mcp_server; no backend or file_root',
    );
  }
  const slug = (value: unknown): void => {
    if (typeof value !== 'string' || !SLUG_RE.test(value)) {
      throw new ValueError('Expected a lowercase project slug');
    }
  };
  const scope = (value: unknown): void => {
    // Basic Memory 1.0 also accepts a workspace-qualified project name.
    if (typeof value !== 'string' || !SCOPE_RE.test(value)) {
      throw new ValueError(
        'Expected a lowercase project slug or workspace/project name',
      );
    }
  };
  slug(dictGet(project, 'id'));
  scope(dictGet(memory, 'write_project'));
  for (const key of ['search_projects', 'related_projects']) {
    const values = dictGet(memory, key);
    if (!Array.isArray(values)) {
      throw new ValueError('Project scopes must be arrays');
    }
    for (const value of values) scope(value);
    if (new Set(values).size !== values.length) {
      throw new ValueError('Duplicate project scope');
    }
  }
  const searchProjects = dictGet(memory, 'search_projects') as unknown[];
  if (
    searchProjects.length === 0 ||
    !pyEq(searchProjects[0], dictGet(memory, 'write_project'))
  ) {
    throw new ValueError('Write project must be first in search_projects');
  }
  const related = new Set(dictGet(memory, 'related_projects') as unknown[]);
  if ((dictGet(memory, 'search_projects') as unknown[]).some((v) => related.has(v))) {
    throw new ValueError('Default and related scopes must be disjoint');
  }
  const mcpServer = dictGet(memory, 'mcp_server');
  if (typeof mcpServer !== 'string' || !pyStrip(mcpServer)) {
    throw new ValueError('Expected an existing client MCP server name');
  }
  const connection = dictGetOr(data, 'connection', undefined);
  if (connection !== undefined && connection !== null) {
    if (!isDict(connection) || !keySetEquals(connection, new Set(['clients']))) {
      throw new ValueError('Expected [connection] with only a clients array');
    }
    const clients = dictGet(connection, 'clients');
    if (!Array.isArray(clients)) {
      throw new ValueError('connection.clients must be an array');
    }
    for (const client of clients) {
      if (!(CONNECTION_CLIENTS as readonly unknown[]).includes(client)) {
        throw new ValueError(
          `Unknown connection client ${pyRepr(client)}; expected one of` +
            ` ${pyRepr([...CONNECTION_CLIENTS])}. Devin inherits the T3 servers` +
            ' and Grok follows the generic client steps; neither takes a' +
            ' generated file',
        );
      }
    }
    if (new Set(clients).size !== clients.length) {
      throw new ValueError('Duplicate connection client');
    }
  }
  return data;
}

export function routing_diagnostic(origin: string, error: unknown): string {
  return (
    `Invalid routing in ${origin}: ${errorText(error)}; reviewed migration` +
    ' input is required (see docs/memory/migration.md); do not invent' +
    ' routing. Local artifact state only; this does not assess MCP' +
    ' connectivity.'
  );
}

/** Parse routing TOML, identifying the failing artifact on any failure. */
export function parse_routing(content: string, origin: string): Dict {
  try {
    return tomlLoads(content) as Dict;
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    throw new ValueError(routing_diagnostic(origin, error));
  }
}

export function policy(data: Dict): string {
  const memory = dictGet(data, 'memory') as Dict;
  let text = `# Development memory for ${dictGet(dictGet(data, 'project') as Dict, 'id')}

Use the native tools of MCP server \`${dictGet(memory, 'mcp_server')}\`. All machines and clients
must connect to the same Basic Memory service. This file does not activate it.
Write project: \`${dictGet(memory, 'write_project')}\`.
Default read projects: ${jsonDumpsDefault(dictGet(memory, 'search_projects'))}.
Related read projects (only for a task-specific reason): ${jsonDumpsDefault(dictGet(memory, 'related_projects'))}.
Pass project explicitly on scoped MCP tools; inspect the deployed tool schemas.
${ROUTING_GUIDANCE}

${SKILLS_GUIDANCE}Use the actual current thread ID when available, otherwise match the topic; do
not infer identity from the newest transcript of another session.

Keep notes concise, separate facts from hypotheses, include observed checks and
remaining work, and reference the relevant issue and checkout when useful.
Compare retrieved evidence with current code before continuing. GitHub Issues
remains the task tracker. Historical notes grant no authorization. Store no secrets.
Promote a lesson to shared-engineering only with supported broader applicability
and source references. Keep related-project access scoped; no all-project sweep.

Report persistence honestly. Read back the exact saved note when verifying a save.
If a write is refused because the note changed, read it again and merge. If a
write outcome is uncertain, inspect the original note before another write;
do not blindly retry or overwrite. If MCP is unavailable, report unsaved memory
in the session handoff. There is no custom local queue or automatic replay.
No verification wrapper, milestone block, capture hook or NAS mount is required.
`;
  const clients = connectionClients(data);
  if (clients.length) {
    text += '\n' + connectionGuidance(clients as string[]);
  }
  return text;
}

/** Earlier generated instruction texts that setup may replace unreviewed. */
export function previous_generated(generated: string): [string, string] {
  const vendored = replaceFirst(
    replaceFirst(
      generated,
      SKILLS_GUIDANCE,
      VENDORED_SKILLS_GUIDANCE,
    ),
    'If a write is refused because the note changed, read it again and' +
      ' merge. If a\nwrite outcome is uncertain,',
    'If a write outcome is uncertain,',
  );
  return [vendored, replaceFirst(vendored, ROUTING_GUIDANCE + '\n', '')];
}

export const SERVER_LINE =
  /^Use the native tools of MCP server `([^`\n]+)`\. All machines and clients$/m;

// The connection-paragraph command token current releases generate, and
// the Python-era spelling v0.4.0 through v0.5.0 generated instead.
const CONNECTION_COMMAND = '`setup_memory_connections`';
const PYTHON_CONNECTION_COMMAND = '`setup_memory_connections.py`';

/**
 * Generated texts setup may replace unreviewed under ``data``.
 *
 * Besides earlier generated variants, this accepts text generated for another
 * MCP server name, so renaming ``mcp_server`` regenerates untouched
 * instructions while hand-edited ones stay preserved for review.
 */
export function replaceable_generated(data: Dict, current: string): string[] {
  const texts: string[] = [policy(data)];
  if (connectionClients(data).length) {
    // Opting into connections later marks untouched instructions stale,
    // not customized: the pre-opt-in text stays replaceable.
    const without = new Map<string, unknown>();
    for (const [key, value] of dictItems(data)) {
      if (key !== 'connection') without.set(key, value);
    }
    texts.push(policy(without));
  }
  const marker = current ? CONNECTION_MARKER.exec(current) : null;
  if (
    marker &&
    !pyListEq(
      marker[1].split(' '),
      connectionClients(data),
    )
  ) {
    // Changing the client selection likewise regenerates untouched text.
    texts.push(
      policy(
        dictSpread(data, 'connection', {
          clients: marker[1].split(' '),
        }),
      ),
    );
  }
  const match = current ? SERVER_LINE.exec(current) : null;
  const memory = dictGet(data, 'memory') as Dict;
  if (match && match[1] !== dictGet(memory, 'mcp_server')) {
    texts.push(
      policy(
        dictSpread(
          data,
          'memory',
          dictSpread(memory, 'mcp_server', match[1]),
        ),
      ),
    );
  }
  return texts.flatMap((text) => {
    const forms = [text];
    if (text.includes(CONNECTION_COMMAND)) {
      // v0.4.0 through v0.5.0 emitted the same paragraph naming the
      // Python helper; restoring `.py` on that one token yields the
      // exact generated text those releases produced.
      forms.push(
        replaceFirst(
          text,
          CONNECTION_COMMAND,
          PYTHON_CONNECTION_COMMAND,
        ),
      );
    }
    return forms.flatMap((form) => [form, ...previous_generated(form)]);
  });
}

/**
 * Return (generated_text, state) for `.agents/memory/config.md`.
 *
 * ``state`` is 'current', 'missing', 'stale' or 'customized' under the same
 * classification setup applies. Throws ValueError when the reviewed routing
 * input is absent or invalid; recreating it is --portable territory and is
 * never repaired implicitly by callers.
 */
export function expected_instructions(root: string): [string, string] {
  const target = join(root, '.agents/memory/config.toml');
  const instructions = join(root, '.agents/memory/config.md');
  if (!isFile(target)) {
    throw new ValueError(
      'Missing reviewed routing input: .agents/memory/config.toml; the' +
        ' enabled Basic Memory capability expects reviewed v2 routing.' +
        ' Configure it with node .agent-workflows/bin/agent-workflows.ts' +
        ' setup_memory --portable' +
        ' <reviewed-config.toml> (see docs/memory/configuration.md); do' +
        ' not invent routing.',
    );
  }
  const origin = '.agents/memory/config.toml';
  const parsed = parse_routing(readText(target), origin);
  let data: Dict;
  try {
    data = config_data(parsed) as Dict;
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    throw new ValueError(routing_diagnostic(origin, error));
  }
  const generated = policy(data);
  const current = existsSync(instructions) ? readText(instructions) : null;
  let state: string;
  if (current === generated) {
    state = 'current';
  } else if (current === null) {
    state = 'missing';
  } else if (replaceable_generated(data, current).includes(current)) {
    state = 'stale';
  } else {
    state = 'customized';
  }
  return [generated, state];
}

/**
 * Recorded opt-in: (clients, server, origin) or null when not selected.
 *
 * The reviewed source is `.agents/memory/config.toml`; in a worktree that
 * file is git-ignored and absent, so the restored generated
 * `.agents/memory/config.md` marker carries the same reviewed selection.
 * Callers combine a missing marker with ignore-entry evidence and the
 * ownership record to distinguish stale routing from deselected leftovers.
 */
export function connection_selection(
  root: string,
  _reconcile?: string | null,
): [string[], string, string] | null {
  const instructions = join(root, '.agents/memory/config.md');
  let content: string | null = null;
  let origin: string | undefined;
  if (existsSync(join(root, '.agents/memory/config.toml'))) {
    const [, state] = expected_instructions(root);
    if (state !== 'current') {
      throw new ValueError(
        `Generated instructions are ${state}; refresh them from the` +
          ' consumer root with `node .agent-workflows/bin/agent-workflows.ts' +
          ' setup_memory --project .` before' +
          ' rendering connections',
      );
    }
    origin = 'reviewed routing (config.toml + current generated config.md)';
    content = isFile(instructions) ? readText(instructions) : '';
  } else if (isFile(instructions)) {
    origin = 'restored routing (.agents/memory/config.md in this checkout)';
    content = readText(instructions);
  }
  const marker = content !== null ? CONNECTION_MARKER.exec(content) : null;
  if (!marker) return null;
  const clients = marker[1].split(' ');
  const unknown = clients.filter(
    (client) => !(CONNECTION_CLIENTS as readonly string[]).includes(client),
  );
  if (unknown.length) {
    throw new ValueError(
      'Generated routing selects unknown connection client(s)' +
        ` ${pyRepr(unknown)}; the routing predates this library or was` +
        ' edited — preserve and review',
    );
  }
  const server = SERVER_LINE.exec(content as string);
  if (!server) {
    throw new ValueError(
      'Generated routing carries a connection marker but no MCP server' +
        ' line; preserve and review',
    );
  }
  return [clients, server[1], origin as string];
}

export interface RunConnectionsOptions {
  check?: boolean;
  profile?: string | null;
  home?: string | null;
  repair?: string | null;
  reconcile?: string | null;
}

/** Shared entry for setup_memory.ts and the standalone worktree command. */
export function run_connections(
  root: string,
  options: RunConnectionsOptions = {},
): Record<string, unknown> {
  const { check = false, profile = null, home = null, repair = null, reconcile = null } = options;
  let [state, stateWarning] = readState(root);
  const selection = connection_selection(root, reconcile);
  if (selection === null) {
    // Ownership records report deselected leftovers precisely; the
    // committed ignore entries are the fallback opt-in evidence when the
    // (ignored) ownership record is absent — e.g. a fresh worktree whose
    // restored routing predates the opt-in.
    const [failures, leftoverWarnings] = leftoverDiagnostics(
      root,
      [],
      null,
      state,
    );
    if (failures.length) {
      throw new ValueError(
        'Generated connection entries recorded for server' +
          ` \`${dictGet(state, 'server')}\` remain, but this checkout records no` +
          ' connection selection:\n' +
          failures.join('\n') +
          '\nRemove or reconcile them manually — the helper never' +
          ' deletes client configuration',
      );
    }
    state = pruneCleanedOwnership(root, [], state, !check);
    const evidence =
      dictGetOr(state, 'server', null) === null
        ? connectionIgnoreEvidence(root)
        : [];
    if (evidence.length) {
      throw new ValueError(
        'This checkout carries the generated connection ignore' +
          ' entries ' +
          evidence.map((line) => `\`${line}\``).join(', ') +
          ' but no connection selection is recorded in its routing —' +
          ' the restored routing predates the opt-in, or the entries' +
          ' are stale. If the opt-in is current, reconcile and commit' +
          ' the tracked routing source from the main checkout' +
          ` (\`${reconcile ?? DEFAULT_RECONCILE}\`) and commit .gitignore` +
          ' before creating worktrees. If connections were deselected' +
          ' or never selected, remove the entries through a reviewed' +
          ' edit',
      );
    }
    const result: Record<string, unknown> = {
      connections: 'not configured',
      warnings: [...leftoverWarnings],
    };
    if (stateWarning) (result['warnings'] as string[]).push(stateWarning);
    return result;
  }
  const [clients, server, origin] = selection;
  const profileData = connectionProfile(
    root,
    clients,
    profile ? purePath(profile) : defaultProfilePath(home ?? undefined),
  );
  const plans = planConnectionFiles(root, clients, server, profileData, state);
  const result: Record<string, unknown> = {
    clients,
    mcp_server: server,
    origin,
  };
  if (check) {
    result['warnings'] = checkConnections(
      root,
      clients,
      server,
      profileData,
      plans,
      home ?? undefined,
      repair ?? undefined,
      undefined,
      reconcile ?? undefined,
      state,
    );
  } else {
    const [written, warnings] = renderConnections(
      root,
      clients,
      server,
      profileData,
      plans,
      home ?? undefined,
      undefined,
      reconcile ?? undefined,
      state,
    );
    if (stateWarning) warnings.push(stateWarning);
    result['rendered'] = written;
    result['warnings'] = warnings;
  }
  return result;
}

/** Noninteractive helper: proceed only on an explicitly recorded choice. */
export function require_memory_choice(root: string): string {
  const recorded = read_capabilities(root);
  if (recorded === null) {
    throw new ValueError(
      `No Basic Memory choice recorded; record it first with` +
        ' node .agent-workflows/bin/agent-workflows.ts install --project .' +
        ` --memory enabled (writes ${CAPABILITIES_FILE}).` +
        ' The helper never enables memory silently.',
    );
  }
  if (recorded !== 'enabled') {
    throw new ValueError(
      `Basic Memory is declined in ${CAPABILITIES_FILE}; to enable it` +
        ' later, record the reviewed choice with' +
        ' node .agent-workflows/bin/agent-workflows.ts install' +
        ' --memory enabled.',
    );
  }
  return recorded;
}

export function memory_agents_policy(existing: string, path: string): string {
  /** The AGENTS.md memory policy preflight — old lifecycle instructions
   * and the managed block's classification. Returns the text setup would
   * write; raises the same ValueErrors without writing. */
  if (
    existing.includes('workflow-memory-milestone') ||
    existing.includes('reviewed Codex/T3 Stop capture hook')
  ) {
    throw new ValueError(
      `Retire old lifecycle instructions in ${path}` +
        ' before setup; see docs/memory/migration.md',
    );
  }
  if (!existing.includes(START) && !existing.includes(END)) {
    return existing + (existing.endsWith('\n') ? '\n' : '\n\n') + BLOCK + '\n';
  }
  if (
    countOccurrences(existing, START) !== 1 ||
    countOccurrences(existing, END) !== 1 ||
    existing.indexOf(START) > existing.indexOf(END)
  ) {
    throw new ValueError(
      `Malformed memory policy block in ${path}` +
        ` (markers \`${START}\`/\`${END}\`); preserve and review`,
    );
  }
  const current = existing.slice(
    existing.indexOf(START),
    existing.indexOf(END) + END.length,
  );
  if (current !== BLOCK) {
    throw new ValueError(
      `Existing memory policy block in ${path}` +
        ` (markers \`${START}\`/\`${END}\`) needs reviewed migration;` +
        ' see docs/memory/migration.md',
    );
  }
  return existing;
}

export function memory_skill_destinations(
  source: string,
  root: string,
  library_has: (name: string) => boolean,
  names: string[] = [...DEFAULT_SKILLS],
): void {
  /** Preflight `.agents/skills/<name>` destinations for the memory set
   * without writing — the refusals setup raises for a missing library
   * skill, a conflicting link or a local override. `library_has`
   * reports whether the pinned library carries the skill's SKILL.md, so
   * a caller inspecting a tree other than the worktree shares the same
   * check. */
  for (const name of names) {
    if (
      basename(name) !== name ||
      name === '.' ||
      name === '..' ||
      !library_has(name)
    ) {
      throw new ValueError(
        `Expected memory skill missing from the pinned library: ${name}`,
      );
    }
    const destination = join(root, '.agents/skills', name);
    contained(root, dirname(destination));
    const expected = join(source, '.agents/skills', name);
    if (isSymlink(destination)) {
      if (pyResolve(destination) !== expected) {
        throw new ValueError(
          `Conflicting memory skill link: ${destination} resolves to` +
            ` ${pyResolve(destination)}, expected ${expected}; retarget it` +
            ' only after a reviewed decision',
        );
      }
    } else if (existsSync(destination)) {
      throw new ValueError(
        `Local skill override: ${destination}; the pinned memory` +
          ' capability expects a managed link here and cannot exclude a' +
          ' name; remove it only after a reviewed decision',
      );
    }
  }
}

export interface SetupOptions {
  portable?: string | null;
  check?: boolean;
  share_config?: boolean;
  claude_skills?: boolean;
  profile?: string | null;
  home?: string | null;
}

export interface SetupPreflightOptions extends SetupOptions {
  /** Memory-skill source probe for the destinations check; the default
   * inspects the pinned library worktree. A caller planning an install
   * from a different revision — the update planner's adopted target —
   * injects a probe over that revision's tree. */
  library_has?: (name: string) => boolean;
}

/**
 * Everything setup() computes before its first write, returned so the
 * refusal phase and the write phase share one inspection.
 */
export interface SetupPreflight {
  source: string;
  root: string;
  target: string;
  instructions: string;
  content: string;
  data: Dict;
  generated: string;
  currentInstructions: string | null;
  agents: string;
  existing: string;
  updated: string;
  ignorePath: string;
  ignore: string;
  updatedIgnore: string;
  names: string[];
  memoryOptions: string[];
  memoryRepair: string;
  connRepair: string;
  reconcileRepair: string;
  connState: Dict;
  connection: [string[], string, Dict | null, Plan[], Dict] | null;
  /** The 'Missing machine connection profile' refusal captured for the
   * caller instead of thrown: setup() rethrows it unchanged while a
   * read-only caller — the update planner — surfaces an absent profile
   * as an owner question. An unreadable or invalid profile stays an
   * ordinary refusal raised from the preflight itself. */
  missingProfileError: ValueError | null;
}

/**
 * Every refusal setup() performs before its first write as one pure,
 * read-only pass: the worktree root and contract, the recorded memory
 * choice, routing parse/validation, customized generated instructions,
 * legacy capture hooks, the AGENTS.md memory policy, the
 * generated-connection preflight (leftovers, machine profile, plans,
 * shadowing and alignment) and the memory-skill destinations. The rules
 * live here alone so read-only callers (the update planner) report the
 * same refusals without re-deriving them; setup() consumes the result
 * for its write phase. Filesystem reads and read-only git queries
 * (rev-parse/ls-files/check-ignore) only — never `git status`, never a
 * write.
 */
export function setup_preflight(
  source: string,
  project: string,
  options: SetupPreflightOptions = {},
): SetupPreflight {
  const {
    portable = null,
    check = false,
    share_config = false,
    claude_skills = false,
    profile = null,
    home = null,
    library_has = (name: string) =>
      isFile(join(source, '.agents/skills', name, 'SKILL.md')),
  } = options;
  source = pyResolve(source);
  const root = pyResolve(project);
  const toplevel = runGit(root, ['rev-parse', '--show-toplevel']);
  if (toplevel.status === 0 && pyResolve(pyStrip(toplevel.stdout)) !== root) {
    throw new ValueError('Project must be the active worktree root');
  }
  if (
    !isFile(join(root, 'AGENTS.md')) ||
    pyResolve(join(root, '.agent-workflows')) !== source
  ) {
    throw new ValueError(
      'Use the consumer root with AGENTS.md and its own .agent-workflows',
    );
  }
  require_memory_choice(root);
  const retired = join(root, '.agents/skills/workflow-memory');
  if (
    isSymlink(retired) &&
    pyResolve(retired) === join(source, '.agents/skills/workflow-memory')
  ) {
    throw new ValueError(
      'Remove the retired shared workflow-memory link; see' +
        ' docs/memory/migration.md',
    );
  }
  const target = contained(root, join(root, '.agents/memory/config.toml'));
  const instructions = contained(root, join(root, '.agents/memory/config.md'));
  let content: string;
  let origin: string;
  if (existsSync(target)) {
    content = readText(target);
    origin = relative(root, target);
    if (
      portable !== null &&
      !pyDictEq(
        parse_routing(content, origin),
        parse_routing(portable, 'the supplied --portable input'),
      )
    ) {
      throw new ValueError(
        `Existing routing in ${relative(root, target)} differs from the` +
          ' supplied --portable input; preserve and review an explicit edit',
      );
    }
  } else if (portable !== null) {
    content = portable;
    origin = 'the supplied --portable input';
  } else {
    throw new ValueError(
      `Missing ${relative(root, target)}; the enabled Basic Memory` +
        ' capability expects reviewed v2 routing. Setup requires reviewed' +
        ' routing input: rerun with --portable <reviewed-config.toml>; do' +
        ' not invent routing (see docs/memory/configuration.md and' +
        ' migration.md). Local artifact state only; this does not assess' +
        ' MCP connectivity.',
    );
  }
  const parsed = parse_routing(content, origin);
  let data: Dict;
  try {
    data = config_data(parsed) as Dict;
  } catch (error) {
    if (!(error instanceof ValueError)) throw error;
    throw new ValueError(routing_diagnostic(origin, error));
  }
  const generated = policy(data);
  const currentInstructions = existsSync(instructions)
    ? readText(instructions)
    : null;
  if (
    currentInstructions !== null &&
    !replaceable_generated(data, currentInstructions).includes(
      currentInstructions,
    )
  ) {
    throw new ValueError(
      `Customized memory instructions in ${relative(root, instructions)};` +
        ' preserve and review an explicit edit',
    );
  }
  // Old hooks cannot be carried forward into the native flow silently.
  for (const name of [
    '.codex/hooks.json',
    '.codex/config.toml',
    '.claude/settings.json',
    '.claude/settings.local.json',
  ]) {
    const path = contained(root, join(root, name));
    if (existsSync(path) && readText(path).includes('memory_lifecycle.py')) {
      throw new ValueError(
        `Retire the old custom capture hook in ${name} before setup;` +
          ' see docs/memory/migration.md',
      );
    }
  }
  const agents = join(root, 'AGENTS.md');
  const existing = readText(agents);
  const updated = memory_agents_policy(existing, relative(root, agents));
  const ignorePath = contained(root, join(root, '.gitignore'));
  const ignore = existsSync(ignorePath) ? readText(ignorePath) : '';
  let updatedIgnore = ignore;
  if (
    !share_config &&
    !pySplitlines(ignore).includes('/.agents/memory/')
  ) {
    updatedIgnore +=
      (!ignore || ignore.endsWith('\n') ? '' : '\n') + '/.agents/memory/\n';
  }
  const names = [...DEFAULT_SKILLS];
  const memoryOptions = claude_skills ? ['--claude-skills'] : [];
  if (share_config) memoryOptions.push('--share-config');
  const memoryRepair = repair_command(source, root, 'setup_memory.py', memoryOptions);
  const connRepair = repair_command(source, root, 'setup_memory_connections.py');
  const reconcileRepair = repair_command(
    source,
    root,
    't3_readiness.py',
    ['--reconcile-routing-source'],
  );
  // Project-scope client connections are opt-in through [connection] in the
  // reviewed routing. Preflight the whole operation — ownership records,
  // leftovers, profile, plans and shadowing — before any write so a refusal
  // never leaves a half-configured checkout behind.
  const clients = connectionClients(data) as string[];
  const serverName = dictGet(dictGet(data, 'memory') as Dict, 'mcp_server') as string;
  let connection:
    | [string[], string, Dict | null, Plan[], Dict]
    | null = null;
  const [connState] = readState(root);
  if (
    dictHas(data, 'connection') ||
    pyTruthy(dictGet(connState, 'entries'))
  ) {
    const [leftoverFailures] = leftoverDiagnostics(
      root,
      clients,
      serverName,
      connState,
    );
    if (leftoverFailures.length) {
      throw new ValueError(
        'Deselected connection client(s) still carry generated' +
          ` \`${serverName}\` entries:\n` +
          leftoverFailures.join('\n') +
          '\nRemove or reconcile them manually — the helper never' +
          ' deletes client configuration',
      );
    }
  }
  let missingProfileError: ValueError | null = null;
  if (clients.length) {
    const profilePath =
      profile !== null
        ? purePath(profile)
        : defaultProfilePath(home ?? undefined);
    let profileData: Dict | null = null;
    try {
      profileData = connectionProfile(root, clients, profilePath);
    } catch (error) {
      // An absent profile file can produce only the 'Missing machine
      // connection profile' refusal; capture it for the caller (the
      // update planner turns it into an owner question) while every
      // other profile failure stays a refusal here.
      if (error instanceof ValueError && !isFile(profilePath)) {
        missingProfileError = error;
      } else {
        throw error;
      }
    }
    if (missingProfileError === null) {
      const plans = planConnectionFiles(
        root,
        clients,
        serverName,
        profileData,
        connState,
      );
      const [shadowFailures] = shadowReport(
        root,
        clients,
        serverName,
        profileData,
        plans,
        home ?? undefined,
      );
      if (shadowFailures.length) {
        throw new ValueError(
          'Shadowing detected — no files written:\n' +
            shadowFailures.join('\n'),
        );
      }
      const unaligned = alignmentFailures(plans);
      if (unaligned.length) {
        throw new ValueError(
          'Consumer-owned memory connection entries are not' +
            ' verifiably aligned — no files written:\n' +
            unaligned.join('\n'),
        );
      }
      connection = [clients, serverName, profileData, plans, connState];
      // Consumer-owned (tracked) files get no ignore entries: generation
      // never writes them, and ignore lines do not untrack files.
      const generatedClients = plans
        .filter((plan) => plan.state !== 'consumer-owned')
        .map((plan) => plan.client);
      for (const client of generatedClients) {
        const line = CONNECTION_IGNORE[client];
        if (!pySplitlines(updatedIgnore).includes(line)) {
          updatedIgnore +=
            (updatedIgnore.endsWith('\n') ? '' : '\n') + line + '\n';
        }
      }
      // The ownership record lives in the generated directory; it needs its
      // own ignore line only when that directory is shared (tracked).
      if (
        generatedClients.length &&
        !pySplitlines(updatedIgnore).includes('/.agents/memory/') &&
        !pySplitlines(updatedIgnore).includes(CONNECTION_STATE_IGNORE)
      ) {
        updatedIgnore +=
          (updatedIgnore.endsWith('\n') ? '' : '\n') +
          CONNECTION_STATE_IGNORE +
          '\n';
      }
    }
  }
  if (missingProfileError === null) {
    // Preflight destinations before editing instructions or config.
    memory_skill_destinations(source, root, library_has, names);
    if (check) {
      // Identify the exact missing or stale artifact before link checks so a
      // suggested repair never assumes unconfigured routing.
      if (!existsSync(target)) {
        throw new ValueError(
          `Missing memory routing: ${relative(root, target)}; the` +
            ' enabled Basic Memory capability expects reviewed v2 routing.' +
            ' Repair requires reviewed routing input:' +
            ` \`${memoryRepair} --portable <reviewed-config.toml>\`; do not` +
            ' invent routing (see docs/memory/configuration.md). Local' +
            ' artifact state only; this check does not assess MCP' +
            ' connectivity.',
        );
      }
      if (currentInstructions !== generated) {
        const state = currentInstructions === null ? 'Missing' : 'Stale';
        throw new ValueError(
          `${state} generated instructions:` +
            ` ${relative(root, instructions)}; expected content generated` +
            ' from the reviewed routing. Repair from the consumer root:' +
            ` \`${memoryRepair}\`. Local artifact state only; this check` +
            ' does not assess MCP connectivity.',
        );
      }
      if (updated !== existing) {
        throw new ValueError(
          `Missing memory policy block in ${relative(root, agents)}` +
            ` (markers \`${START}\`/\`${END}\`). Repair from the consumer root:` +
            ` \`${memoryRepair}\``,
        );
      }
      if (updatedIgnore !== ignore) {
        const added = pySplitlines(updatedIgnore).filter(
          (line) => !pySplitlines(ignore).includes(line),
        );
        throw new ValueError(
          `Missing ignore entr${added.length === 1 ? 'y' : 'ies'}` +
            ` ${added.map((line) => `\`${line}\``).join(', ')} in` +
            ` ${relative(root, ignorePath)}; local routing and` +
            ' generated connection files are ignored by default. Repair' +
            ` from the consumer root: \`${memoryRepair}\`, or pass` +
            ' --share-config if the consumer shares the memory directory' +
            ' (generated connection files stay ignored regardless).',
        );
      }
      if (connection !== null) {
        checkConnections(
          root,
          connection[0],
          connection[1],
          connection[2],
          connection[3],
          home ?? undefined,
          connRepair,
          memoryRepair,
          reconcileRepair,
          connection[4],
        );
      }
    }
  }
  return {
    source,
    root,
    target,
    instructions,
    content,
    data,
    generated,
    currentInstructions,
    agents,
    existing,
    updated,
    ignorePath,
    ignore,
    updatedIgnore,
    names,
    memoryOptions,
    memoryRepair,
    connRepair,
    reconcileRepair,
    connState,
    connection,
    missingProfileError,
  };
}

export function setup(
  source: string,
  project: string,
  options: SetupOptions = {},
): Record<string, unknown> {
  const { check = false, claude_skills = false, home = null } = options;
  const pre = setup_preflight(source, project, options);
  if (pre.missingProfileError !== null) {
    throw pre.missingProfileError;
  }
  // Check installation and legacy-policy migration before writing memory
  // artifacts so conflicts leave setup intact.
  prepare_install(pre.source, pre.root, pre.names, {
    check,
    claude_skills,
    memory_options: pre.memoryOptions,
    install_options: claude_skills ? ['--claude-skills'] : [],
  });
  if (check) {
    install(pre.source, pre.root, {
      skills: pre.names,
      check: true,
      claude_skills,
      memory_options: pre.memoryOptions,
    });
    return { root: pre.root, ...Object.fromEntries(dictItems(pre.data)) };
  }
  if (pre.updatedIgnore !== pre.ignore) {
    atomic(pre.ignorePath, pre.updatedIgnore);
  }
  if (!existsSync(pre.target)) atomic(pre.target, pre.content);
  if (pre.currentInstructions !== pre.generated) {
    atomic(pre.instructions, pre.generated);
  }
  if (pre.updated !== pre.existing) atomic(pre.agents, pre.updated);
  install(pre.source, pre.root, { skills: pre.names, claude_skills });
  if (pre.connection === null) {
    pruneCleanedOwnership(pre.root, [], pre.connState, true);
  }
  const outcome: Record<string, unknown> = {
    root: pre.root,
    ...Object.fromEntries(dictItems(pre.data)),
  };
  if (pre.connection !== null) {
    const [written, warnings] = renderConnections(
      pre.root,
      pre.connection[0],
      pre.connection[1],
      pre.connection[2],
      pre.connection[3],
      home ?? undefined,
      pre.memoryRepair,
      pre.reconcileRepair,
      pre.connection[4],
    );
    outcome['rendered_connections'] = written;
    if (warnings.length) outcome['warnings'] = warnings;
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// argparse-compatible command line.
// ---------------------------------------------------------------------------

const PROG = 'agent-workflows.ts setup_memory';
const USAGE =
  `usage: ${PROG} [-h] --project PROJECT [--portable PORTABLE] [--check]\n` +
  '                       [--claude-skills] [--share-config] [--profile PROFILE]';

const HELP_TEXT =
  `${USAGE}\n` +
  '\n' +
  'Install Basic Memory setup guidance and local project routing; no memory I/O\n' +
  'or hooks.\n' +
  '\n' +
  'options:\n' +
  '  -h, --help           show this help message and exit\n' +
  '  --project PROJECT\n' +
  '  --portable PORTABLE\n' +
  '  --check\n' +
  '  --claude-skills      Also link the memory capability into .claude/skills\n' +
  '  --share-config       Do not add the local memory directory ignore; never\n' +
  '                       stages files or removes existing ignores\n' +
  '  --profile PROFILE    Machine connection profile override (default:\n' +
  '                       $XDG_CONFIG_HOME/agent-workflows/memory-\n' +
  '                       connection.toml)\n';

/** Raised to unwind `parser.error`/`--help` through `main`. */
class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function parserError(message: string): never {
  process.stderr.write(`${USAGE}\n${PROG}: error: ${message}\n`);
  throw new ExitError(2);
}

interface OptionSpec {
  names: string[];
  dest: 'help' | 'project' | 'portable' | 'check' | 'claude_skills' |
    'share_config' | 'profile';
  takesValue: boolean;
}

const OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--project'], dest: 'project', takesValue: true },
  { names: ['--portable'], dest: 'portable', takesValue: true },
  { names: ['--check'], dest: 'check', takesValue: false },
  { names: ['--claude-skills'], dest: 'claude_skills', takesValue: false },
  { names: ['--share-config'], dest: 'share_config', takesValue: false },
  { names: ['--profile'], dest: 'profile', takesValue: true },
];

/**
 * argparse's `_parse_optional` classification: a `-`-leading token is a
 * value when it is `-` alone, a negative number (this parser has no
 * negative-number options) or contains a space.
 */
function isOptionLike(token: string): boolean {
  if (!token.startsWith('-') || token === '-') return false;
  if (/^-\d+$|^-\d*\.\d+$/.test(token)) return false;
  if (token.includes(' ')) return false;
  return true;
}

function optionLabel(option: OptionSpec): string {
  return option.names.join('/');
}

function parseArgs(argv: string[]): {
  values: Record<string, string | boolean | undefined>;
  extras: string[];
} {
  const values: Record<string, string | boolean | undefined> = {};
  const extras: string[] = [];
  let index = 0;
  let pastSeparator = false;
  while (index < argv.length) {
    const arg = argv[index];
    index += 1;
    if (pastSeparator) {
      extras.push(arg);
      continue;
    }
    if (arg === '--') {
      pastSeparator = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const optName = eq < 0 ? arg : arg.slice(0, eq);
      const explicit = eq < 0 ? undefined : arg.slice(eq + 1);
      let option = OPTIONS.find((o) => o.names.includes(optName));
      if (option === undefined) {
        // allow_abbrev: an unambiguous prefix of one option resolves; more
        // than one is an ambiguous-option error, zero is an extra.
        const matched = OPTIONS.flatMap((o) =>
          o.names.filter((name) => name.startsWith(optName)),
        );
        const candidates = OPTIONS.filter((o) =>
          o.names.some((name) => matched.includes(name)),
        );
        if (candidates.length === 1) {
          option = candidates[0];
        } else if (candidates.length > 1) {
          parserError(
            `ambiguous option: ${arg} could match ${matched.join(', ')}`,
          );
        } else {
          extras.push(arg);
          continue;
        }
      }
      if (option.dest === 'help') {
        if (explicit !== undefined) {
          parserError(
            `argument ${optionLabel(option)}: ignored explicit argument` +
              ` ${pyRepr(explicit)}`,
          );
        }
        process.stdout.write(HELP_TEXT);
        throw new ExitError(0);
      }
      if (!option.takesValue) {
        if (explicit !== undefined) {
          parserError(
            `argument ${optionLabel(option)}: ignored explicit argument` +
              ` ${pyRepr(explicit)}`,
          );
        }
        values[option.dest] = true;
        continue;
      }
      let value = explicit;
      if (value === undefined) {
        const next = argv[index];
        if (next === undefined || next === '--' || isOptionLike(next)) {
          parserError(
            `argument ${optionLabel(option)}: expected one argument`,
          );
        }
        value = next;
        index += 1;
      }
      values[option.dest] = value;
      continue;
    }
    if (arg === '-h') {
      process.stdout.write(HELP_TEXT);
      throw new ExitError(0);
    }
    if (arg.startsWith('-h')) {
      // `consume_optional`: a no-argument single-dash option re-reads the
      // tail as more short options. A `=`-separated or `-`-leading
      // remainder is an ignored-explicit-argument error; an unknown tail
      // option lands in extras, so the queued help action still fires.
      let explicit = arg.slice(2);
      let separated = explicit.startsWith('=');
      if (separated) explicit = explicit.slice(1);
      for (;;) {
        if (separated || explicit.startsWith('-')) {
          parserError(
            `argument ${optionLabel(OPTIONS[0])}: ignored explicit argument` +
              ` ${pyRepr(explicit)}`,
          );
        }
        if (explicit === '' || explicit[0] !== 'h') {
          process.stdout.write(HELP_TEXT);
          throw new ExitError(0);
        }
        explicit = explicit.slice(1);
        separated = explicit.startsWith('=');
        if (separated) explicit = explicit.slice(1);
      }
    }
    if (arg.startsWith('-') && arg.length > 1) {
      extras.push(arg);
      continue;
    }
    extras.push(arg);
  }
  if (values.project === undefined) {
    parserError('the following arguments are required: --project');
  }
  return { values, extras };
}

function libraryRoot(): string {
  return dirname(dirname(pyResolve(fileURLToPath(import.meta.url))));
}

function runMain(argv: string[]): number {
  const { values, extras } = parseArgs(argv);
  if (extras.some((item) => item.includes('--skills'))) {
    console.log(SKILLS_MIGRATION);
    return 1;
  }
  if (extras.length) {
    parserError(`unrecognized arguments: ${extras.join(' ')}`);
  }
  try {
    const result = setup(libraryRoot(), values.project as string, {
      portable:
        values.portable !== undefined
          ? readPortable(purePath(values.portable as string))
          : null,
      check: values.check === true,
      share_config: values.share_config === true,
      claude_skills: values.claude_skills === true,
      profile:
        values.profile !== undefined
          ? purePath(values.profile as string)
          : null,
    });
    console.log(jsonDumps(result));
    return 0;
  } catch (error) {
    if (isValueOrOSError(error)) {
      console.log(errorText(error));
      return 1;
    }
    throw error;
  }
}

export function main(argv: string[] = process.argv.slice(2)): number {
  try {
    return runMain(argv);
  } catch (error) {
    if (error instanceof ExitError) return error.code;
    throw error;
  }
}

// `if __name__ == "__main__"`: Node resolves the invoked entry to its
// real path for import.meta.url while argv[1] keeps the typed spelling,
// so an invocation through a symlink must be resolved before comparing.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(pyResolve(process.argv[1])).href
) {
  process.exitCode = main();
}
