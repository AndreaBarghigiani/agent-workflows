/**
 * Inspection, planning and authorized application of project MCP client
 * configuration (issue #107).
 *
 * Given a consumer checkout, this module parses the project-scope MCP
 * configuration of each selected client — Claude `.mcp.json` plus the
 * `.claude/settings.local.json` approval signals, Codex
 * `.codex/config.toml`, and OpenCode `opencode.json` — proposes a mapping
 * between services declared in `.agents/mcp-requirements.json` and client
 * registration entries, and classifies every (service, client) pair.
 *
 * The module is pure and offline like `mcp_requirements`: it parses files
 * from the paths it is given and evaluates caller-supplied machine
 * descriptors. It never spawns a subprocess, opens a socket or reads the
 * environment at import or call time. Machine probing (executable
 * resolution, environment presence, resolved machine-local details)
 * arrives as the `machine` descriptor; live verification stays a separate
 * authorized action. Static inspection can never verify login or read
 * access, which is reported as `auth-unverified` — distinct from missing.
 *
 * A registration counts for a service only after explicit owner
 * confirmation through the `mapping` input. Equivalence heuristics (a
 * remote URL equal after stripping a single trailing slash, or the same
 * resolved command for stdio) only PROPOSE candidates. Inspection and
 * planning write nothing and store no alignment decisions — earlier
 * confirmations are data passed per call, never stored authorization.
 *
 * `buildPlan` returns a redacted, data-only plan (translated entries,
 * approval entries, destination digests, conflicts) that `apply` executes
 * only after the caller sets `plan["confirmed"]` following owner go-ahead
 * and records a `resolution` on every conflicted action. `apply` re-reads
 * every destination and refuses the whole plan — no partial writes — when
 * a recorded digest changed, the root differs, a conflict lacks a
 * resolution or the plan is malformed. Git tracking is never consulted:
 * the confirmed plan alone authorizes the bounded edits it describes.
 *
 * The thin `main` command line interface: `check` prints the redacted
 * classification report, `plan` writes the unconfirmed redacted plan, and
 * `apply` executes a plan file only when it records `"confirmed": true`
 * and the caller passes `--confirm` — the recorded explicit go-ahead
 * after the owner reviewed the plan. Mapping, machine and selections
 * inputs are JSON files holding names and pointers only.
 *
 * Emission contract: reports and snapshots contain allowlisted data only —
 * server names, file scopes, transport, enabled state, sanitized endpoint
 * origins (no userinfo, path, query or fragment), the executable token
 * (never its arguments), credential environment-variable NAMES and header
 * NAMES. No environment value, header value, command argument or other
 * secret-bearing string appears in any emitted structure.
 *
 * States per (service, client): `satisfied`, `proposed` (actionable but
 * unapplied), `conflict` (same-name clash, auth mismatch, duplicate or
 * shadowed registrations, explicit disables — explicit resolution
 * required), `missing-executable`, `auth-unverified`, `unsupported`
 * (transport or syntax the client cannot express) and
 * `unknown-inspection`.
 *
 * Import cycle, matching Python: `mcp_configure.py` imports `atomic` and
 * `parse_jsonc` from `memory_connections` at module top while
 * `memory_connections.py` imports `mcp_configure` inside
 * `memory_alignment`. This file statically imports `atomic`, `parseJsonc`,
 * `tomlLoads` and `jsonDumps` from `memory_connections.ts`;
 * `memory_connections.ts` reaches `inspectClient`/`equivalentUrl` here
 * through a deferred `import()` so initialization does not deadlock.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  realpathSync,
  statSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as mcpRequirements from './mcp_requirements.ts';
import {
  atomic,
  jsonDumps,
  parseJsonc,
  tomlLoads,
} from './memory_connections.ts';
import { TomlDate } from './vendor/smol-toml/index.js';
import {
  jsonLoadsError,
  jsonLoadsErrorMessage,
  PyFloat,
  pyJsonLoads,
} from './lib/pyloads.ts';
import { readText } from './lib/pyio.ts';
import {
  AttributeError,
  KeyError,
  PyTypeError,
  ValueError,
  osErrorName,
} from './lib/pyerrors.ts';
import { pyFloatRepr, pyRepr, pyStrRepr, pyTypeName } from './lib/pyrepr.ts';
import { pyUrlsplit } from './lib/pyurl.ts';

// --- Python value semantics ----------------------------------------------------
//
// Parsed JSON objects arrive as `Map`s (plain objects cannot keep Python's
// insertion order for integer-like keys) while parsed TOML and hand-built
// dicts stay plain objects — both shapes are dicts here.

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

/** `mapping[key]` without the KeyError — callers check `dictHas` first. */
function dictGet(mapping: Dict, key: string): unknown {
  return mapping instanceof Map ? mapping.get(key) : mapping[key];
}

/**
 * `mapping.get(key, default)` — returns the stored value when the key is
 * present (a stored `None` included), the default only when absent.
 */
function dictGetOr(mapping: Dict, key: string, fallback: unknown): unknown {
  return dictHas(mapping, key) ? dictGet(mapping, key) : fallback;
}

/** `mapping[key] = value` — insert or keep position, like Python dicts. */
function dictSet(mapping: Dict, key: string, value: unknown): void {
  if (mapping instanceof Map) mapping.set(key, value);
  else mapping[key] = value;
}

/** `del mapping[key]`. */
function dictDel(mapping: Dict, key: string): void {
  if (mapping instanceof Map) mapping.delete(key);
  else delete mapping[key];
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

/** `dict(value)` — a shallow copy preserving key order. */
function dictCopy(mapping: Dict): Dict {
  return mapping instanceof Map
    ? new Map<string, unknown>(mapping)
    : { ...mapping };
}

/** `mapping.get(key)` raising `AttributeError` on non-dicts, like Python. */
function pyGet(mapping: unknown, key: string, fallback?: unknown): unknown {
  if (!isDict(mapping)) {
    throw new AttributeError(
      `'${pyTypeName(mapping)}' object has no attribute 'get'`,
    );
  }
  return dictGetOr(mapping, key, fallback);
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

/** Python `==` over the JSON/TOML-shaped values this module compares. */
export function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
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
  if (a instanceof TomlDate || b instanceof TomlDate) {
    return (
      a instanceof TomlDate &&
      b instanceof TomlDate &&
      ((a.isDate() && b.isDate()) ||
        (a.isTime() && b.isTime()) ||
        (a.isDateTime() && b.isDateTime())) &&
      a.toISOString() === b.toISOString()
    );
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

/** `item in container` over the containers Python supports. */
function pyContains(container: unknown, item: unknown): boolean {
  if (typeof container === 'string') {
    if (typeof item !== 'string') {
      throw new PyTypeError(
        `'in <string>' requires string as left operand,` +
          ` not ${pyTypeName(item)}`,
      );
    }
    return container.includes(item);
  }
  if (Array.isArray(container)) {
    return container.some((member) => pyEq(member, item));
  }
  if (container instanceof Set) {
    for (const member of container) if (pyEq(member, item)) return true;
    return false;
  }
  if (isDict(container)) {
    return typeof item === 'string' && dictHas(container, item);
  }
  throw new PyTypeError(
    `argument of type '${pyTypeName(container)}' is not iterable`,
  );
}

/**
 * `sorted()` ordering for strings: Python orders `str` by Unicode code
 * point while JavaScript's default sort uses UTF-16 code units. Comparing
 * code point by code point reproduces CPython ordering.
 */
function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const l = left.next();
    const r = right.next();
    if (l.done) return r.done ? 0 : -1;
    if (r.done) return 1;
    if (l.value !== r.value) {
      return (l.value.codePointAt(0) ?? 0) - (r.value.codePointAt(0) ?? 0);
    }
  }
}

/** `sorted(strings)` — Python `str` ordering by code point. */
function pySortedStrings(values: Iterable<string>): string[] {
  return [...values].sort(compareCodePoints);
}

/** `copy.deepcopy` over the JSON/TOML-shaped values this module mutates. */
function pyDeepCopy(value: unknown): unknown {
  if (value instanceof Map) {
    return new Map<string, unknown>(
      [...value.entries()].map(([key, member]) => [
        key,
        pyDeepCopy(member),
      ]),
    );
  }
  if (Array.isArray(value)) return value.map(pyDeepCopy);
  if (isDict(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, member] of dictItems(value)) {
      copy[key] = pyDeepCopy(member);
    }
    return copy;
  }
  return value;
}

// --- Decoding and errors ---------------------------------------------------------

/** `json.loads` raising `ValueError` carrying the CPython error text. */
function jsonLoads(text: string): unknown {
  const error = jsonLoadsError(text);
  if (error !== null) {
    throw new ValueError(jsonLoadsErrorMessage(text, error));
  }
  return pyJsonLoads(text);
}

function isOSError(error: unknown): boolean {
  const name = (error as Error | undefined)?.name;
  return (
    name === 'OSError' ||
    name === 'FileNotFoundError' ||
    name === 'NotADirectoryError' ||
    name === 'IsADirectoryError' ||
    name === 'FileExistsError' ||
    name === 'PermissionError'
  );
}

/** Whether `error` lands in Python's `except (ValueError, OSError)`. */
function isValueOrOSError(error: unknown): boolean {
  return (
    (error as Error | undefined)?.name === 'ValueError' || isOSError(error)
  );
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

/** `str(error)` for embedding in diagnostic messages. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- Filesystem ---------------------------------------------------------------

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

/**
 * `Path(path).resolve()` with `strict=False`: resolve symlinks for the
 * deepest existing ancestor and append the remaining components.
 */
function resolvePath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  const base = realpathSync(existing);
  return missing.length ? join(base, ...missing) : base;
}

/** `path.is_relative_to(root)` — `path` already resolved by the caller. */
function isRelativeTo(root: string, path: string): boolean {
  if (root === '/') return isAbsolute(path);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path === root || path.startsWith(prefix);
}

/** `str.partition(sep)` → [before, sep-or-empty, after]. */
function partition(text: string, sep: string): [string, string, string] {
  const index = text.indexOf(sep);
  if (index < 0) return [text, '', ''];
  return [
    text.slice(0, index),
    sep,
    text.slice(index + sep.length),
  ];
}

/** Python's `str.strip()` whitespace set (differs from `String#trim`). */
const PY_STRIP =
  /^[\s\x1c-\x1f\x85\ufeff]+|[\s\x1c-\x1f\x85\ufeff]+$/g;

function pyStrip(text: string): string {
  return text.replace(PY_STRIP, '');
}

/** `str.splitlines(keepends=True)` — Python's line-boundary set. */
function splitlinesKeepends(text: string): string[] {
  const lines: string[] = [];
  const boundary = /[\n\x0b\f\r\x1c-\x1e\x85\u2028\u2029]/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text)) !== null) {
    let end = match.index + 1;
    if (match[0] === '\r' && text[end] === '\n') end += 1;
    lines.push(text.slice(start, end));
    boundary.lastIndex = end;
    start = end;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

// --- Module constants ------------------------------------------------------------

export const CLIENTS = ['claude', 'codex', 'opencode'] as const;
export const CLIENT_PATHS: Record<string, string> = {
  claude: '.mcp.json',
  codex: '.codex/config.toml',
  opencode: 'opencode.json',
};
export const CLAUDE_SETTINGS = '.claude/settings.local.json';

export const STATES = [
  'satisfied',
  'proposed',
  'conflict',
  'missing-executable',
  'auth-unverified',
  'unsupported',
  'unknown-inspection',
] as const;

const CLAUDE_ENTRY_KEYS = new Set([
  'type',
  'url',
  'headers',
  'command',
  'args',
  'env',
]);
// Fields current Codex MCP documentation lists for [mcp_servers.<name>];
// anything else is flagged unsupported rather than silently carried.
const CODEX_ENTRY_KEYS = new Set([
  'command',
  'args',
  'env',
  'env_vars',
  'url',
  'bearer_token_env_var',
  'http_headers',
  'env_http_headers',
  'enabled',
  'required',
  'cwd',
  'startup_timeout_sec',
  'startup_timeout_ms',
  'tool_timeout_sec',
  'enabled_tools',
  'disabled_tools',
]);
const OPENCODE_ENTRY_KEYS = new Set([
  'type',
  'command',
  'environment',
  'enabled',
  'url',
  'headers',
  'oauth',
  'disabled',
  'timeout',
]);
const CLAUDE_ENV_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const OPENCODE_ENV_TOKEN = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;
// Registration names become approval grants (mcp__<name>) and client
// configuration keys; anything outside this shape (wildcards, spaces,
// dots, separators) is refused at mapping input, plan build and plan
// validation.
const REGISTRATION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Return a diagnostic when `name` is unsafe, else `null`. */
export function registrationNameProblem(name: unknown): string | null {
  // Names containing `__` are ambiguous under Claude's approval grammar
  // (`mcp__<server>` vs `mcp__<server>__<tool>`): `mcp__victim__read`
  // would grant tool `read` on server `victim` instead of approving
  // server `victim__read`.
  if (typeof name !== 'string' || !REGISTRATION_NAME.test(name)) {
    return 'registration names must match ^[A-Za-z0-9][A-Za-z0-9_-]*$';
  }
  if (name.includes('__')) {
    return (
      "registration names must not contain '__' — Claude reads" +
      ' mcp__<name> with a double underscore as a per-tool grant'
    );
  }
  return null;
}

// Static inspection can never verify Codex project trust; the standing
// note is reported whenever Codex is in scope, never checked off.
export const CODEX_TRUST_NOTE =
  'Codex project trust is a separate prerequisite; this helper never' +
  ' edits global or trust settings; verify trust before relying on' +
  ' applied configuration.';

function checkClients(clients: readonly string[]): readonly string[] {
  const unknown = clients.filter(
    (client) => !Object.hasOwn(CLIENT_PATHS, client),
  );
  if (unknown.length) {
    throw new ValueError(
      `unknown client(s) ${unknown.join(', ')}; supported:` +
        ` ${Object.keys(CLIENT_PATHS).join(', ')}`,
    );
  }
  return clients;
}

/** Confirmed registration names must be usable destination names. */
export function checkMapping(mapping: unknown): Dict {
  // A mapping entry names what later becomes a client configuration key
  // and an approval grant; wildcard or otherwise malformed names are
  // refused here at mapping input, before any inspection or planning.
  if (!isDict(mapping)) {
    throw new ValueError(
      'mapping must be a service-id -> client -> registration-name' +
        ' mapping',
    );
  }
  for (const [serviceId, perClient] of dictItems(mapping)) {
    if (!isDict(perClient)) {
      throw new ValueError(
        `mapping for ${pyRepr(serviceId)} must be a client ->` +
          ' registration-name mapping',
      );
    }
    for (const [client, name] of dictItems(perClient)) {
      const problem = registrationNameProblem(name);
      if (problem !== null) {
        throw new ValueError(
          `mapping for ${pyRepr(serviceId)} on ${client} names` +
            ` registration ${pyRepr(name)}; ${problem}`,
        );
      }
    }
  }
  return mapping;
}

/** (manifest info, services) — absence and invalidity are graceful. */
function manifestOf(root: string): [Dict, Dict[]] {
  const info: Dict = new Map<string, unknown>([
    ['path', mcpRequirements.MANIFEST],
  ]);
  let manifest: Map<string, unknown> | null;
  try {
    manifest = mcpRequirements.loadManifest(root);
  } catch (error) {
    if ((error as Error)?.name !== 'ValueError') throw error;
    dictSet(info, 'present', true);
    dictSet(info, 'error', errorText(error));
    return [info, []];
  }
  if (manifest === null) {
    dictSet(info, 'present', false);
    dictSet(
      info,
      'note',
      'no .agents/mcp-requirements.json; the project' +
        ' declares no MCP requirements to align',
    );
    return [info, []];
  }
  dictSet(info, 'present', true);
  const services = dictGet(manifest, 'services') as Dict[];
  dictSet(
    info,
    'services',
    services.map((service) => dictGet(service, 'id')),
  );
  return [info, services];
}

// --- Client file parsing -----------------------------------------------------

export interface InspectEntry {
  name: string;
  shape: string;
  transport: string | null;
  inspection: string;
  url: string | null;
  command: string[] | null;
  enabled: boolean | null;
  env_names: Set<string>;
  header_names: Set<string>;
  env_refs: Set<string>;
  credential_names: Set<string>;
  inline_secrets: number;
  notes: string[];
  layers: string[];
}

export interface OpencodeAux {
  shadowed: Set<string>;
}

// The public block is a plain object: memory_connections indexes it with
// bracket access, and its keys are fixed non-integer-like names, so
// insertion order survives either shape.
export type ParsedClient = [
  Record<string, unknown>,
  Map<string, InspectEntry>,
  OpencodeAux,
];

function inspectEntry(name: string, shape: string): InspectEntry {
  return {
    name,
    shape,
    transport: null,
    inspection: 'ok',
    url: null,
    command: null,
    enabled: null,
    env_names: new Set(),
    header_names: new Set(),
    env_refs: new Set(),
    credential_names: new Set(),
    inline_secrets: 0,
    notes: [],
    layers: [],
  };
}

/** Allowlisted, redacted view of one registration entry. */
function publicEntry(entry: InspectEntry): Dict {
  const block = new Map<string, unknown>([
    ['transport', entry.transport],
    ['inspection', entry.inspection],
    ['shape', entry.shape],
    ['url', originOf(entry.url)],
    ['command', entry.command ? entry.command[0] : null],
    ['args', entry.command ? entry.command.length - 1 : 0],
    ['enabled', entry.enabled],
    ['env_names', pySortedStrings(entry.env_names)],
    ['header_names', pySortedStrings(entry.header_names)],
    ['env_refs', pySortedStrings(entry.env_refs)],
    ['credential_names', pySortedStrings(entry.credential_names)],
    ['notes', [...entry.notes]],
  ]);
  if (entry.layers.length) block.set('layers', entry.layers);
  if (entry.inline_secrets) {
    (block.get('notes') as string[]).push(
      `${entry.inline_secrets} literal value(s) present (redacted)`,
    );
  }
  return block;
}

/** Scheme + authority only; never userinfo, path, query or fragment. */
function originOf(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parts;
  let host: string | null;
  let port: number | null;
  try {
    parts = pyUrlsplit(url);
    host = parts.hostname;
    port = parts.port;
  } catch (error) {
    if ((error as Error)?.name !== 'ValueError') throw error;
    return null;
  }
  if (!parts.scheme || !host) return null;
  let origin = `${parts.scheme}://${host}`;
  if (port !== null) origin += `:${port}`;
  return origin;
}

/**
 * Record a remote entry's url, flagging authorities that cannot parse.
 *
 * The diagnostic names only the field — urlsplit errors embed the
 * offending text, which may be secret-bearing.
 */
function checkUrl(entry: InspectEntry, url: string): void {
  try {
    const parts = pyUrlsplit(url);
    void parts.hostname;
    void parts.port;
  } catch (error) {
    if ((error as Error)?.name !== 'ValueError') throw error;
    inspectMalformed(entry, "'url' has an invalid port or authority");
    return;
  }
  entry.url = url;
}

/** A malformed field degrades the entry to unknown-inspection. */
function inspectMalformed(entry: InspectEntry, what: string): void {
  if (entry.inspection === 'ok') entry.inspection = 'unknown';
  entry.notes.push(what);
}

/** Mark an entry unknown after an unexpected parse error. */
function inspectUninspectable(
  entry: InspectEntry,
  error: unknown,
): InspectEntry {
  entry.inspection = 'unknown';
  entry.notes.push(
    'the registration could not be inspected; reported as unknown' +
      ` (${(error as Error).name ?? 'Error'})`,
  );
  return entry;
}

function headerRefs(
  entry: InspectEntry,
  headers: Dict,
  tokenRef: RegExp,
): void {
  for (const [header, value] of dictItems(headers)) {
    entry.header_names.add(header);
    const refs =
      typeof value === 'string'
        ? [...value.matchAll(tokenRef)].map((match) => match[1])
        : [];
    if (refs.length) refs.forEach((ref) => entry.env_refs.add(ref));
    else entry.inline_secrets += 1;
  }
}

function envRefs(
  entry: InspectEntry,
  values: unknown[],
  tokenRef: RegExp,
): void {
  for (const value of values) {
    const refs =
      typeof value === 'string'
        ? [...value.matchAll(tokenRef)].map((match) => match[1])
        : [];
    if (refs.length) refs.forEach((ref) => entry.env_refs.add(ref));
    else entry.inline_secrets += 1;
  }
}

function argsOf(argv: string[], raw: unknown, entry: InspectEntry): string[] {
  if (!Array.isArray(raw) || raw.some((arg) => typeof arg !== 'string')) {
    entry.inspection = 'unknown';
    entry.notes.push("'args'/'command' must be an array of strings");
    return argv;
  }
  return [...argv, ...(raw as string[])];
}

function claudeEntries(doc: unknown): [Map<string, InspectEntry>, string[]] {
  const entries = new Map<string, InspectEntry>();
  const diagnostics: string[] = [];
  if (!isDict(doc)) return [entries, ['top-level JSON is not an object']];
  const servers = dictGetOr(doc, 'mcpServers', {});
  if (!isDict(servers)) {
    if (dictHas(doc, 'mcpServers')) {
      diagnostics.push("'mcpServers' is not an object");
    }
    return [entries, diagnostics];
  }
  for (const [name, raw] of dictItems(servers)) {
    try {
      entries.set(name, claudeEntryInspect(name, raw));
    } catch (error) {
      entries.set(
        name,
        inspectUninspectable(inspectEntry(name, 'project'), error),
      );
    }
  }
  return [entries, diagnostics];
}

function claudeEntryInspect(name: string, raw: unknown): InspectEntry {
  const entry = inspectEntry(name, 'project');
  if (!isDict(raw)) {
    entry.inspection = 'unknown';
    entry.notes.push('entry is not an object');
    return entry;
  }
  const extra = pySortedStrings(
    dictKeys(raw).filter((key) => !CLAUDE_ENTRY_KEYS.has(key)),
  );
  if (extra.length) {
    entry.notes.push(`unrecognized fields: ${extra.join(', ')}`);
  }
  const kind = dictGet(raw, 'type');
  if (kind === 'http' || kind === 'sse') {
    entry.transport = 'remote';
    const url = dictGet(raw, 'url');
    if (typeof url !== 'string' || !url) {
      entry.inspection = 'unknown';
      entry.notes.push(`${kind} entry without a string 'url'`);
    } else {
      checkUrl(entry, url);
    }
    const headers = dictGetOr(raw, 'headers', {});
    if (isDict(headers)) {
      headerRefs(entry, headers, CLAUDE_ENV_TOKEN);
    } else {
      entry.inspection = 'unknown';
      entry.notes.push("'headers' is not an object");
    }
  } else if (typeof kind === 'string') {
    entry.inspection = 'unsupported';
    entry.notes.push(
      `transport 'type' ${pyStrRepr(kind)} is not supported by Claude` +
        " project .mcp.json (expected 'http', 'sse' or a command" +
        ' entry)',
    );
  } else if (typeof dictGet(raw, 'command') === 'string') {
    entry.transport = 'stdio';
    entry.command = argsOf(
      [dictGet(raw, 'command') as string],
      dictGetOr(raw, 'args', []),
      entry,
    );
    const env = dictGetOr(raw, 'env', {});
    if (isDict(env)) {
      entry.env_names = new Set(dictKeys(env));
      envRefs(
        entry,
        dictItems(env).map(([, value]) => value),
        CLAUDE_ENV_TOKEN,
      );
    } else {
      entry.inspection = 'unknown';
      entry.notes.push("'env' is not an object");
    }
  } else {
    entry.inspection = 'unknown';
    entry.notes.push(
      'entry matches neither {command, args?, env?} nor {type:' +
        ' http|sse, url, headers?}',
    );
  }
  return entry;
}

function codexEntries(doc: unknown): [Map<string, InspectEntry>, string[]] {
  const entries = new Map<string, InspectEntry>();
  const diagnostics: string[] = [];
  if (!isDict(doc)) return [entries, ['top-level TOML is not a table']];
  const servers = dictGetOr(doc, 'mcp_servers', {});
  if (!isDict(servers)) {
    if (dictHas(doc, 'mcp_servers')) {
      diagnostics.push("'mcp_servers' is not a table");
    }
    return [entries, diagnostics];
  }
  for (const [name, raw] of dictItems(servers)) {
    try {
      entries.set(name, codexEntryInspect(name, raw));
    } catch (error) {
      entries.set(
        name,
        inspectUninspectable(inspectEntry(name, 'project'), error),
      );
    }
  }
  return [entries, diagnostics];
}

function codexEntryInspect(name: string, raw: unknown): InspectEntry {
  const entry = inspectEntry(name, 'project');
  if (!isDict(raw)) {
    entry.inspection = 'unknown';
    entry.notes.push('entry is not a table');
    return entry;
  }
  const extra = pySortedStrings(
    dictKeys(raw).filter((key) => !CODEX_ENTRY_KEYS.has(key)),
  );
  if (extra.length) {
    entry.inspection = 'unsupported';
    entry.notes.push(
      'field(s) not supported by current Codex MCP configuration:' +
        ` ${extra.join(', ')}`,
    );
  }
  const url = dictGet(raw, 'url');
  const command = dictGet(raw, 'command');
  if (typeof url === 'string' && url) {
    entry.transport = 'remote';
    checkUrl(entry, url);
    if (command !== undefined && command !== null) {
      entry.notes.push(
        "entry sets both 'url' and 'command'; Codex treats one" +
          ' entry as one transport',
      );
    }
  } else if (typeof command === 'string' && command) {
    entry.transport = 'stdio';
    entry.command = argsOf([command], dictGetOr(raw, 'args', []), entry);
  } else {
    if (entry.inspection === 'ok') entry.inspection = 'unknown';
    entry.notes.push("entry declares neither 'url' nor" + " 'command'");
  }
  const env = dictGetOr(raw, 'env', {});
  if (isDict(env)) {
    entry.env_names = new Set(dictKeys(env));
    // Codex env values are literal; every one is secret-bearing.
    entry.inline_secrets += dictItems(env).filter(
      ([, value]) => typeof value === 'string',
    ).length;
  } else if (dictHas(raw, 'env')) {
    inspectMalformed(entry, "'env' must be a table");
  }
  const envVars = dictGet(raw, 'env_vars');
  if (envVars !== undefined && envVars !== null) {
    if (
      Array.isArray(envVars) &&
      envVars.every((ref) => typeof ref === 'string')
    ) {
      for (const ref of envVars) entry.credential_names.add(ref as string);
    } else {
      inspectMalformed(entry, "'env_vars' must be an array of strings");
    }
  }
  const bearer = dictGet(raw, 'bearer_token_env_var');
  if (typeof bearer === 'string') {
    entry.credential_names.add(bearer);
  } else if (dictHas(raw, 'bearer_token_env_var')) {
    inspectMalformed(entry, "'bearer_token_env_var' must be a string");
  }
  const headers = dictGetOr(raw, 'http_headers', {});
  if (isDict(headers)) {
    headerRefs(entry, headers, CLAUDE_ENV_TOKEN);
  } else if (dictHas(raw, 'http_headers')) {
    inspectMalformed(entry, "'http_headers' must be a table");
  }
  const envHeaders = dictGetOr(raw, 'env_http_headers', {});
  if (isDict(envHeaders)) {
    for (const [header, ref] of dictItems(envHeaders)) {
      entry.header_names.add(header);
      if (typeof ref === 'string') entry.env_refs.add(ref);
    }
  } else if (dictHas(raw, 'env_http_headers')) {
    inspectMalformed(entry, "'env_http_headers' must be a table");
  }
  if (typeof dictGet(raw, 'enabled') === 'boolean') {
    entry.enabled = dictGet(raw, 'enabled') as boolean;
  }
  return entry;
}

function opencodeEntries(
  doc: unknown,
): [Map<string, InspectEntry>, string[], OpencodeAux] {
  const entries = new Map<string, InspectEntry>();
  const diagnostics: string[] = [];
  const aux: OpencodeAux = { shadowed: new Set<string>() };
  if (!isDict(doc)) {
    return [entries, ['top-level JSON is not an object'], aux];
  }
  const mcp = dictGetOr(doc, 'mcp', {});
  if (!isDict(mcp)) {
    if (dictHas(doc, 'mcp')) diagnostics.push("'mcp' is not an object");
    return [entries, diagnostics, aux];
  }
  const layers = new Map<string, [string, unknown][]>();
  const servers = dictGetOr(mcp, 'servers', {});
  if (isDict(servers)) {
    for (const [name, raw] of dictItems(servers)) {
      const defs = layers.get(name) ?? [];
      defs.push(['mcp.servers', raw]);
      layers.set(name, defs);
    }
  }
  for (const [name, raw] of dictItems(mcp)) {
    if (name === 'servers') continue;
    const defs = layers.get(name) ?? [];
    defs.push(['mcp', raw]);
    layers.set(name, defs);
  }
  for (const [name, defs] of layers) {
    // The generated v2 layer wins for the effective view, matching
    // memory_connections' treatment of mcp.<name> as the legacy shape.
    const [shape, raw] = defs.find((d) => d[0] === 'mcp.servers') ?? defs[0];
    let inspected: InspectEntry;
    try {
      inspected = opencodeEntryInspect(name, shape, raw);
    } catch (error) {
      inspected = inspectUninspectable(inspectEntry(name, shape), error);
    }
    inspected.layers = pySortedStrings(defs.map(([layer]) => layer));
    entries.set(name, inspected);
    if (defs.length > 1) {
      aux.shadowed.add(name);
      diagnostics.push(
        `registration ${pyStrRepr(name)} is defined under both 'mcp' and` +
          " 'mcp.servers'; the duplicate needs explicit resolution",
      );
    }
  }
  return [entries, diagnostics, aux];
}

function opencodeEntryInspect(
  name: string,
  shape: string,
  raw: unknown,
): InspectEntry {
  const entry = inspectEntry(name, shape);
  if (!isDict(raw)) {
    entry.inspection = 'unknown';
    entry.notes.push('entry is not an object');
    return entry;
  }
  const extra = pySortedStrings(
    dictKeys(raw).filter((key) => !OPENCODE_ENTRY_KEYS.has(key)),
  );
  if (extra.length) {
    entry.notes.push(`unrecognized fields: ${extra.join(', ')}`);
  }
  const kind = dictGet(raw, 'type');
  if (kind === 'remote') {
    entry.transport = 'remote';
    const url = dictGet(raw, 'url');
    if (typeof url !== 'string' || !url) {
      entry.inspection = 'unknown';
      entry.notes.push("remote entry without a string 'url'");
    } else {
      checkUrl(entry, url);
    }
    const headers = dictGetOr(raw, 'headers', {});
    if (isDict(headers)) {
      headerRefs(entry, headers, OPENCODE_ENV_TOKEN);
    } else {
      entry.inspection = 'unknown';
      entry.notes.push("'headers' is not an object");
    }
    if (dictHas(raw, 'oauth')) {
      entry.notes.push(
        "explicit 'oauth' policy recorded; authentication path is" +
          ' an owner decision',
      );
    }
  } else if (kind === 'local') {
    entry.transport = 'stdio';
    if (Array.isArray(dictGet(raw, 'command'))) {
      entry.command = argsOf([], dictGet(raw, 'command'), entry);
    } else {
      entry.inspection = 'unknown';
      entry.notes.push("local entry without a 'command' array");
    }
    const environment = dictGetOr(raw, 'environment', {});
    if (isDict(environment)) {
      entry.env_names = new Set(dictKeys(environment));
      envRefs(
        entry,
        dictItems(environment).map(([, value]) => value),
        OPENCODE_ENV_TOKEN,
      );
    } else {
      entry.inspection = 'unknown';
      entry.notes.push("'environment' is not an object");
    }
  } else if (typeof kind === 'string') {
    entry.inspection = 'unsupported';
    entry.notes.push(
      `transport 'type' ${pyStrRepr(kind)} is not supported by OpenCode` +
        " (expected 'local' or 'remote')",
    );
  } else {
    entry.inspection = 'unknown';
    entry.notes.push("entry declares no 'type' of 'local' or" + " 'remote'");
  }
  if (typeof dictGet(raw, 'enabled') === 'boolean') {
    entry.enabled = dictGet(raw, 'enabled') as boolean;
  }
  if (dictGet(raw, 'disabled') === true) {
    entry.enabled = false;
  }
  return entry;
}

/** Approval signals from .claude/settings.local.json (names only). */
function claudeApprovals(root: string): Dict {
  const path = join(root, CLAUDE_SETTINGS);
  const out: Dict = new Map<string, unknown>([
    ['path', CLAUDE_SETTINGS],
    ['present', isFile(path)],
    ['allow', new Map<string, unknown>()],
    ['enabled', []],
    ['disabled', []],
    ['enable_all', false],
    ['error', null],
  ]);
  if (!(dictGet(out, 'present') as boolean)) return out;
  let data: unknown;
  try {
    data = jsonLoads(readText(path));
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    dictSet(out, 'error', `unreadable ${CLAUDE_SETTINGS}: ${errorText(error)}`);
    return out;
  }
  if (!isDict(data)) {
    dictSet(out, 'error', `${CLAUDE_SETTINGS} is not a JSON object`);
    return out;
  }
  const permissions = dictGetOr(data, 'permissions', {});
  const allow = isDict(permissions)
    ? dictGetOr(permissions, 'allow', [])
    : [];
  if (Array.isArray(allow)) {
    for (const item of allow) {
      if (typeof item !== 'string' || !item.startsWith('mcp__')) continue;
      const rest = item.slice('mcp__'.length);
      const boundary = rest.indexOf('__');
      const server = boundary < 0 ? rest : rest.slice(0, boundary);
      const tool = boundary < 0 ? '' : rest.slice(boundary + 2);
      if (server) {
        const allowMap = dictGet(out, 'allow') as Map<string, string[]>;
        const grants = allowMap.get(server) ?? [];
        grants.push(tool || '*');
        allowMap.set(server, grants);
      }
    }
  }
  for (const [key, dest] of [
    ['enabledMcpjsonServers', 'enabled'],
    ['disabledMcpjsonServers', 'disabled'],
  ] as const) {
    const values = dictGetOr(data, key, []);
    if (Array.isArray(values)) {
      dictSet(
        out,
        dest,
        values.filter((v) => typeof v === 'string'),
      );
    }
  }
  dictSet(out, 'enable_all', dictGet(data, 'enableAllProjectMcpServers') === true);
  return out;
}

/** (public block, private entries, aux) for one client's project file. */
function parseClient(root: string, client: string): ParsedClient {
  const relativePath = CLIENT_PATHS[client];
  const path = join(root, relativePath);
  const block: Record<string, unknown> = {
    path: relativePath,
    present: isFile(path),
    readable: true,
    entries: new Map<string, unknown>(),
    diagnostics: [] as string[],
  };
  let entries = new Map<string, InspectEntry>();
  let aux: OpencodeAux = { shadowed: new Set<string>() };
  if (dictGet(block, 'present') as boolean) {
    let doc: unknown = null;
    let text: string | null = null;
    try {
      text = readText(path);
    } catch (error) {
      if (!isOSError(error)) throw error;
      dictSet(block, 'readable', false);
      (dictGet(block, 'diagnostics') as string[]).push(
        `unreadable ${relativePath}: ${errorText(pyOsError(error))}`,
      );
    }
    if (text !== null) {
      try {
        if (client === 'codex') {
          doc = tomlLoads(text);
        } else {
          try {
            doc = jsonLoads(text);
          } catch (inner) {
            if ((inner as Error)?.name !== 'ValueError') throw inner;
            doc = parseJsonc(text);
            (dictGet(block, 'diagnostics') as string[]).push(
              `${relativePath} is not strict JSON; inspected with` +
                ' JSONC tolerance',
            );
          }
        }
      } catch (error) {
        if ((error as Error)?.name !== 'ValueError') throw error;
        dictSet(block, 'readable', false);
        (dictGet(block, 'diagnostics') as string[]).push(
          `unreadable ${relativePath}: ${errorText(error)}`,
        );
      }
    }
    if (doc !== null && doc !== undefined) {
      let problems: string[] = [];
      if (client === 'claude') {
        [entries, problems] = claudeEntries(doc);
      } else if (client === 'codex') {
        [entries, problems] = codexEntries(doc);
      } else {
        [entries, problems, aux] = opencodeEntries(doc);
      }
      (dictGet(block, 'diagnostics') as string[]).push(...problems);
    }
  }
  const entriesBlock = new Map<string, unknown>();
  for (const [name, entry] of entries) {
    entriesBlock.set(name, publicEntry(entry));
  }
  dictSet(block, 'entries', entriesBlock);
  if (client === 'claude') {
    dictSet(block, 'approvals', claudeApprovals(root));
    if (
      (dictGet(dictGet(block, 'approvals') as Dict, 'enable_all') as boolean)
    ) {
      (dictGet(block, 'diagnostics') as string[]).push(
        `${CLAUDE_SETTINGS} sets enableAllProjectMcpServers — a broad` +
          ' grant this tooling reports but never introduces',
      );
    }
  }
  return [block, entries, aux];
}

/** Redacted per-client snapshot of project MCP configuration. */
export function inspectProject(
  root: string,
  clients: readonly string[] = CLIENTS,
): Dict {
  const snapshot = new Map<string, unknown>();
  for (const client of checkClients(clients)) {
    snapshot.set(client, parseClient(root, client)[0]);
  }
  return snapshot;
}

/**
 * (public block, private entries, aux) for one client.
 *
 * In-process reuse for callers that evaluate entries themselves (the
 * Basic Memory consumer-owned alignment check in
 * `memory_connections`). Private entries carry full endpoints and
 * argument lists for in-memory equivalence checks only; only
 * `public` output may ever be emitted.
 */
export function inspectClient(root: string, client: string): ParsedClient {
  checkClients([client]);
  return parseClient(root, client);
}

/** The endpoint-equivalence heuristic, shared with alignment checks. */
export function equivalentUrl(a: unknown, b: unknown): boolean {
  const norm = (url: unknown): unknown =>
    typeof url === 'string' && url.endsWith('/') ? url.slice(0, -1) : url;
  return (
    typeof a === 'string' && typeof b === 'string' && norm(a) === norm(b)
  );
}

// --- Equivalence --------------------------------------------------------------

function sameCommand(a: string[] | null, b: string[] | null): boolean {
  if (!a || !b || !a.length || !b.length) return false;
  return (
    basename(a[0]) === basename(b[0]) && pyEq(a.slice(1), b.slice(1))
  );
}

function serviceEndpoint(service: Dict, machine: Dict): unknown {
  const connection = dictGetOr(service, 'connection', null) ?? {};
  if (dictGet(connection as Dict, 'type') !== 'remote') return null;
  if (typeof dictGet(connection as Dict, 'url') === 'string') {
    return dictGet(connection as Dict, 'url');
  }
  const localRefs = dictGetOr(machine, 'local_config_refs', null) ?? {};
  const details = dictGetOr(
    localRefs as Dict,
    dictGet(connection as Dict, 'local_config_ref') as string,
    undefined,
  );
  if (isDict(details) && typeof dictGet(details, 'endpoint') === 'string') {
    return dictGet(details, 'endpoint');
  }
  return null;
}

function serviceCommand(service: Dict, machine: Dict): string[] | null {
  const connection = dictGetOr(service, 'connection', null) ?? {};
  if (dictGet(connection as Dict, 'type') !== 'stdio') return null;
  const localRefs = dictGetOr(machine, 'local_config_refs', null) ?? {};
  const details = dictGetOr(
    localRefs as Dict,
    dictGet(connection as Dict, 'command_ref') as string,
    undefined,
  );
  if (isDict(details)) {
    const command = dictGet(details, 'command');
    if (typeof command === 'string') return [command];
    if (Array.isArray(command)) {
      return command.filter((part) => typeof part === 'string') as string[];
    }
  }
  return null;
}

/** Heuristic PROPOSAL only; confirmation arrives through `mapping`. */
function equivalentEntry(
  entry: InspectEntry,
  service: Dict,
  machine: Dict,
): boolean {
  const connection = dictGet(service, 'connection');
  if (
    entry.inspection !== 'ok' ||
    entry.transport === null ||
    !pyTruthy(connection)
  ) {
    return false;
  }
  if (dictGet(connection as Dict, 'type') === 'remote') {
    const endpoint = serviceEndpoint(service, machine);
    return (
      entry.transport === 'remote' &&
      endpoint !== null &&
      endpoint !== undefined &&
      equivalentUrl(entry.url, endpoint)
    );
  }
  const command = serviceCommand(service, machine);
  return (
    entry.transport === 'stdio' &&
    command !== null &&
    sameCommand(entry.command, command)
  );
}

function missingExecutable(command: string[] | null, machine: Dict): boolean {
  if (!command || !dictHas(machine, 'executables')) return false;
  const executables = new Set(
    (dictGetOr(machine, 'executables', []) as Iterable<string>) ?? [],
  );
  return (
    !executables.has(command[0]) && !executables.has(basename(command[0]))
  );
}

/** Credential names the service or entry carries (names only). */
function authMaterial(
  entry: InspectEntry,
  service: Dict,
): [Set<string>, Set<string>] {
  const declared = new Set(
    (dictGetOr(service, 'credential_refs', []) as Iterable<string>) ?? [],
  );
  const auth =
    dictGetOr(
      (dictGetOr(service, 'connection', {}) as Dict) ?? {},
      'auth',
      {},
    ) ?? {};
  if (
    isDict(auth) &&
    dictGet(auth, 'mechanism') === 'api-key' &&
    dictGet(auth, 'credential_ref')
  ) {
    declared.add(dictGet(auth, 'credential_ref') as string);
  }
  const carried = new Set<string>([
    ...entry.env_names,
    ...entry.env_refs,
    ...entry.credential_names,
  ]);
  return [declared, carried];
}

// --- Classification -----------------------------------------------------------

function resultEntry(service: Dict, client: string, environment: string): Dict {
  return new Map<string, unknown>([
    ['service', dictGet(service, 'id')],
    ['client', client],
    ['environment', environment],
    ['required', dictGetOr(service, 'required', false)],
    ['registration', null],
    ['candidates', []],
    ['state', null],
    ['diagnostics', [] as string[]],
    ['limitations', [] as string[]],
  ]);
}

function classify(
  service: Dict,
  client: string,
  block: Dict,
  entries: Map<string, InspectEntry>,
  aux: OpencodeAux,
  machine: Dict,
  mapping: Dict,
  environment: string,
): Dict {
  const result = resultEntry(service, client, environment);
  if (dictGet(block, 'present') === true && dictGet(block, 'readable') === false) {
    dictSet(result, 'state', 'unknown-inspection');
    (dictGet(result, 'diagnostics') as string[]).push(
      ...(dictGet(block, 'diagnostics') as string[]),
    );
    (dictGet(result, 'limitations') as string[]).push(
      'client configuration unreadable; inspection unavailable for' +
        ' this client',
    );
    return result;
  }
  const perService = dictGetOr(mapping, dictGet(service, 'id') as string, null);
  const confirmed = isDict(perService)
    ? dictGetOr(perService, client, null)
    : null;
  const shadowed = aux.shadowed ?? new Set<string>();
  if (confirmed !== null && confirmed !== undefined) {
    dictSet(result, 'registration', confirmed);
    if (shadowed.has(confirmed as string)) {
      dictSet(result, 'state', 'conflict');
      (dictGet(result, 'diagnostics') as string[]).push(
        `registration ${pyStrRepr(confirmed as string)} is defined under` +
          " both 'mcp' and 'mcp.servers'; the shadowing needs explicit" +
          ' resolution',
      );
    } else if (!entries.has(confirmed as string)) {
      dictSet(result, 'state', 'proposed');
      (dictGet(result, 'limitations') as string[]).push(
        `confirmed registration ${pyStrRepr(confirmed as string)} is not` +
          ` present in ${dictGet(block, 'path')}; an authorized edit in a` +
          ' later slice creates it',
      );
    } else {
      applyEntry(
        result,
        entries.get(confirmed as string) as InspectEntry,
        service,
        client,
        block,
        machine,
      );
    }
  } else {
    const matches = pySortedStrings(
      [...entries.entries()]
        .filter(([, entry]) => equivalentEntry(entry, service, machine))
        .map(([name]) => name),
    );
    if (matches.some((name) => shadowed.has(name))) {
      dictSet(result, 'state', 'conflict');
      dictSet(result, 'candidates', matches);
      (dictGet(result, 'diagnostics') as string[]).push(
        'matching registration(s) are shadowed by a duplicate' +
          ' definition; explicit resolution required',
      );
    } else if (matches.length > 1) {
      dictSet(result, 'state', 'conflict');
      dictSet(result, 'candidates', matches);
      (dictGet(result, 'diagnostics') as string[]).push(
        'multiple registrations match this service; an explicit' +
          ' owner selection is required',
      );
    } else if (matches.length === 1) {
      dictSet(result, 'candidates', matches);
      const entry = entries.get(matches[0]) as InspectEntry;
      if (entry.enabled === false) {
        dictSet(result, 'state', 'conflict');
        (dictGet(result, 'diagnostics') as string[]).push(
          `matching registration ${pyStrRepr(matches[0])} is explicitly` +
            ' disabled; requires explicit resolution',
        );
      } else {
        dictSet(result, 'state', 'proposed');
        (dictGet(result, 'limitations') as string[]).push(
          `candidate registration ${pyStrRepr(matches[0])} matches by` +
            ' endpoint/command equivalence; it becomes the mapping' +
            ' only through explicit owner selection',
        );
      }
    } else {
      unregistered(result, service, block, machine);
    }
  }
  return result;
}

function applyEntry(
  result: Dict,
  entry: InspectEntry,
  service: Dict,
  client: string,
  block: Dict,
  machine: Dict,
): void {
  if (entry.inspection === 'unknown') {
    dictSet(result, 'state', 'unknown-inspection');
    (dictGet(result, 'diagnostics') as string[]).push(...entry.notes);
    (dictGet(result, 'limitations') as string[]).push(
      'registration shape is unrecognized; reported as unknown, not' +
        ' missing',
    );
    return;
  }
  if (entry.inspection === 'unsupported') {
    dictSet(result, 'state', 'unsupported');
    (dictGet(result, 'diagnostics') as string[]).push(...entry.notes);
    (dictGet(result, 'limitations') as string[]).push(
      'registration uses transport or syntax the client cannot' +
        ' express',
    );
    return;
  }
  if (entry.enabled === false) {
    dictSet(result, 'state', 'conflict');
    (dictGet(result, 'diagnostics') as string[]).push(
      `registration ${pyStrRepr(entry.name)} is explicitly disabled;` +
        ' explicit resolution required',
    );
    return;
  }
  const approvals = dictGetOr(block, 'approvals', null);
  if (
    client === 'claude' &&
    isDict(approvals) &&
    pyContains(dictGetOr(approvals, 'disabled', []), entry.name)
  ) {
    dictSet(result, 'state', 'conflict');
    (dictGet(result, 'diagnostics') as string[]).push(
      `${CLAUDE_SETTINGS} records ${pyStrRepr(entry.name)} in` +
        ' disabledMcpjsonServers; explicit resolution required',
    );
    return;
  }
  const connection = dictGet(service, 'connection');
  if (connection !== null && connection !== undefined) {
    const want =
      dictGet(connection as Dict, 'type') === 'remote' ? 'remote' : 'stdio';
    if (entry.transport !== want) {
      dictSet(result, 'state', 'conflict');
      (dictGet(result, 'diagnostics') as string[]).push(
        `registration ${pyStrRepr(entry.name)} is a ${entry.transport}` +
          ` entry; the service declares a ${want} connection`,
      );
      return;
    }
    const resolved =
      want === 'remote'
        ? serviceEndpoint(service, machine)
        : serviceCommand(service, machine);
    if (resolved === null || resolved === undefined) {
      dictSet(result, 'state', 'unknown-inspection');
      (dictGet(result, 'diagnostics') as string[]).push(
        'the service connection does not resolve in the machine' +
          ' descriptor; the registration cannot be checked against' +
          ' it — reported as unknown, not missing',
      );
      return;
    }
    if (!equivalentEntry(entry, service, machine)) {
      dictSet(result, 'state', 'conflict');
      (dictGet(result, 'diagnostics') as string[]).push(
        `registration ${pyStrRepr(entry.name)} points at a different` +
          ' endpoint or command than the service declares; explicit' +
          ' resolution required',
      );
      return;
    }
  }
  if (entry.transport === 'stdio') {
    if (missingExecutable(entry.command, machine)) {
      dictSet(result, 'state', 'missing-executable');
      (dictGet(result, 'diagnostics') as string[]).push(
        `executable ${pyStrRepr((entry.command as string[])[0])} does not` +
          ' resolve on this machine (machine descriptor); install it' +
          ' before relying on the registration',
      );
      return;
    }
    if (!dictHas(machine, 'executables')) {
      (dictGet(result, 'limitations') as string[]).push(
        'executable resolution not probed by the machine' +
          ' descriptor',
      );
    }
  }
  const [declared, carried] = authMaterial(entry, service);
  const missing = pySortedStrings(
    [...declared].filter((name) => !carried.has(name)),
  );
  if (missing.length) {
    dictSet(result, 'state', 'conflict');
    (dictGet(result, 'diagnostics') as string[]).push(
      'auth mismatch: the entry does not reference declared' +
        ` credential name(s) ${missing.join(', ')}`,
    );
    return;
  }
  const withoutRegistrations = new Map<string, unknown>();
  for (const [key, value] of dictItems(machine)) {
    if (key !== 'registrations') withoutRegistrations.set(key, value);
  }
  (dictGet(result, 'diagnostics') as string[]).push(
    ...mcpRequirements.unmet(service, withoutRegistrations),
  );
  if (declared.size || carried.size) {
    dictSet(result, 'state', 'auth-unverified');
    (dictGet(result, 'limitations') as string[]).push(
      'static inspection cannot verify login or read access;' +
        ' registration is not evidence of an authenticated session —' +
        ' live verification is a separate authorized action',
    );
  } else {
    dictSet(result, 'state', 'satisfied');
    (dictGet(result, 'limitations') as string[]).push(
      'configuration satisfies the declared connection; live access' +
        ' was not probed',
    );
  }
  if (client === 'claude') {
    claudeApprovalNote(result, entry.name, block);
  }
}

function claudeApprovalNote(result: Dict, name: string, block: Dict): void {
  const approvals = dictGetOr(block, 'approvals', null);
  const evidence: string[] = [];
  const allow = isDict(approvals) ? dictGetOr(approvals, 'allow', {}) : {};
  const grants = isDict(allow) ? (dictGetOr(allow, name, []) as string[]) : [];
  if (pyContains(grants, '*')) {
    evidence.push('permissions.allow server grant');
  }
  const tools = grants.filter((grant) => grant !== '*');
  if (tools.length) {
    evidence.push(`permissions.allow tool grant(s): ${tools.join(', ')}`);
  }
  if (
    isDict(approvals) &&
    pyContains(dictGetOr(approvals, 'enabled', []), name)
  ) {
    evidence.push('enabledMcpjsonServers');
  }
  if (isDict(approvals) && dictGet(approvals, 'enable_all') === true) {
    evidence.push(
      'broad enableAllProjectMcpServers grant (flagged;' +
        ' never introduced by this tooling)',
    );
  }
  if (evidence.length) {
    (dictGet(result, 'limitations') as string[]).push(
      `recorded approval evidence: ${evidence.join('; ')}`,
    );
  } else {
    (dictGet(result, 'limitations') as string[]).push(
      'no recorded approval for this registration; an interactive' +
        ' prompt or an authorized approval edit is still required',
    );
  }
}

function unregistered(
  result: Dict,
  service: Dict,
  block: Dict,
  machine: Dict,
): void {
  const connection = dictGet(service, 'connection');
  if (connection === null || connection === undefined) {
    dictSet(result, 'state', 'unknown-inspection');
    (dictGet(result, 'diagnostics') as string[]).push(
      ...mcpRequirements.unmet(service, machine),
    );
    (dictGet(result, 'limitations') as string[]).push(
      'the service declares no connection and no registration;' +
        ' cannot determine how this client could provide it —' +
        ' reported as unknown, not missing',
    );
    return;
  }
  const withoutRegistrations = new Map<string, unknown>();
  for (const [key, value] of dictItems(machine)) {
    if (key !== 'registrations') withoutRegistrations.set(key, value);
  }
  (dictGet(result, 'diagnostics') as string[]).push(
    ...mcpRequirements.unmet(service, withoutRegistrations),
  );
  if (dictGet(connection as Dict, 'type') === 'remote') {
    const endpoint = serviceEndpoint(service, machine);
    if (endpoint !== null && endpoint !== undefined) {
      let scheme: string | null;
      try {
        scheme = pyUrlsplit(endpoint).scheme;
      } catch (error) {
        if ((error as Error)?.name !== 'ValueError') throw error;
        scheme = null;
      }
      if (scheme !== 'http' && scheme !== 'https') {
        dictSet(result, 'state', 'unsupported');
        (dictGet(result, 'diagnostics') as string[]).push(
          scheme === null
            ? 'the resolved endpoint cannot be parsed; not a' +
                ' transport this client can express'
            : `resolved endpoint scheme ${pyStrRepr(scheme)} is not a` +
                ' transport this client can express',
        );
        return;
      }
    }
  } else {
    const command = serviceCommand(service, machine);
    if (missingExecutable(command, machine)) {
      dictSet(result, 'state', 'missing-executable');
      (dictGet(result, 'diagnostics') as string[]).push(
        `executable ${pyStrRepr((command as string[])[0])} does not` +
          ' resolve on this machine (machine descriptor); a' +
          ' prerequisite, not a configuration edit',
      );
      return;
    }
  }
  dictSet(result, 'state', 'proposed');
  (dictGet(result, 'limitations') as string[]).push(
    'no registration provides this service; an authorized edit in a' +
      ' later slice creates one',
  );
  if (dictGet(block, 'present') === false) {
    (dictGet(result, 'limitations') as string[]).push(
      `${dictGet(block, 'path')} is absent; the edit would also create the` +
        ' client file',
    );
  }
}

/**
 * Classify every declared service against each selected client.
 *
 * Returns a redacted report dict naming the environment, manifest state,
 * each client's inspected configuration, and one result per
 * (service, client) pair. Reads only; writes nothing.
 */
export function assess(
  root: string,
  options: {
    machine?: Dict;
    mapping?: unknown;
    clients?: readonly string[];
    environment?: string;
  } = {},
): Dict {
  const machine = isDict(options.machine)
    ? (dictCopy(options.machine) as Dict)
    : (new Map<string, unknown>() as Dict);
  const mapping = checkMapping(options.mapping ?? new Map<string, unknown>());
  const environment =
    options.environment ??
    (dictGetOr(machine, 'name', null) as string | null) ??
    'this machine';
  const parsed = new Map<string, ParsedClient>();
  for (const client of checkClients(options.clients ?? CLIENTS)) {
    parsed.set(client, parseClient(root, client));
  }
  const [manifestInfo, services] = manifestOf(root);
  const results: Dict[] = [];
  for (const service of services) {
    for (const [client, [block, entries, aux]] of parsed) {
      results.push(
        classify(
          service,
          client,
          block,
          entries,
          aux,
          machine,
          mapping,
          environment,
        ),
      );
    }
  }
  const clientsBlock = new Map<string, unknown>();
  for (const [client, [block]] of parsed) clientsBlock.set(client, block);
  return new Map<string, unknown>([
    ['environment', environment],
    ['manifest', manifestInfo],
    ['clients', clientsBlock],
    ['results', results],
    [
      'prerequisites',
      parsed.has('codex') ? [CODEX_TRUST_NOTE] : [],
    ],
  ]);
}

// --- Plan construction (issue #107, slice 2) ----------------------------------

export const PLAN_KIND = 'mcp-configure-plan';
export const PLAN_VERSION = 1;
export const PLAN_ACTIONS = [
  'add',
  'reuse',
  'approval-grant',
  'conflict-needs-resolution',
  'unsupported',
] as const;
export const RESOLUTION_KINDS = ['keep', 'reenable', 'replace', 'add'] as const;
const DESTINATION_PATHS = new Set([
  ...Object.values(CLIENT_PATHS),
  CLAUDE_SETTINGS,
]);
const MCP_ALLOW = 'mcp__';
// Source-entry fields each client consumes during translation; every other
// field on an owner-selected source is reported in `untranslated` (names
// only) rather than silently carried or guessed.
const SOURCE_HANDLED = new Map<string, Set<string>>([
  ['claude\x00remote', new Set(['type', 'url', 'headers'])],
  ['claude\x00stdio', new Set(['type', 'command', 'args', 'env'])],
  ['codex\x00remote', new Set(['url', 'bearer_token_env_var'])],
  ['codex\x00stdio', new Set(['command', 'args', 'env_vars'])],
  ['opencode\x00remote', new Set(['type', 'url', 'headers'])],
  ['opencode\x00stdio', new Set(['type', 'command', 'environment'])],
]);

function sourceHandled(client: string, transport: string): Set<string> {
  return SOURCE_HANDLED.get(`${client}\x00${transport}`) ?? new Set();
}

/** Normalize owner selections into service -> {"clients", "source"}. */
function selectionsOf(
  selections: unknown,
  clients: readonly string[],
): Map<string, { clients: string[]; source: Dict | null }> {
  let items: [unknown, unknown][];
  if (isDict(selections)) {
    items = dictItems(selections);
  } else if (
    Array.isArray(selections) ||
    selections instanceof Set
  ) {
    items = [...(selections as Iterable<unknown>)].map((service) => [
      service,
      null,
    ]);
  } else {
    throw new ValueError(
      'selections must be a sequence of service ids or a mapping of' +
        ' service id to selection options',
    );
  }
  const normalized = new Map<
    string,
    { clients: string[]; source: Dict | null }
  >();
  for (const [service, spec] of items) {
    if (typeof service !== 'string' || !service) {
      throw new ValueError(`invalid selected service ${pyRepr(service)}`);
    }
    const options: { clients: string[]; source: Dict | null } = {
      clients: [...clients],
      source: null,
    };
    if (Array.isArray(spec) || spec instanceof Set) {
      options.clients = [...(spec as Iterable<string>)];
    } else if (isDict(spec)) {
      if (dictGet(spec, 'clients') !== undefined && dictGet(spec, 'clients') !== null) {
        options.clients = [...(dictGet(spec, 'clients') as Iterable<string>)];
      }
      const source = dictGet(spec, 'source');
      if (source !== undefined && source !== null) {
        if (
          !isDict(source) ||
          !Object.hasOwn(CLIENT_PATHS, dictGet(source, 'client') as string) ||
          typeof dictGet(source, 'registration') !== 'string'
        ) {
          throw new ValueError(
            `selection for ${pyRepr(service)}: 'source' must be` +
              ' {client: <client>, registration: <name>}' +
              ''
          );
        }
        options.source = new Map<string, unknown>([
          ['client', dictGet(source, 'client')],
          ['registration', dictGet(source, 'registration')],
        ]);
      }
    } else if (!(spec === null || spec === undefined || pyEq(spec, true))) {
      throw new ValueError(
        `invalid selection options for ${pyRepr(service)}`,
      );
    }
    const unknown = options.clients.filter(
      (client) => !clients.includes(client),
    );
    if (unknown.length) {
      throw new ValueError(
        `selection for ${pyRepr(service)} names unselected client(s)` +
          ` ${unknown.join(', ')}`,
      );
    }
    normalized.set(service, options);
  }
  return normalized;
}

/** (private entry, diagnostics) for an owner-selected source. */
function sourceEntry(
  parsed: Map<string, ParsedClient>,
  source: Dict | null,
): [InspectEntry | null, string[]] {
  if (source === null) return [null, []];
  const client = dictGet(source, 'client') as string;
  const name = dictGet(source, 'registration') as string;
  if (!parsed.has(client)) {
    return [
      null,
      [
        `source client ${pyStrRepr(client)} was not selected for` +
          ' inspection',
      ],
    ];
  }
  const [block, entries] = parsed.get(client) as ParsedClient;
  const entry = entries.get(name);
  if (entry === undefined) {
    return [
      null,
      [
        `source registration ${pyStrRepr(name)} was not found in` +
          ` ${dictGet(block, 'path')}`,
      ],
    ];
  }
  if (entry.inspection !== 'ok' || entry.transport === null) {
    return [
      null,
      [
        `source registration ${pyStrRepr(name)} is not a usable` +
          ' remote/stdio registration',
      ],
    ];
  }
  return [entry, []];
}

/** Raw dict of the selected source entry for untranslated reporting. */
function rawSourceFields(root: string, source: Dict | null): Dict {
  if (source === null) return new Map<string, unknown>();
  const client = dictGet(source, 'client') as string;
  const registration = dictGet(source, 'registration') as string;
  const path = join(root, CLIENT_PATHS[client]);
  let raw: unknown;
  try {
    const text = readText(path);
    if (client === 'codex') {
      const servers = tomlLoads(text)['mcp_servers'];
      raw = isDict(servers) ? dictGetOr(servers, registration, null) : null;
    } else {
      let doc: unknown;
      try {
        doc = jsonLoads(text);
      } catch (error) {
        if ((error as Error)?.name !== 'ValueError') throw error;
        doc = parseJsonc(text);
      }
      if (client === 'claude') {
        const servers = isDict(doc) ? dictGetOr(doc, 'mcpServers', null) : null;
        raw = isDict(servers) ? dictGetOr(servers, registration, null) : null;
      } else {
        const mcp = isDict(doc) ? dictGetOr(doc, 'mcp', null) : null;
        const servers = isDict(mcp) ? dictGetOr(mcp, 'servers', null) : null;
        raw = isDict(servers) ? dictGetOr(servers, registration, null) : null;
        if (raw === null || raw === undefined) {
          raw = isDict(mcp) ? dictGetOr(mcp, registration, null) : null;
        }
      }
    }
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    return new Map<string, unknown>();
  }
  return isDict(raw) ? raw : new Map<string, unknown>();
}

/**
 * transport/endpoint/command the plan translates from.
 *
 * An owner-selected source entry defines the connection; otherwise the
 * manifest connection resolved through the machine descriptor does.
 */
function resolvedConnection(
  service: Dict,
  machine: Dict,
  entry: InspectEntry | null,
): Dict {
  if (
    entry !== null &&
    (entry.transport === 'remote' || entry.transport === 'stdio')
  ) {
    return new Map<string, unknown>([
      ['transport', entry.transport],
      ['endpoint', entry.url],
      ['command', entry.command],
    ]);
  }
  const connection = dictGetOr(service, 'connection', {}) ?? {};
  if (dictGet(connection as Dict, 'type') === 'remote') {
    return new Map<string, unknown>([
      ['transport', 'remote'],
      ['endpoint', serviceEndpoint(service, machine)],
      ['command', null],
    ]);
  }
  if (dictGet(connection as Dict, 'type') === 'stdio') {
    return new Map<string, unknown>([
      ['transport', 'stdio'],
      ['endpoint', null],
      ['command', serviceCommand(service, machine)],
    ]);
  }
  return new Map<string, unknown>([
    ['transport', null],
    ['endpoint', null],
    ['command', null],
  ]);
}

/** Whether an existing registration serves the resolved connection. */
function matchesConnection(entry: InspectEntry, resolved: Dict): boolean {
  const transport = dictGet(resolved, 'transport');
  if (entry.inspection !== 'ok' || transport === null) return false;
  if (transport === 'remote') {
    const endpoint = dictGet(resolved, 'endpoint');
    return (
      entry.transport === 'remote' &&
      endpoint !== null &&
      endpoint !== undefined &&
      equivalentUrl(entry.url, endpoint)
    );
  }
  const command = dictGet(resolved, 'command');
  return (
    entry.transport === 'stdio' &&
    command !== null &&
    command !== undefined &&
    sameCommand(entry.command, command as string[])
  );
}

// --- Credential-flag scan ------------------------------------------------------

const CREDENTIAL_FLAG =
  /token|key|secret|password|passwd|credential|auth|api/i;

/**
 * Python `re.IGNORECASE` folds four extra equivalences JavaScript's `i`
 * flag lacks — İ (U+0130) and ı (U+0131) for `i`, ſ (U+017F) for `s`,
 * K (U+212A) for `k`. Candidate flags are folded the same way before the
 * search so exotic spellings match identically.
 */
function credentialFlagSearch(flag: string): boolean {
  const folded = flag.replaceAll('İ', 'i').replaceAll('ı', 'i')
    .replaceAll('ſ', 's').replaceAll('K', 'k');
  return CREDENTIAL_FLAG.test(folded);
}

/** Refusal diagnostics for secret-bearing command arguments. */
function credentialArgs(command: string[], machine: Dict): string[] {
  // Diagnostics name the credential-looking flag, never the value that
  // follows it (or is joined by `=`); a bare token equal to a
  // caller-supplied `machine['secret_values']` entry is reported
  // without echoing it.
  const secrets = new Set(
    (dictGetOr(machine, 'secret_values', []) as Iterable<string>) ?? [],
  );
  const diagnostics: string[] = [];
  for (const [index, token] of command.entries()) {
    if (secrets.has(token)) {
      diagnostics.push(
        'a command argument matches a known secret value;' +
          ' reference a credential env-var name instead of a' +
          ' literal value',
      );
      continue;
    }
    if (index === 0) continue;
    const [flag, separator] = partition(token, '=');
    if (
      flag.startsWith('-') &&
      credentialFlagSearch(flag.replace(/^-+/, '')) &&
      (separator !== '' || index < command.length - 1)
    ) {
      diagnostics.push(
        `argument ${flag} looks credential-bearing; reference a` +
          ' credential env-var name instead of a literal value',
      );
    }
  }
  return diagnostics;
}

// --- Translation ----------------------------------------------------------------

const PY_WS =
  ' \\t\\n\\r\\f\\v\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';

/**
 * Env-var name of an exact 'Bearer <env-ref>' auth, else `null`.
 *
 * Only that exact reference translates: a Codex `bearer_token_env_var`
 * or an Authorization header whose whole value is the client-native
 * bearer env-var form. Any other Authorization scheme or form is left
 * for the caller to report rather than guess at.
 */
function bearerRef(source: Dict | null, sourceRaw: Dict): string | null {
  if (source === null) return null;
  const client = dictGet(source, 'client') as string;
  if (client === 'codex') {
    const name = dictGet(sourceRaw, 'bearer_token_env_var');
    return typeof name === 'string' && name ? name : null;
  }
  const headers = dictGet(sourceRaw, 'headers');
  if (!isDict(headers)) return null;
  const value = dictGet(headers, 'Authorization');
  if (typeof value !== 'string') return null;
  const tokenRef =
    client === 'opencode'
      ? '\\{env:([A-Za-z_][A-Za-z0-9_]*)\\}'
      : '\\$\\{([A-Za-z_][A-Za-z0-9_]*)\\}';
  const match = new RegExp(`^Bearer[${PY_WS}]+${tokenRef}$`).exec(
    value.trim(),
  );
  return match ? match[1] : null;
}

function remoteEntry(
  client: string,
  endpoint: string,
  credential: string | null,
): Dict {
  if (client === 'claude') {
    const entry = new Map<string, unknown>([
      ['type', 'http'],
      ['url', endpoint],
    ]);
    if (credential) {
      entry.set(
        'headers',
        new Map([['Authorization', `Bearer \${${credential}}`]]),
      );
    }
    return entry;
  }
  if (client === 'codex') {
    const entry = new Map<string, unknown>([['url', endpoint]]);
    if (credential) entry.set('bearer_token_env_var', credential);
    return entry;
  }
  const entry = new Map<string, unknown>([
    ['type', 'remote'],
    ['url', endpoint],
  ]);
  if (credential) {
    entry.set(
      'headers',
      new Map([['Authorization', `Bearer {env:${credential}}`]]),
    );
    // oauth: false pins the header-only path, as in memory_connections.
    entry.set('oauth', false);
  }
  return entry;
}

function stdioEntry(
  client: string,
  command: string[],
  credentials: string[],
): Dict {
  if (client === 'opencode') {
    const entry = new Map<string, unknown>([
      ['type', 'local'],
      ['command', [...command]],
    ]);
    if (credentials.length) {
      entry.set(
        'environment',
        new Map(credentials.map((name) => [name, `{env:${name}}`])),
      );
    }
    return entry;
  }
  const entry = new Map<string, unknown>([['command', command[0]]]);
  if (command.length > 1) entry.set('args', command.slice(1));
  if (!credentials.length) return entry;
  if (client === 'claude') {
    entry.set(
      'env',
      new Map(credentials.map((name) => [name, `\${${name}}`])),
    );
  } else {
    entry.set('env_vars', [...credentials]);
  }
  return entry;
}

/**
 * (entry, diagnostics, untranslated, prerequisites); entry may be null.
 *
 * The translated entry carries endpoint/command data plus credential
 * environment-variable NAMES rendered as client reference syntax. Literal
 * values are never copied: source fields that cannot translate are
 * reported by name in `untranslated`.
 */
function translate(
  service: Dict,
  client: string,
  machine: Dict,
  entry: InspectEntry | null,
  resolved: Dict,
  sourceRaw: Dict,
  source: Dict | null,
): [Dict | null, string[], string[], string[]] {
  const diagnostics: string[] = [];
  const untranslated: string[] = [];
  const prerequisites: string[] = [];
  const connection = dictGetOr(service, 'connection', {}) ?? {};
  const auth = dictGetOr(connection as Dict, 'auth', {}) ?? {};
  const declared = new Set(
    (dictGetOr(service, 'credential_refs', []) as Iterable<string>) ?? [],
  );
  let credential: string | null = null;
  if (
    isDict(auth) &&
    dictGet(auth, 'mechanism') === 'api-key' &&
    typeof dictGet(auth, 'credential_ref') === 'string'
  ) {
    credential = dictGet(auth, 'credential_ref') as string;
    declared.add(credential);
  }
  if (entry !== null) {
    for (const name of [
      ...entry.env_names,
      ...entry.env_refs,
      ...entry.credential_names,
    ]) {
      declared.add(name);
    }
    const handled = sourceHandled(
      dictGet(source as Dict, 'client') as string,
      entry.transport as string,
    );
    for (const key of pySortedStrings(
      dictKeys(sourceRaw).filter((key) => !handled.has(key)),
    )) {
      untranslated.push(
        `field ${pyStrRepr(key)} of the selected source registration`,
      );
    }
    for (const header of pySortedStrings(
      [...entry.header_names].filter((header) => header !== 'Authorization'),
    )) {
      untranslated.push(
        `header ${pyStrRepr(header)} of the selected source registration`,
      );
    }
    if (entry.inline_secrets) {
      untranslated.push(
        `${entry.inline_secrets} literal value(s) in the` +
          ' selected source registration (re-declare credential' +
          ' names instead of copying values)',
      );
    }
    const bearer = bearerRef(source, sourceRaw);
    if (bearer !== null && credential === null) credential = bearer;
    if (
      entry.header_names.has('Authorization') &&
      (bearer === null || bearer !== credential)
    ) {
      untranslated.push(
        "header 'Authorization' of the selected source" +
          ' registration',
      );
      diagnostics.push(
        "the selected source's Authorization header is not an" +
          " exact 'Bearer <env-var>' reference matching the" +
          ' translated credential; it was not carried over — wire' +
          ' it manually if needed',
      );
    }
    if (dictGet(sourceRaw, 'oauth') === true) {
      prerequisites.push(
        'the selected source uses OAuth; the flow is interactive —' +
          ' complete it in the client after registration',
      );
    }
    const sourceType = dictGet(sourceRaw, 'type');
    const sourceTypeText = pyTruthy(sourceType)
      ? String(sourceType)
      : '';
    if (sourceTypeText.toLowerCase() === 'sse') {
      diagnostics.push(
        `source transport sse cannot be expressed for ${client};` +
          ' configure it manually or use a supported transport',
      );
      return [null, diagnostics, untranslated, prerequisites];
    }
  }
  if (dictGet(resolved, 'transport') === null) {
    diagnostics.push(
      'the service declares no connection and no usable source' +
        ' registration was selected; nothing to translate',
    );
    return [null, diagnostics, untranslated, prerequisites];
  }
  if (isDict(auth) && dictGet(auth, 'mechanism') === 'oauth') {
    prerequisites.push(
      'the service declares OAuth; the flow is interactive —' +
        ' complete it in the client after registration (no token is' +
        ' handled or copied)',
    );
    credential = null;
  }
  if (dictGet(resolved, 'transport') === 'remote') {
    const endpoint = dictGet(resolved, 'endpoint');
    if (typeof endpoint !== 'string' || !endpoint) {
      diagnostics.push(
        'the connection endpoint does not resolve from the' +
          ' manifest, the machine descriptor or the selected source',
      );
      return [null, diagnostics, untranslated, prerequisites];
    }
    let scheme: string;
    try {
      scheme = pyUrlsplit(endpoint).scheme;
    } catch (error) {
      if ((error as Error)?.name !== 'ValueError') throw error;
      diagnostics.push(
        'the connection endpoint cannot be parsed; not a' +
          ` transport ${client} can express`,
      );
      return [null, diagnostics, untranslated, prerequisites];
    }
    if (scheme !== 'http' && scheme !== 'https') {
      diagnostics.push(
        `endpoint scheme ${pyStrRepr(scheme)} is not a transport` +
          ` ${client} can express`,
      );
      return [null, diagnostics, untranslated, prerequisites];
    }
    const translated = remoteEntry(client, endpoint, credential);
    for (const name of pySortedStrings(
      [...declared].filter((name) => name !== credential),
    )) {
      untranslated.push(
        `credential name ${pyStrRepr(name)} has no field in a remote` +
          ` ${client} entry; wire it manually if needed`,
      );
    }
    return [translated, diagnostics, untranslated, prerequisites];
  }
  const command = dictGet(resolved, 'command') as string[] | null;
  if (!command || !command.length) {
    diagnostics.push(
      'the stdio command does not resolve from the manifest\'s' +
        ' command_ref, the machine descriptor or the selected source',
    );
    return [null, diagnostics, untranslated, prerequisites];
  }
  const refusals = credentialArgs(command, machine);
  if (refusals.length) {
    diagnostics.push(...refusals);
    return [null, diagnostics, untranslated, prerequisites];
  }
  const translated = stdioEntry(client, command, pySortedStrings(declared));
  if (missingExecutable(command, machine)) {
    prerequisites.push(
      `executable ${pyStrRepr(command[0])} does not resolve on this` +
        ' machine (machine descriptor); install it before relying on' +
        ' the registration',
    );
  }
  if (dictHas(machine, 'env')) {
    const env = new Set(
      (dictGetOr(machine, 'env', []) as Iterable<string>) ?? [],
    );
    for (const name of pySortedStrings(
      [...declared].filter((name) => !env.has(name)),
    )) {
      prerequisites.push(
        `environment variable ${name} is not present on this` +
          ' machine (machine descriptor)',
      );
    }
  }
  return [translated, diagnostics, untranslated, prerequisites];
}

function entryPrerequisites(
  service: Dict,
  entry: InspectEntry,
  machine: Dict,
): string[] {
  const prerequisites: string[] = [];
  if (
    entry.transport === 'stdio' &&
    missingExecutable(entry.command, machine)
  ) {
    prerequisites.push(
      `executable ${pyStrRepr((entry.command as string[])[0])} does not` +
        ' resolve on this machine (machine descriptor)',
    );
  }
  const [declared] = authMaterial(entry, service);
  if (dictHas(machine, 'env')) {
    const env = new Set(
      (dictGetOr(machine, 'env', []) as Iterable<string>) ?? [],
    );
    for (const name of pySortedStrings(
      [...declared].filter((name) => !env.has(name)),
    )) {
      prerequisites.push(
        `environment variable ${name} is not present on this` +
          ' machine (machine descriptor)',
      );
    }
  }
  const connection = dictGetOr(service, 'connection', {}) ?? {};
  const auth = dictGetOr(connection as Dict, 'auth', {}) ?? {};
  if (isDict(auth) && dictGet(auth, 'mechanism') === 'oauth') {
    prerequisites.push(
      'the service declares OAuth; the flow is interactive — verify' +
        ' the session in the client (no token is handled or copied)',
    );
  }
  if (declared.size) {
    prerequisites.push(
      'static inspection cannot verify login or read access; live' +
        ' verification is a separate authorized action',
    );
  }
  return prerequisites;
}

function fillTranslation(
  action: Dict,
  service: Dict,
  client: string,
  machine: Dict,
  entry: InspectEntry | null,
  resolved: Dict,
  sourceRaw: Dict,
  source: Dict | null,
): void {
  const [translated, diagnostics, untranslated, prerequisites] = translate(
    service,
    client,
    machine,
    entry,
    resolved,
    sourceRaw,
    source,
  );
  dictSet(action, 'entry', translated);
  (dictGet(action, 'diagnostics') as string[]).push(...diagnostics);
  if (translated !== null && untranslated.length) {
    (dictGet(action, 'diagnostics') as string[]).push(
      `${untranslated.length} item(s) could not be translated; they` +
        " are listed under 'untranslated', not dropped",
    );
  }
  dictSet(action, 'untranslated', untranslated);
  (dictGet(action, 'prerequisites') as string[]).push(...prerequisites);
}

/** One planned action for a selected (service, client) pair. */
function planAction(
  service: Dict,
  client: string,
  block: Dict,
  entries: Map<string, InspectEntry>,
  aux: OpencodeAux,
  machine: Dict,
  mapping: Dict,
  entry: InspectEntry | null,
  resolved: Dict,
  sourceDiags: string[],
  sourceRaw: Dict,
  source: Dict | null,
): Dict {
  const perService = dictGetOr(mapping, dictGet(service, 'id') as string, null);
  const mapped = isDict(perService) ? dictGetOr(perService, client, null) : null;
  const name = (mapped ?? dictGet(service, 'id')) as string;
  const action: Dict = new Map<string, unknown>([
    ['service', dictGet(service, 'id')],
    ['client', client],
    ['registration', name],
    ['action', null],
    ['file', CLIENT_PATHS[client]],
    ['entry', null],
    ['approvals', [] as string[]],
    ['untranslated', [] as string[]],
    ['diagnostics', [] as string[]],
    ['prerequisites', [] as string[]],
    ['resolution', null],
    ['applied', false],
  ]);
  if (client === 'codex') {
    (dictGet(action, 'prerequisites') as string[]).push(CODEX_TRUST_NOTE);
  }
  const problem = registrationNameProblem(name);
  if (problem !== null) {
    dictSet(action, 'action', 'unsupported');
    (dictGet(action, 'diagnostics') as string[]).push(
      `registration name ${pyStrRepr(name)} is not supported; ${problem}`,
    );
    return action;
  }
  if (
    dictGet(block, 'present') === true &&
    dictGet(block, 'readable') === false
  ) {
    dictSet(action, 'action', 'unsupported');
    (dictGet(action, 'diagnostics') as string[]).push(
      ...(dictGet(block, 'diagnostics') as string[]),
    );
    return action;
  }
  (dictGet(action, 'diagnostics') as string[]).push(...sourceDiags);
  let allow: Dict = new Map<string, unknown>();
  let disabled = new Set<string>();
  if (client === 'claude') {
    const approvals = dictGetOr(block, 'approvals', null);
    if (isDict(approvals)) {
      const allowValue = dictGetOr(approvals, 'allow', null);
      if (isDict(allowValue)) allow = allowValue;
      const disabledValue = dictGetOr(approvals, 'disabled', []);
      disabled = new Set(
        (disabledValue as Iterable<string>) ?? [],
      );
    }
  }
  const shadowed = aux.shadowed ?? new Set<string>();
  const existing = entries.get(name);
  if (existing !== undefined || shadowed.has(name)) {
    const conflicts: string[] = [];
    if (shadowed.has(name)) {
      conflicts.push(
        `registration ${pyStrRepr(name)} is defined under both 'mcp'` +
          " and 'mcp.servers'; the shadowing needs explicit resolution",
      );
    } else if ((existing as InspectEntry).inspection === 'unknown') {
      conflicts.push(
        `registration is unrecognized: ${(existing as InspectEntry).notes.join('; ')}`,
      );
    } else if ((existing as InspectEntry).inspection === 'unsupported') {
      conflicts.push(
        'registration uses transport or syntax the' +
          ` client cannot express: ${(existing as InspectEntry).notes.join('; ')}`,
      );
    } else {
      const inspect = existing as InspectEntry;
      if (inspect.enabled === false) {
        conflicts.push(
          `registration ${pyStrRepr(name)} is explicitly disabled`,
        );
      }
      if (client === 'claude' && disabled.has(name)) {
        conflicts.push(
          `${CLAUDE_SETTINGS} records ${pyStrRepr(name)} in` +
            ' disabledMcpjsonServers',
        );
      }
      if (dictGet(resolved, 'transport') !== null) {
        if (
          dictGet(resolved, 'endpoint') === null &&
          dictGet(resolved, 'command') === null
        ) {
          conflicts.push(
            'the service connection does not resolve in the' +
              ' machine descriptor; the existing registration' +
              ' cannot be verified against it',
          );
        } else if (inspect.transport !== dictGet(resolved, 'transport')) {
          conflicts.push(
            `registration ${pyStrRepr(name)} is a ${inspect.transport}` +
              ` entry; the service declares a` +
              ` ${dictGet(resolved, 'transport')} connection`,
          );
        } else if (!matchesConnection(inspect, resolved)) {
          conflicts.push(
            `registration ${pyStrRepr(name)} points at a different` +
              ' endpoint or command than the service declares',
          );
        }
      }
      const [declared, carried] = authMaterial(inspect, service);
      const missing = [...declared].filter((item) => !carried.has(item));
      if (missing.length) {
        conflicts.push(
          'auth mismatch: the entry does not reference declared' +
            ` credential name(s) ${pySortedStrings(missing).join(', ')}`,
        );
      }
    }
    if (conflicts.length) {
      dictSet(action, 'action', 'conflict-needs-resolution');
      (dictGet(action, 'diagnostics') as string[]).push(...conflicts);
      fillTranslation(
        action,
        service,
        client,
        machine,
        entry,
        resolved,
        sourceRaw,
        source,
      );
      if (client === 'claude' && !dictHas(allow, name)) {
        dictSet(action, 'approvals', [`${MCP_ALLOW}${name}`]);
      }
    } else {
      dictSet(action, 'action', 'reuse');
      (dictGet(action, 'diagnostics') as string[]).push(
        `existing registration ${pyStrRepr(name)} satisfies the service;` +
          ' left untouched',
      );
      (dictGet(action, 'prerequisites') as string[]).push(
        ...entryPrerequisites(service, existing as InspectEntry, machine),
      );
      if (client === 'claude' && !dictHas(allow, name)) {
        dictSet(action, 'action', 'approval-grant');
        dictSet(action, 'approvals', [`${MCP_ALLOW}${name}`]);
        (dictGet(action, 'diagnostics') as string[]).push(
          `only the ${CLAUDE_SETTINGS} approval is missing`,
        );
      }
    }
    return action;
  }
  if (client === 'claude' && disabled.has(name)) {
    dictSet(action, 'action', 'conflict-needs-resolution');
    (dictGet(action, 'diagnostics') as string[]).push(
      `${CLAUDE_SETTINGS} records ${pyStrRepr(name)} in` +
        ' disabledMcpjsonServers; adding the entry would leave it' +
        ' rejected — explicit resolution required',
    );
    fillTranslation(
      action,
      service,
      client,
      machine,
      entry,
      resolved,
      sourceRaw,
      source,
    );
  } else {
    const equivalents = pySortedStrings(
      [...entries.entries()]
        .filter(([, inspect]) => matchesConnection(inspect, resolved))
        .map(([candidate]) => candidate),
    );
    if (equivalents.length) {
      dictSet(action, 'action', 'conflict-needs-resolution');
      (dictGet(action, 'diagnostics') as string[]).push(
        `registration(s) ${equivalents.join(', ')} already satisfy` +
          ` this service; adding ${pyStrRepr(name)} would create a` +
          ' duplicate registration — explicit resolution required',
      );
      fillTranslation(
        action,
        service,
        client,
        machine,
        entry,
        resolved,
        sourceRaw,
        source,
      );
    } else {
      fillTranslation(
        action,
        service,
        client,
        machine,
        entry,
        resolved,
        sourceRaw,
        source,
      );
      if (dictGet(action, 'entry') === null) {
        dictSet(action, 'action', 'unsupported');
      } else {
        dictSet(action, 'action', 'add');
      }
    }
  }
  if (
    client === 'claude' &&
    !dictHas(allow, name) &&
    dictGet(action, 'action') !== 'unsupported'
  ) {
    dictSet(action, 'approvals', [`${MCP_ALLOW}${name}`]);
  }
  return action;
}

/** Destination files the action may write under any resolution. */
function actionFiles(action: Dict): string[] {
  // Python returns a `set` here, so `plan["files"]` order follows CPython
  // hash order — nondeterministic across hash seeds. Every set this
  // function produces has at most two elements, and always the same
  // pair, so the order is stable under the harness's pinned
  // PYTHONHASHSEED=0: '.claude/settings.local.json' sorts into the
  // lower hash slot than '.mcp.json', so Claude's two-file set yields
  // settings first. Emitting that seeded order keeps plan bytes
  // identical to Python's rather than collapsing to insertion order.
  const files: string[] = [];
  const kind = dictGet(action, 'action');
  const claude =
    dictGet(action, 'client') === 'claude' &&
    (kind === 'add' ||
      kind === 'approval-grant' ||
      kind === 'conflict-needs-resolution');
  if (claude) files.push(CLAUDE_SETTINGS);
  if (kind === 'add' || kind === 'conflict-needs-resolution') {
    files.push(dictGet(action, 'file') as string);
  }
  return files;
}

function fileDigest(root: string, rel: string): Dict {
  const path = join(root, rel);
  if (!isFile(path)) {
    return new Map<string, unknown>([
      ['digest', null],
      ['present', false],
    ]);
  }
  return new Map<string, unknown>([
    [
      'digest',
      `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
    ],
    ['present', true],
  ]);
}

/** Two selected services claiming one (client, name) is a conflict. */
function flagDuplicateRegistrations(plan: Dict): void {
  const seen = new Map<string, Dict>();
  for (const action of dictGet(plan, 'actions') as Dict[]) {
    const key = `${dictGet(action, 'client')} ${dictGet(action, 'registration')}`;
    const other = seen.get(key);
    if (other === undefined) {
      seen.set(key, action);
      continue;
    }
    for (const candidate of [other, action]) {
      dictSet(candidate, 'action', 'conflict-needs-resolution');
      (dictGet(candidate, 'diagnostics') as string[]).push(
        `registration ${pyStrRepr(dictGet(action, 'registration') as string)}` +
          ' is claimed by both selected' +
          ` services ${pyStrRepr(dictGet(other, 'service') as string)} and` +
          ` ${pyStrRepr(dictGet(action, 'service') as string)}; record an` +
          ' explicit resolution',
      );
    }
  }
}

/**
 * Redacted, data-only plan for aligning the selected services.
 *
 * `selections` names the services the owner chose to configure: a
 * sequence of service ids, or a mapping `service_id -> spec` where the
 * spec may list `clients` and one `source`
 * (`{"client": ..., "registration": ...}`) selecting an existing
 * registration as the connection definition. The destination registration
 * name is the confirmed `mapping` name, falling back to the service id.
 *
 * The caller reviews the plan, records a `resolution`
 * (`{"kind": "keep"|"reenable"|"replace"|"add"}`) on every action marked
 * `conflict-needs-resolution`, and sets `plan["confirmed"] = true`
 * after owner go-ahead. Only then will `apply` write. Reads only; writes
 * nothing.
 */
export function buildPlan(
  root: string,
  mapping: unknown,
  selections: unknown,
  options: { machine?: Dict; clients?: readonly string[] } = {},
): Dict {
  const resolvedRoot = resolvePath(root);
  const machine = isDict(options.machine)
    ? (dictCopy(options.machine) as Dict)
    : (new Map<string, unknown>() as Dict);
  const checkedMapping = checkMapping(mapping ?? new Map<string, unknown>());
  const clients = checkClients(options.clients ?? CLIENTS);
  const selected = selectionsOf(selections, clients);
  const parsed = new Map<string, ParsedClient>();
  for (const client of clients) {
    parsed.set(client, parseClient(resolvedRoot, client));
  }
  const [manifestInfo, services] = manifestOf(resolvedRoot);
  const byId = new Map<string, Dict>();
  for (const service of services) {
    byId.set(dictGet(service, 'id') as string, service);
  }
  const plan: Dict = new Map<string, unknown>([
    ['kind', PLAN_KIND],
    ['version', PLAN_VERSION],
    ['root', resolvedRoot],
    ['environment', dictGetOr(machine, 'name', null) ?? 'this machine'],
    ['confirmed', false],
    ['selections', pySortedStrings(selected.keys())],
    ['clients', [...clients]],
    ['manifest', manifestInfo],
    ['files', new Map<string, unknown>()],
    ['actions', [] as Dict[]],
    ['diagnostics', [] as string[]],
    ['prerequisites', clients.includes('codex') ? [CODEX_TRUST_NOTE] : []],
  ]);
  if (dictGet(manifestInfo, 'present') !== true) {
    (dictGet(plan, 'diagnostics') as string[]).push(
      'no readable .agents/mcp-requirements.json; selections cannot be' +
        ' planned without a manifest',
    );
    return plan;
  }
  for (const sid of pySortedStrings(selected.keys())) {
    const service = byId.get(sid);
    if (service === undefined) {
      (dictGet(plan, 'diagnostics') as string[]).push(
        `selected service ${pyStrRepr(sid)} is not declared in` +
          ' .agents/mcp-requirements.json; nothing planned for it',
      );
      continue;
    }
    const spec = selected.get(sid) as {
      clients: string[];
      source: Dict | null;
    };
    const [entry, sourceDiags] = sourceEntry(parsed, spec.source);
    const sourceRaw = rawSourceFields(resolvedRoot, spec.source);
    const resolved = resolvedConnection(service, machine, entry);
    for (const client of spec.clients) {
      const [block, entries, aux] = parsed.get(client) as ParsedClient;
      const action = planAction(
        service,
        client,
        block,
        entries,
        aux,
        machine,
        checkedMapping,
        entry,
        resolved,
        sourceDiags,
        sourceRaw,
        spec.source,
      );
      (dictGet(plan, 'actions') as Dict[]).push(action);
      const files = dictGet(plan, 'files') as Map<string, unknown>;
      for (const rel of actionFiles(action)) {
        if (!files.has(rel)) files.set(rel, fileDigest(resolvedRoot, rel));
      }
    }
  }
  flagDuplicateRegistrations(plan);
  return plan;
}

// --- Apply --------------------------------------------------------------------

function malformed(why: string): ValueError {
  return new ValueError(
    `malformed plan: ${why}; refusing — no files` + ' written',
  );
}

function validatePlan(plan: unknown): void {
  if (
    !isDict(plan) ||
    dictGet(plan, 'kind') !== PLAN_KIND ||
    !pyEq(dictGet(plan, 'version'), PLAN_VERSION)
  ) {
    throw malformed('expected a mcp-configure-plan v1 document');
  }
  const planDict = plan;
  if (
    typeof dictGet(planDict, 'root') !== 'string' ||
    !(dictGet(planDict, 'root') as string)
  ) {
    throw malformed('missing root');
  }
  if (typeof dictGet(planDict, 'confirmed') !== 'boolean') {
    throw malformed("'confirmed' must be a boolean");
  }
  const files = dictGet(planDict, 'files');
  if (!isDict(files)) {
    throw malformed("'files' must be a mapping");
  }
  for (const [rel, meta] of dictItems(files)) {
    if (
      !DESTINATION_PATHS.has(rel) ||
      !isDict(meta) ||
      !(
        dictKeys(meta).length === 2 &&
        dictHas(meta, 'digest') &&
        dictHas(meta, 'present')
      ) ||
      typeof dictGet(meta, 'present') !== 'boolean' ||
      !(
        dictGet(meta, 'digest') === null ||
        dictGet(meta, 'digest') === undefined ||
        typeof dictGet(meta, 'digest') === 'string'
      )
    ) {
      throw malformed(`bad digest record for ${pyStrRepr(rel)}`);
    }
  }
  const actions = dictGet(planDict, 'actions');
  if (!Array.isArray(actions)) {
    throw malformed("'actions' must be a list");
  }
  for (const action of actions) {
    const approvals = isDict(action) ? dictGet(action, 'approvals') : null;
    const resolution = isDict(action) ? dictGet(action, 'resolution') : null;
    if (
      !isDict(action) ||
      !(PLAN_ACTIONS as readonly unknown[]).includes(dictGet(action, 'action')) ||
      !Object.hasOwn(CLIENT_PATHS, dictGet(action, 'client') as string) ||
      !DESTINATION_PATHS.has(dictGet(action, 'file') as string) ||
      typeof dictGet(action, 'service') !== 'string' ||
      typeof dictGet(action, 'registration') !== 'string' ||
      !(
        dictGet(action, 'entry') === null ||
        dictGet(action, 'entry') === undefined ||
        isDict(dictGet(action, 'entry'))
      ) ||
      !Array.isArray(approvals) ||
      approvals.some(
        (item) => typeof item !== 'string' || !item.startsWith(MCP_ALLOW),
      ) ||
      !(
        resolution === null ||
        resolution === undefined ||
        isDict(resolution)
      )
    ) {
      throw malformed(
        `bad action record for ${pyRepr(dictGet(action as Dict, 'service'))}` +
          ` on ${pyRepr(dictGet(action as Dict, 'client'))}`,
      );
    }
    const nameProblem = registrationNameProblem(
      dictGet(action, 'registration'),
    );
    if (nameProblem !== null) {
      throw malformed(
        `registration name ${pyStrRepr(dictGet(action, 'registration') as string)}` +
          ` is not supported; ${nameProblem}`,
      );
    }
    for (const item of approvals as string[]) {
      if (item !== `${MCP_ALLOW}${dictGet(action, 'registration')}`) {
        throw malformed(
          `approval ${pyStrRepr(item)} must be exactly` +
            ` ${pyStrRepr(`${MCP_ALLOW}${dictGet(action, 'registration')}`)}` +
            ' — approval' +
            " grants are scoped to the action's selected" +
            ' registration, never wildcards or other names',
        );
      }
    }
    if (
      (dictGet(action, 'action') === 'add' ||
        dictGet(action, 'action') === 'conflict-needs-resolution') &&
      !dictHas(files, dictGet(action, 'file') as string)
    ) {
      throw malformed(
        `no destination digest recorded for ${pyStrRepr(dictGet(action, 'file') as string)}`,
      );
    }
    if (
      dictGet(action, 'client') === 'claude' &&
      (((approvals as string[]).length !== 0) ||
        dictGet(action, 'action') === 'add' ||
        dictGet(action, 'action') === 'approval-grant' ||
        dictGet(action, 'action') === 'conflict-needs-resolution') &&
      !dictHas(files, CLAUDE_SETTINGS)
    ) {
      throw malformed(
        `no destination digest recorded for ${pyStrRepr(CLAUDE_SETTINGS)}`,
      );
    }
  }
}

function effectiveKind(action: Dict): string {
  const kind = dictGet(action, 'action');
  if (kind === 'add') return 'add';
  if (kind === 'approval-grant') return 'approval';
  if (kind === 'conflict-needs-resolution') {
    const resolution = dictGetOr(action, 'resolution', null);
    return isDict(resolution)
      ? (dictGetOr(resolution, 'kind', 'keep') as string)
      : 'keep';
  }
  return 'skip';
}

interface JsonSlot {
  before: Dict;
  doc: Dict;
  touched: boolean;
  expect: Dict;
  expect_direct: Dict;
  deleted: Set<string>;
  allow_added: string[];
  disabled_removed: Set<string>;
}

interface TomlSlot {
  text: string;
  before: Dict;
  touched: boolean;
  expect: Dict;
}

interface ApplyState {
  json: Map<string, JsonSlot>;
  toml: Map<string, TomlSlot>;
}

function jsonSlot(
  state: ApplyState,
  current: Map<string, string | null>,
  rel: string,
): JsonSlot {
  if (!state.json.has(rel)) {
    const text = current.get(rel) ?? null;
    const before = text === null ? new Map<string, unknown>() : strictDoc(text, rel);
    state.json.set(rel, {
      before,
      doc: pyDeepCopy(before) as Dict,
      touched: false,
      expect: new Map<string, unknown>(),
      expect_direct: new Map<string, unknown>(),
      deleted: new Set<string>(),
      allow_added: [],
      disabled_removed: new Set<string>(),
    });
  }
  return state.json.get(rel) as JsonSlot;
}

function strictDoc(text: string, rel: string): Dict {
  let doc: unknown;
  try {
    doc = jsonLoads(text);
  } catch (error) {
    if ((error as Error)?.name !== 'ValueError') throw error;
    let hint = '';
    try {
      parseJsonc(text);
      hint =
        ' it uses JSONC syntax the helper cannot rewrite' + ' safely;';
    } catch (inner) {
      if ((inner as Error)?.name !== 'ValueError') throw inner;
    }
    throw new ValueError(
      `unparseable ${rel}: ${errorText(error)};${hint} unsafe to edit — no` +
        ' files written',
    );
  }
  if (!isDict(doc)) {
    throw new ValueError(
      `${rel} is not a JSON object; unsafe to edit — no files` +
        ' written',
    );
  }
  return doc;
}

function tomlSlot(
  state: ApplyState,
  current: Map<string, string | null>,
  rel: string,
): TomlSlot {
  if (!state.toml.has(rel)) {
    const text = current.get(rel) ?? '';
    let before: Dict;
    try {
      before = pyStrip(text) ? tomlLoads(text) : new Map<string, unknown>();
    } catch (error) {
      if ((error as Error)?.name !== 'ValueError') throw error;
      throw new ValueError(
        `unparseable ${rel}: ${errorText(error)}; unsafe to edit — no` +
          ' files written',
      );
    }
    if (!isDict(before)) {
      throw new ValueError(
        `${rel} is not a TOML table; unsafe to edit — no files` +
          ' written',
      );
    }
    state.toml.set(rel, {
      text,
      before,
      touched: false,
      expect: new Map<string, unknown>(),
    });
  }
  return state.toml.get(rel) as TomlSlot;
}

function tableOf(doc: Dict, key: string, rel: string): Dict {
  let node = dictGetOr(doc, key, undefined);
  if (node === undefined || node === null) {
    node = new Map<string, unknown>();
    dictSet(doc, key, node);
  }
  if (!isDict(node)) {
    throw new ValueError(
      `${rel}: ${pyStrRepr(key)} is not an object; unsafe to edit — no` +
        ' files written',
    );
  }
  return node;
}

function putEntry(
  state: ApplyState,
  current: Map<string, string | null>,
  action: Dict,
  replace: boolean,
): void {
  const entry = dictGet(action, 'entry');
  if (!isDict(entry)) {
    throw new ValueError(
      `malformed plan: the ${dictGet(action, 'action')} action for` +
        ` ${pyStrRepr(dictGet(action, 'service') as string)} on` +
        ` ${dictGet(action, 'client')} carries no` +
        ' translated entry; refusing — no files written',
    );
  }
  if (dictGet(action, 'client') === 'codex') {
    putEntryToml(
      state,
      current,
      dictGet(action, 'file') as string,
      dictGet(action, 'registration') as string,
      entry,
      replace,
    );
  } else {
    putEntryJson(
      state,
      current,
      dictGet(action, 'file') as string,
      dictGet(action, 'client') as string,
      dictGet(action, 'registration') as string,
      entry,
      replace,
    );
  }
}

function putEntryJson(
  state: ApplyState,
  current: Map<string, string | null>,
  rel: string,
  client: string,
  name: string,
  entry: Dict,
  replace: boolean,
): void {
  const slot = jsonSlot(state, current, rel);
  const doc = slot.doc;
  let servers: Dict;
  if (client === 'claude') {
    servers = tableOf(doc, 'mcpServers', rel);
  } else {
    const mcp = tableOf(doc, 'mcp', rel);
    servers = tableOf(mcp, 'servers', rel);
    if (replace && isDict(dictGetOr(mcp, name, null))) {
      // A 'replace' resolution consolidates a conflicting legacy
      // mcp.<name> layer into the canonical mcp.servers entry.
      dictDel(mcp, name);
      slot.deleted.add(name);
      slot.touched = true;
    }
  }
  const existing = dictGetOr(servers, name, null);
  if (existing !== null && existing !== undefined && pyEq(existing, entry)) {
    return;
  }
  if (existing !== null && existing !== undefined && !replace) {
    throw new ValueError(
      `${rel}: registration ${pyStrRepr(name)} already exists and the plan` +
        " records no 'replace' resolution; refusing — no files" +
        ' written',
    );
  }
  dictSet(servers, name, entry);
  dictSet(slot.expect, name, entry);
  slot.touched = true;
}

function tomlServers(doc: Dict, rel: string): Dict {
  const servers = dictGetOr(doc, 'mcp_servers', null) ?? {};
  if (!isDict(servers)) {
    throw new ValueError(
      `${rel}: 'mcp_servers' is not a table; unsafe to edit — no` +
        ' files written',
    );
  }
  return servers;
}

/** (header_idx, end_idx) of [mcp_servers.name] and its subtables. */
function tomlSpan(lines: string[], name: string): [number, number] | null {
  // Returns null when the table's own header is absent, duplicated or
  // not contiguous with its subtables — the conditions under which a
  // targeted text replacement is unsafe.
  let own: number | null = null;
  const members: number[] = [];
  let end = lines.length;
  for (const [index, line] of lines.entries()) {
    const parsed = tomlKeyPath(line);
    if (parsed === null) continue;
    const [path] = parsed;
    if (path[0] === 'mcp_servers' && path[1] === name && path.length >= 2) {
      members.push(index);
      if (path.length === 2) {
        if (own !== null) return null;
        own = index;
      }
    }
  }
  if (own === null || members[0] !== own) return null;
  for (let index = own + 1; index < lines.length; index += 1) {
    const parsed = tomlKeyPath(lines[index]);
    if (
      parsed !== null &&
      !(parsed[0][0] === 'mcp_servers' && parsed[0][1] === name && parsed[0].length >= 2)
    ) {
      end = index;
      break;
    }
  }
  if (members.some((member) => member >= end)) return null;
  return [own, end];
}

function putEntryToml(
  state: ApplyState,
  current: Map<string, string | null>,
  rel: string,
  name: string,
  entry: Dict,
  replace: boolean,
): void {
  const slot = tomlSlot(state, current, rel);
  const existing = dictGetOr(
    tomlServers(slot.before, rel),
    name,
    null,
  );
  if (existing !== null && existing !== undefined && pyEq(existing, entry)) {
    return;
  }
  if (existing !== null && existing !== undefined && !replace) {
    throw new ValueError(
      `${rel}: mcp_servers.${name} already exists and the plan` +
        " records no 'replace' resolution; refusing — no files" +
        ' written',
    );
  }
  const block = codexBlock(name, entry);
  if (existing === null || existing === undefined) {
    const text = slot.text;
    slot.text =
      text + (!text || text.endsWith('\n') ? '' : '\n') + block;
  } else {
    const lines = splitlinesKeepends(slot.text);
    const span = tomlSpan(lines, name);
    if (span === null) {
      throw new ValueError(
        `${rel}: cannot locate a contiguous` +
          ` [mcp_servers.${name}] table to replace safely; edit it` +
          ' manually — no files written',
      );
    }
    slot.text =
      lines.slice(0, span[0]).join('') +
      block +
      lines.slice(span[1]).join('');
  }
  dictSet(slot.expect, name, entry);
  slot.touched = true;
}

/** Drop one name from Claude's disabledMcpjsonServers, if listed. */
function clearDisabled(
  state: ApplyState,
  current: Map<string, string | null>,
  name: string,
): void {
  const slot = jsonSlot(state, current, CLAUDE_SETTINGS);
  const disabled = dictGetOr(slot.doc, 'disabledMcpjsonServers', null);
  if (disabled === null || disabled === undefined) return;
  if (!Array.isArray(disabled)) {
    throw new ValueError(
      `${CLAUDE_SETTINGS}: 'disabledMcpjsonServers' is not a list;` +
        ' unsafe to edit — no files written',
    );
  }
  if (pyContains(disabled, name)) {
    dictSet(
      slot.doc,
      'disabledMcpjsonServers',
      (disabled as unknown[]).filter((value) => !pyEq(value, name)),
    );
    slot.disabled_removed.add(name);
    slot.touched = true;
  }
}

/** Append mcp__<name> entries to permissions.allow, scoped per name. */
function grantApprovals(
  state: ApplyState,
  current: Map<string, string | null>,
  items: string[],
): void {
  if (!items.length) return;
  const slot = jsonSlot(state, current, CLAUDE_SETTINGS);
  const permissions = tableOf(slot.doc, 'permissions', CLAUDE_SETTINGS);
  let allow = dictGetOr(permissions, 'allow', undefined);
  if (allow === undefined || allow === null) {
    allow = [] as unknown[];
    dictSet(permissions, 'allow', allow);
  }
  if (!Array.isArray(allow)) {
    throw new ValueError(
      `${CLAUDE_SETTINGS}: 'permissions.allow' is not a list;` +
        ' unsafe to edit — no files written',
    );
  }
  for (const item of items) {
    if (!pyContains(allow, item)) {
      allow.push(item);
      slot.allow_added.push(item);
      slot.touched = true;
    }
  }
}

function reenable(
  state: ApplyState,
  current: Map<string, string | null>,
  action: Dict,
): void {
  const client = dictGet(action, 'client') as string;
  const name = dictGet(action, 'registration') as string;
  if (client === 'claude') {
    clearDisabled(state, current, name);
    return;
  }
  if (client === 'opencode') {
    const slot = jsonSlot(state, current, dictGet(action, 'file') as string);
    const mcp = dictGetOr(slot.doc, 'mcp', null);
    const candidates: [Dict, Dict][] = [];
    if (isDict(mcp)) {
      const servers = dictGetOr(mcp, 'servers', null);
      if (isDict(servers) && isDict(dictGetOr(servers, name, null))) {
        candidates.push([slot.expect, dictGet(servers, name) as Dict]);
      }
      if (isDict(dictGetOr(mcp, name, null))) {
        candidates.push([slot.expect_direct, dictGet(mcp, name) as Dict]);
      }
    }
    if (candidates.length > 1) {
      throw new ValueError(
        `${dictGet(action, 'file')}: ${pyStrRepr(name)} is defined in two` +
          " layers; 'reenable' is ambiguous — record 'replace' or" +
          " 'keep'; no files written",
      );
    }
    if (!candidates.length) {
      throw new ValueError(
        `${dictGet(action, 'file')}: no ${pyStrRepr(name)} entry to` +
          ' re-enable; no files written',
      );
    }
    const [expect, entry] = candidates[0];
    if (dictHas(entry, 'disabled')) {
      dictDel(entry, 'disabled');
      slot.touched = true;
    }
    if (dictGet(entry, 'enabled') === false) {
      dictSet(entry, 'enabled', true);
      slot.touched = true;
    }
    dictSet(expect, name, dictCopy(entry));
    return;
  }
  const slot = tomlSlot(state, current, dictGet(action, 'file') as string);
  const existing = dictGetOr(
    tomlServers(slot.before, dictGet(action, 'file') as string),
    name,
    null,
  );
  if (!isDict(existing)) {
    throw new ValueError(
      `${dictGet(action, 'file')}: no mcp_servers.${name} table to` +
        ' re-enable; no files written',
    );
  }
  if (dictGet(existing, 'enabled') !== false) {
    return; // already enabled — an idempotent re-apply
  }
  const lines = splitlinesKeepends(slot.text);
  const span = tomlSpan(lines, name);
  if (span === null) {
    throw new ValueError(
      `${dictGet(action, 'file')}: cannot locate a contiguous` +
        ` [mcp_servers.${name}] table; edit it manually — no files` +
        ' written',
    );
  }
  let end = span[1];
  for (let index = span[0] + 1; index < span[1]; index += 1) {
    if (tomlKeyPath(lines[index]) !== null) {
      end = index;
      break;
    }
  }
  const enabledLine = /(\benabled\s*=\s*)false\b/;
  for (let index = span[0] + 1; index < end; index += 1) {
    if (enabledLine.test(lines[index])) {
      lines[index] = lines[index].replace(enabledLine, '$1true');
      slot.text = lines.join('');
      const expected = dictCopy(existing);
      dictSet(expected, 'enabled', true);
      dictSet(slot.expect, name, expected);
      slot.touched = true;
      return;
    }
  }
  throw new ValueError(
    `${dictGet(action, 'file')}: no 'enabled = false' line in` +
      ` [mcp_servers.${name}]; edit it manually — no files written`,
  );
}

/** Compute every mutation against verified current content. */
function applyActions(
  plan: Dict,
  current: Map<string, string | null>,
): [ApplyState, Dict[], Dict[]] {
  const state: ApplyState = {
    json: new Map<string, JsonSlot>(),
    toml: new Map<string, TomlSlot>(),
  };
  const applied: Dict[] = [];
  const skipped: Dict[] = [];
  for (const action of dictGet(plan, 'actions') as Dict[]) {
    const kind = effectiveKind(action);
    const summary: Dict = new Map<string, unknown>([
      ['service', dictGet(action, 'service')],
      ['client', dictGet(action, 'client')],
      ['registration', dictGet(action, 'registration')],
      ['action', dictGet(action, 'action')],
    ]);
    if (kind === 'skip' || kind === 'keep') {
      const summaryWithReason = dictCopy(summary);
      dictSet(
        summaryWithReason,
        'reason',
        kind === 'skip'
          ? 'nothing to write'
          : "resolution 'keep' recorded",
      );
      skipped.push(summaryWithReason);
      continue;
    }
    if (kind === 'add' || kind === 'replace') {
      putEntry(state, current, action, kind === 'replace');
      if (dictGet(action, 'client') === 'claude') {
        clearDisabled(state, current, dictGet(action, 'registration') as string);
      }
    } else if (kind === 'reenable') {
      reenable(state, current, action);
    }
    if (dictGet(action, 'client') === 'claude') {
      grantApprovals(state, current, dictGet(action, 'approvals') as string[]);
    }
    applied.push(summary);
  }
  return [state, applied, skipped];
}

function verifyServers(
  rel: string,
  label: string,
  before: Dict,
  after: Dict,
  expect: Dict,
): void {
  for (const name of dictKeys(before)) {
    if (
      !dictHas(expect, name) &&
      !pyEq(dictGet(before, name), dictGetOr(after, name, undefined))
    ) {
      throw new ValueError(
        `${rel}: unrelated ${label}.${name} changed during the` +
          ' edit; refusing — no files written',
      );
    }
  }
  const added = dictKeys(after).filter(
    (name) => !dictHas(before, name) && !dictHas(expect, name),
  );
  if (added.length) {
    throw new ValueError(
      `${rel}: unexpected registrations appeared during the edit;` +
        ' refusing — no files written',
    );
  }
  for (const [name, entry] of dictItems(expect)) {
    if (!pyEq(dictGetOr(after, name, undefined), entry)) {
      throw new ValueError(
        `${rel}: ${label}.${name} did not take effect as planned;` +
          ' refusing — no files written',
      );
    }
  }
}

function verifyJsonClient(rel: string, slot: JsonSlot): void {
  const before = slot.before;
  const after = slot.doc;
  const expect = slot.expect;
  if (rel === CLIENT_PATHS['claude']) {
    const keys = new Set([...dictKeys(before), ...dictKeys(after)]);
    for (const key of keys) {
      if (
        key !== 'mcpServers' &&
        !pyEq(dictGetOr(before, key, undefined), dictGetOr(after, key, undefined))
      ) {
        throw new ValueError(
          `${rel}: top-level field ${pyStrRepr(key)} changed during the` +
            ' edit; refusing — no files written',
        );
      }
    }
    verifyServers(
      rel,
      'mcpServers',
      (dictGetOr(before, 'mcpServers', null) ?? new Map()) as Dict,
      (dictGetOr(after, 'mcpServers', null) ?? new Map()) as Dict,
      expect,
    );
    return;
  }
  const keys = new Set([...dictKeys(before), ...dictKeys(after)]);
  for (const key of keys) {
    if (
      key !== 'mcp' &&
      !pyEq(dictGetOr(before, key, undefined), dictGetOr(after, key, undefined))
    ) {
      throw new ValueError(
        `${rel}: top-level field ${pyStrRepr(key)} changed during the` +
          ' edit; refusing — no files written',
      );
    }
  }
  const beforeMcp = (dictGetOr(before, 'mcp', null) ?? new Map()) as Dict;
  const afterMcp = (dictGetOr(after, 'mcp', null) ?? new Map()) as Dict;
  for (const key of dictKeys(beforeMcp)) {
    if (key === 'servers') continue;
    if (slot.deleted.has(key)) {
      if (dictHas(afterMcp, key)) {
        throw new ValueError(
          `${rel}: legacy mcp.${key} was not removed by the` +
            ' resolution; refusing — no files written',
        );
      }
    } else if (dictHas(slot.expect_direct, key)) {
      if (
        !pyEq(
          dictGetOr(afterMcp, key, undefined),
          dictGet(slot.expect_direct, key),
        )
      ) {
        throw new ValueError(
          `${rel}: mcp.${key} did not take effect as planned;` +
            ' refusing — no files written',
        );
      }
    } else if (
      !pyEq(dictGetOr(afterMcp, key, undefined), dictGet(beforeMcp, key))
    ) {
      throw new ValueError(
        `${rel}: unrelated mcp.${key} changed during the edit;` +
          ' refusing — no files written',
      );
    }
  }
  for (const key of dictKeys(afterMcp)) {
    if (!dictHas(beforeMcp, key) && key !== 'servers') {
      throw new ValueError(
        `${rel}: unexpected mcp.${key} appeared during the edit;` +
          ' refusing — no files written',
      );
    }
  }
  verifyServers(
    rel,
    'mcp.servers',
    (dictGetOr(beforeMcp, 'servers', null) ?? new Map()) as Dict,
    (dictGetOr(afterMcp, 'servers', null) ?? new Map()) as Dict,
    expect,
  );
}

function verifySettings(slot: JsonSlot): void {
  const before = slot.before;
  const after = slot.doc;
  const keys = new Set([...dictKeys(before), ...dictKeys(after)]);
  for (const key of keys) {
    if (
      key !== 'permissions' &&
      key !== 'disabledMcpjsonServers' &&
      !pyEq(dictGetOr(before, key, undefined), dictGetOr(after, key, undefined))
    ) {
      throw new ValueError(
        `${CLAUDE_SETTINGS}: field ${pyStrRepr(key)} changed during the` +
          ' edit; refusing — no files written',
      );
    }
  }
  const beforePerm = (dictGetOr(before, 'permissions', null) ??
    new Map()) as Dict;
  const afterPerm = (dictGetOr(after, 'permissions', null) ??
    new Map()) as Dict;
  const permKeys = new Set([...dictKeys(beforePerm), ...dictKeys(afterPerm)]);
  for (const key of permKeys) {
    if (
      key !== 'allow' &&
      !pyEq(
        dictGetOr(beforePerm, key, undefined),
        dictGetOr(afterPerm, key, undefined),
      )
    ) {
      throw new ValueError(
        `${CLAUDE_SETTINGS}: permissions.${key} changed during` +
          ' the edit; refusing — no files written',
      );
    }
  }
  const expectedAllow = [
    ...((dictGetOr(beforePerm, 'allow', null) ?? []) as unknown[]),
    ...slot.allow_added,
  ];
  if (!pyEq(dictGetOr(afterPerm, 'allow', null) ?? [], expectedAllow)) {
    throw new ValueError(
      `${CLAUDE_SETTINGS}: permissions.allow differs from the` +
        ' planned approval additions; refusing — no files written',
    );
  }
  const expectedDisabled = (
    (dictGetOr(before, 'disabledMcpjsonServers', null) ?? []) as unknown[]
  ).filter((value) => {
    for (const removed of slot.disabled_removed) {
      if (pyEq(value, removed)) return false;
    }
    return true;
  });
  if (
    !pyEq(
      dictGetOr(after, 'disabledMcpjsonServers', null) ?? [],
      expectedDisabled,
    )
  ) {
    throw new ValueError(
      `${CLAUDE_SETTINGS}: disabledMcpjsonServers differs from` +
        ' the planned removals; refusing — no files written',
    );
  }
}

/** Verify each mutated document, then render writes (no I/O yet). */
function serializeWrites(state: ApplyState): Map<string, string> {
  const writes = new Map<string, string>();
  for (const [rel, slot] of state.toml) {
    if (!slot.touched) continue;
    let after: Dict;
    try {
      after = tomlLoads(slot.text);
    } catch (error) {
      if ((error as Error)?.name !== 'ValueError') throw error;
      throw new ValueError(
        `edited ${rel} no longer parses: ${errorText(error)}; refusing —` +
          ' no files written',
      );
    }
    verifyToml(rel, slot.before, after, slot.expect);
    writes.set(rel, slot.text);
  }
  for (const [rel, slot] of state.json) {
    if (!slot.touched) continue;
    if (rel === CLAUDE_SETTINGS) {
      verifySettings(slot);
    } else {
      verifyJsonClient(rel, slot);
    }
    const text = `${jsonDumps(slot.doc)}\n`;
    if (!pyEq(jsonLoads(text), slot.doc)) {
      throw new ValueError(
        `edited ${rel} did not round-trip; refusing — no files` +
          ' written',
      );
    }
    writes.set(rel, text);
  }
  return writes;
}

function verifyToml(
  rel: string,
  before: Dict,
  after: Dict,
  expect: Dict,
): void {
  // Parsed before/after may differ only in the expected entries.
  const rest = (doc: Dict): Dict => {
    const remainder = new Map<string, unknown>();
    for (const [key, value] of dictItems(doc)) {
      if (key !== 'mcp_servers') remainder.set(key, value);
    }
    return remainder;
  };
  if (!pyDictEq(rest(before), rest(after))) {
    throw new ValueError(
      `${rel}: unrelated tables changed during the edit; refusing` +
        ' — no files written',
    );
  }
  const beforeServers = dictGetOr(before, 'mcp_servers', null) ?? {};
  const afterServers = dictGetOr(after, 'mcp_servers', null) ?? {};
  if (!isDict(beforeServers) || !isDict(afterServers)) {
    throw new ValueError(
      `${rel}: 'mcp_servers' is not a table; refusing` +
        ' — no files written',
    );
  }
  for (const name of dictKeys(beforeServers)) {
    if (
      !dictHas(expect, name) &&
      !pyEq(
        dictGet(beforeServers, name),
        dictGetOr(afterServers, name, undefined),
      )
    ) {
      throw new ValueError(
        `${rel}: unrelated mcp_servers.${name} changed during the` +
          ' edit; refusing — no files written',
      );
    }
  }
  const added = dictKeys(afterServers).filter(
    (name) => !dictHas(beforeServers, name) && !dictHas(expect, name),
  );
  if (added.length) {
    throw new ValueError(
      `${rel}: unexpected registrations appeared during the edit;` +
        ' refusing — no files written',
    );
  }
  for (const [name, entry] of dictItems(expect)) {
    if (!pyEq(dictGetOr(afterServers, name, undefined), entry)) {
      throw new ValueError(
        `${rel}: mcp_servers.${name} did not take effect as` +
          ' planned; refusing — no files written',
      );
    }
  }
}

/**
 * Execute a confirmed plan; refuses the whole plan before any write.
 *
 * Authorization is the confirmed plan alone — the caller's
 * `plan["confirmed"]` flag plus a recorded resolution on every
 * conflicted action. Prior alignment, earlier runs and git tracking state
 * are never consulted. Every destination file is re-read and checked
 * against the digest recorded at plan time; a changed digest, a missing
 * confirmation, an unresolved conflict, a malformed plan or a
 * destination resolving outside the project root raises ValueError
 * before anything is written. On success the plan's digests are
 * refreshed and applied actions marked, so re-applying the same plan
 * is a no-op.
 */
export function apply(plan: unknown, root?: string): Dict {
  validatePlan(plan);
  const planDict = plan as Dict;
  const resolvedRoot = resolvePath(dictGet(planDict, 'root') as string);
  if (resolvedRoot !== dictGet(planDict, 'root') || !isDir(resolvedRoot)) {
    throw new ValueError(
      `plan root ${pyRepr(dictGet(planDict, 'root'))} is unavailable or` +
        ' differs; refusing — no files written',
    );
  }
  if (root !== undefined && resolvePath(root) !== resolvedRoot) {
    throw new ValueError(
      `caller root ${pyRepr(resolvePath(root))} differs from plan root` +
        ` ${pyRepr(dictGet(planDict, 'root'))}; refusing — no files` +
        ' written',
    );
  }
  if (dictGet(planDict, 'confirmed') !== true) {
    throw new ValueError(
      "the plan's selections were not explicitly confirmed;" +
        ' refusing — no files written',
    );
  }
  for (const action of dictGet(planDict, 'actions') as Dict[]) {
    if (dictGet(action, 'action') === 'conflict-needs-resolution') {
      const resolution = dictGetOr(action, 'resolution', null);
      if (
        !isDict(resolution) ||
        !(RESOLUTION_KINDS as readonly unknown[]).includes(
          dictGet(resolution, 'kind'),
        )
      ) {
        throw new ValueError(
          `service ${pyStrRepr(dictGet(action, 'service') as string)} on` +
            ` ${dictGet(action, 'client')}` +
            ' is conflicted and the confirmed plan records no' +
            ` resolution (${RESOLUTION_KINDS.join('/')});` +
            ' refusing — no files written',
        );
      }
    }
  }
  const current = new Map<string, string | null>();
  for (const [rel, meta] of dictItems(dictGet(planDict, 'files') as Dict)) {
    const path = join(resolvedRoot, rel);
    if (!isRelativeTo(resolvedRoot, resolvePath(path))) {
      throw new ValueError(
        `destination ${rel} resolves outside the project root` +
          ' (a symlinked component escapes the checkout);' +
          ' refusing — no files written',
      );
    }
    const present = isFile(path);
    const digest = present
      ? `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
      : null;
    if (
      digest !== dictGet(meta as Dict, 'digest') ||
      present !== dictGet(meta as Dict, 'present')
    ) {
      throw new ValueError(
        `stale plan: ${rel} changed since the plan was built;` +
          ' rebuild the plan — no files written',
      );
    }
    current.set(rel, present ? readText(path) : null);
  }
  const [state, applied, skipped] = applyActions(planDict, current);
  const writes = serializeWrites(state);
  for (const [rel, text] of writes) {
    atomic(join(resolvedRoot, rel), text);
    dictSet(dictGet(planDict, 'files') as Dict, rel, new Map<string, unknown>([
      [
        'digest',
        `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`,
      ],
      ['present', true],
    ]));
  }
  for (const action of dictGet(planDict, 'actions') as Dict[]) {
    dictSet(action, 'applied', true);
  }
  return new Map<string, unknown>([
    ['refused', false],
    ['files_written', pySortedStrings(writes.keys())],
    ['applied', applied],
    ['skipped', skipped],
  ]);
}

// --- Codex TOML rendering ----------------------------------------------------

function tomlValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return jsonDumps(value);
  if (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof PyFloat
  ) {
    return pyRepr(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => tomlValue(item)).join(', ')}]`;
  }
  throw new ValueError(`cannot render TOML value ${pyRepr(value)}`);
}

function codexBlock(name: string, entry: Dict): string {
  const lines = [`[mcp_servers.${jsonDumps(name)}]`];
  for (const [key, value] of dictItems(entry)) {
    lines.push(`${key} = ${tomlValue(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** (segments, is_array) for a TOML table-header line, else `null`. */
function tomlKeyPath(line: string): [string[], boolean] | null {
  const stripped = line.replace(/^[ \t]+/, '');
  if (!stripped.startsWith('[')) return null;
  const array = stripped.startsWith('[[');
  let index = array ? 2 : 1;
  const segments: string[] = [];
  for (;;) {
    while (index < stripped.length && ' \t'.includes(stripped[index])) {
      index += 1;
    }
    if (index >= stripped.length) return null;
    const char = stripped[index];
    if (char === '"') {
      let cursor = index + 1;
      while (cursor < stripped.length && stripped[cursor] !== '"') {
        if (stripped[cursor] === '\\') cursor += 1;
        cursor += 1;
      }
      if (cursor >= stripped.length) return null;
      try {
        segments.push(jsonLoads(stripped.slice(index, cursor + 1)) as string);
      } catch (error) {
        if ((error as Error)?.name !== 'ValueError') throw error;
        segments.push(stripped.slice(index + 1, cursor));
      }
      index = cursor + 1;
    } else if (char === "'") {
      const cursor = stripped.indexOf("'", index + 1);
      if (cursor < 0) return null;
      segments.push(stripped.slice(index + 1, cursor));
      index = cursor + 1;
    } else if (char === ']') {
      if (array) {
        if (stripped.slice(index, index + 2) !== ']]') return null;
        index += 2;
      } else {
        index += 1;
      }
      const rest = stripped.slice(index).trim();
      return !rest || rest.startsWith('#') ? [segments, array] : null;
    } else {
      let cursor = index;
      while (
        cursor < stripped.length &&
        !'. \t]'.includes(stripped[cursor])
      ) {
        cursor += 1;
      }
      segments.push(stripped.slice(index, cursor));
      index = cursor;
    }
    while (index < stripped.length && ' \t'.includes(stripped[index])) {
      index += 1;
    }
    if (index < stripped.length && stripped[index] === '.') {
      index += 1;
    }
  }
}

// --- Command line interface (issue #107, slice 3) ------------------------------

/** Load one names-and-pointers JSON input file. */
function jsonFile(path: string, what: string): unknown {
  try {
    return jsonLoads(readText(path));
  } catch (error) {
    if (isOSError(error)) {
      throw new ValueError(
        `cannot read the ${what} file ${pyStrRepr(path)}:` +
          ` ${errorText(pyOsError(error))}`,
      );
    }
    if ((error as Error)?.name === 'ValueError') {
      throw new ValueError(
        `the ${what} file ${pyStrRepr(path)} is not valid JSON:` +
          ` ${errorText(error)}`,
      );
    }
    throw error;
  }
}

const PROG = 'agent-workflows.ts mcp_configure';
const USAGE = `usage: ${PROG} [-h] {check,plan,apply} ...`;
const CHECK_USAGE =
  `usage: ${PROG} check [-h] [--root ROOT] [--clients CLIENTS]\n` +
  '                              [--mapping MAPPING] [--machine MACHINE]';
const PLAN_USAGE =
  `usage: ${PROG} plan [-h] [--root ROOT] [--clients CLIENTS] --mapping\n` +
  '                             MAPPING [--machine MACHINE]\n' +
  '                             [--selections SELECTIONS] [--out OUT]';
const APPLY_USAGE =
  `usage: ${PROG} apply [-h] --plan PLAN_FILE [--confirm]`;
const USAGES: Record<string, string> = {
  check: CHECK_USAGE,
  plan: PLAN_USAGE,
  apply: APPLY_USAGE,
};

/** Raised to unwind `parser.error`/`--help` through `main`. */
class ExitError extends Error {
  code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function parserError(
  usage: string,
  prog: string,
  message: string,
): never {
  process.stderr.write(`${usage}\n${prog}: error: ${message}\n`);
  throw new ExitError(2);
}

const TOP_HELP =
  `${USAGE}\n\n` +
  "Inspect, plan and apply authorized project MCP client configuration. 'check'\n" +
  "is read-only; 'plan' emits an unconfirmed redacted plan; 'apply' executes only\n" +
  'a plan the owner confirmed.\n\n' +
  'positional arguments:\n' +
  '  {check,plan,apply}\n' +
  '    check             print the redacted classification report; writes nothing\n' +
  '    plan              emit a redacted, unconfirmed plan for owner review\n' +
  '    apply             execute a confirmed plan file; refuses otherwise\n\n' +
  'options:\n' +
  '  -h, --help          show this help message and exit\n';

const CHECK_HELP =
  `${CHECK_USAGE}\n\n` +
  'options:\n' +
  '  -h, --help         show this help message and exit\n' +
  '  --root ROOT\n' +
  '  --clients CLIENTS\n' +
  '  --mapping MAPPING  JSON file with the confirmed\n' +
  '                     service->client->registration names\n' +
  '  --machine MACHINE  JSON file describing this machine: present env-var names,\n' +
  '                     resolvable executables and local_config_refs details\n';

const PLAN_HELP =
  `${PLAN_USAGE}\n\n` +
  'options:\n' +
  '  -h, --help            show this help message and exit\n' +
  '  --root ROOT\n' +
  '  --clients CLIENTS\n' +
  '  --mapping MAPPING     JSON file with the confirmed\n' +
  '                        service->client->registration names\n' +
  '  --machine MACHINE     JSON file describing this machine\n' +
  '  --selections SELECTIONS\n' +
  '                        JSON file naming the selected services; defaults to\n' +
  '                        every declared service\n' +
  '  --out OUT             write the plan to this file instead of stdout\n';

const APPLY_HELP =
  `${APPLY_USAGE}\n\n` +
  'options:\n' +
  '  -h, --help        show this help message and exit\n' +
  '  --plan PLAN_FILE  the reviewed plan JSON file\n' +
  '  --confirm         the recorded explicit go-ahead after the owner reviewed\n' +
  '                    the plan\n';

function cliHelp(command: string | null): string {
  if (command === 'check') return CHECK_HELP;
  if (command === 'plan') return PLAN_HELP;
  if (command === 'apply') return APPLY_HELP;
  return TOP_HELP;
}

interface OptionSpec {
  names: string[];
  dest: string;
  takesValue: boolean;
}

const CHECK_OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--root'], dest: 'root', takesValue: true },
  { names: ['--clients'], dest: 'clients', takesValue: true },
  { names: ['--mapping'], dest: 'mapping', takesValue: true },
  { names: ['--machine'], dest: 'machine', takesValue: true },
];
const PLAN_OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--root'], dest: 'root', takesValue: true },
  { names: ['--clients'], dest: 'clients', takesValue: true },
  { names: ['--mapping'], dest: 'mapping', takesValue: true },
  { names: ['--machine'], dest: 'machine', takesValue: true },
  { names: ['--selections'], dest: 'selections', takesValue: true },
  { names: ['--out'], dest: 'out', takesValue: true },
];
const APPLY_OPTIONS: OptionSpec[] = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--plan'], dest: 'plan_file', takesValue: true },
  { names: ['--confirm'], dest: 'confirm', takesValue: false },
];
const COMMAND_OPTIONS: Record<string, OptionSpec[]> = {
  check: CHECK_OPTIONS,
  plan: PLAN_OPTIONS,
  apply: APPLY_OPTIONS,
};

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

function parseArgs(
  argv: string[],
  options: OptionSpec[],
  usage: string,
  command: string,
): { values: Record<string, unknown>; extras: string[] } {
  const prog = `${PROG} ${command}`;
  const values: Record<string, unknown> = {};
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
      let option = options.find((o) => o.names.includes(optName));
      if (option === undefined) {
        const matched = options.flatMap((o) =>
          o.names.filter((name) => name.startsWith(optName)),
        );
        const candidates = options.filter((o) =>
          o.names.some((name) => matched.includes(name)),
        );
        if (candidates.length === 1) {
          option = candidates[0];
        } else if (candidates.length > 1) {
          parserError(
            usage,
            prog,
            `ambiguous option: ${optName} could match ${matched.join(', ')}`,
          );
        } else {
          extras.push(arg);
          continue;
        }
      }
      if (option.dest === 'help') {
        if (explicit !== undefined) {
          parserError(
            usage,
            prog,
            `argument ${optionLabel(option)}: ignored explicit argument` +
              ` ${pyRepr(explicit)}`,
          );
        }
        process.stdout.write(cliHelp(command));
        throw new ExitError(0);
      }
      if (!option.takesValue) {
        if (explicit !== undefined) {
          parserError(
            usage,
            prog,
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
            usage,
            prog,
            `argument ${optionLabel(option)}: expected one argument`,
          );
        }
        value = next;
        index += 1;
      }
      values[option.dest] = value;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      // `_parse_optional` for the parser's only short option: an exact
      // `-h` reaches the help action; anything else is unrecognized.
      if (arg === '-h') {
        process.stdout.write(cliHelp(command));
        throw new ExitError(0);
      }
      extras.push(arg);
      continue;
    }
    extras.push(arg);
  }
  return { values, extras };
}

/** The confirmed `--clients` list or a usage error. */
function cliClients(raw: string): string[] {
  const clients = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part);
  const unknown = clients.filter(
    (client) => !Object.hasOwn(CLIENT_PATHS, client),
  );
  if (!clients.length || unknown.length) {
    parserError(
      USAGE,
      PROG,
      `--clients must name supported clients` +
        ` (${Object.keys(CLIENT_PATHS).join(', ')}); got ${pyStrRepr(raw)}`,
    );
  }
  return clients;
}

/** Every service the manifest declares; empty when none is readable. */
function defaultSelections(root: string): string[] {
  let manifest: Map<string, unknown> | null;
  try {
    manifest = mcpRequirements.loadManifest(root);
  } catch (error) {
    if ((error as Error)?.name !== 'ValueError') throw error;
    return [];
  }
  if (manifest === null) return [];
  return (dictGet(manifest, 'services') as Dict[]).map(
    (service) => dictGet(service, 'id') as string,
  );
}

/** Thin CLI over the library functions; exit 0 ok, 1 refusal, 2 usage. */
function runMain(argv: string[]): number {
  // Top-level parse: option-like tokens before the subcommand are parsed
  // against the main parser's options (`-h` fires immediately, the rest
  // become extras); the first non-option token — or the token after a
  // `--` separator — is the subcommand. argparse checks required actions
  // before reporting extras, so a missing `command` wins over
  // `unrecognized arguments`.
  const topExtras: string[] = [];
  let command: string | null = null;
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === '--') {
      if (index < argv.length) {
        command = argv[index];
        index += 1;
      }
      break;
    }
    if (!isOptionLike(token)) {
      command = token;
      break;
    }
    if (token === '-h' || token === '--help') {
      process.stdout.write(TOP_HELP);
      throw new ExitError(0);
    }
    if (token.startsWith('--help=')) {
      parserError(
        USAGE,
        PROG,
        `argument -h/--help: ignored explicit argument` +
          ` ${pyRepr(token.slice('--help='.length))}`,
      );
    }
    topExtras.push(token);
  }
  if (command === null) {
    parserError(USAGE, PROG, 'the following arguments are required: command');
  }
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    parserError(
      USAGE,
      PROG,
      `argument command: invalid choice: ${pyStrRepr(command)}` +
        ' (choose from check, plan, apply)',
    );
  }
  const usage = USAGES[command];
  const { values, extras } = parseArgs(
    argv.slice(index),
    COMMAND_OPTIONS[command],
    usage,
    command,
  );
  const prog = `${PROG} ${command}`;
  // Subparser required-argument errors fire before the main parser's
  // `unrecognized arguments` report.
  if (command === 'plan' && values['mapping'] === undefined) {
    parserError(
      usage,
      prog,
      'the following arguments are required: --mapping',
    );
  }
  if (command === 'apply' && values['plan_file'] === undefined) {
    parserError(
      usage,
      prog,
      'the following arguments are required: --plan',
    );
  }
  const allExtras = [...topExtras, ...extras];
  if (allExtras.length) {
    parserError(
      USAGE,
      PROG,
      `unrecognized arguments: ${allExtras.join(' ')}`,
    );
  }
  try {
    if (command === 'check') {
      const report = assess(
        (values['root'] as string | undefined) ?? '.',
        {
          machine:
            values['machine'] !== undefined
              ? (jsonFile(values['machine'] as string, 'machine') as Dict)
              : undefined,
          mapping:
            values['mapping'] !== undefined
              ? jsonFile(values['mapping'] as string, 'mapping')
              : undefined,
          clients: cliClients(
            (values['clients'] as string | undefined) ?? CLIENTS.join(','),
          ),
        },
      );
      console.log(jsonDumps(report));
      return 0;
    }
    if (command === 'plan') {
      const root = (values['root'] as string | undefined) ?? '.';
      const selections =
        values['selections'] !== undefined
          ? jsonFile(values['selections'] as string, 'selections')
          : defaultSelections(root);
      const plan = buildPlan(
        root,
        jsonFile(values['mapping'] as string, 'mapping'),
        selections,
        {
          machine:
            values['machine'] !== undefined
              ? (jsonFile(values['machine'] as string, 'machine') as Dict)
              : undefined,
          clients: cliClients(
            (values['clients'] as string | undefined) ?? CLIENTS.join(','),
          ),
        },
      );
      const text = `${jsonDumps(plan)}\n`;
      if (values['out'] !== undefined) {
        writeFileSync(values['out'] as string, text);
      } else {
        process.stdout.write(text);
      }
      return 0;
    }
    if (values['confirm'] !== true) {
      console.error(
        'refused: apply requires --confirm — the recorded ' +
          'explicit go-ahead after the owner reviewed the plan; ' +
          'no files written',
      );
      return 1;
    }
    const plan = jsonFile(values['plan_file'] as string, 'plan');
    const outcome = apply(plan);
    // Refresh the plan file in place so a re-run is a verified no-op:
    // destination digests and 'applied' markers now reflect reality.
    writeFileSync(values['plan_file'] as string, `${jsonDumps(plan)}\n`);
    console.log(jsonDumps(outcome));
    return 0;
  } catch (error) {
    if ((error as Error)?.name === 'ValueError') {
      console.error(`refused: ${errorText(error)}`);
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
  import.meta.url === pathToFileURL(resolvePath(process.argv[1])).href
) {
  process.exitCode = main();
}
