/**
 * Portable project MCP service requirements (issue #106).
 *
 * An optional, consumer-owned `.agents/mcp-requirements.json` declares which
 * MCP services a project's workflows need: a stable service identity per
 * requirement (distinct from any client registration name), purpose, required
 * or optional status, workflow applicability, references to existing project
 * guidance, a portable connection description or a pointer to separately
 * configured machine-local details, credential NAMES and a bounded read-only
 * verification expectation.
 *
 * The manifest carries declarations and references only. Machine-specific
 * executable paths, credential values, OAuth state and observed readiness
 * never appear in it; `additionalProperties: false` throughout the schema
 * means no value-bearing field can hide.
 *
 * This module is pure and offline: it parses and validates manifests and
 * evaluates readiness against caller-supplied machine descriptors. It spawns
 * no subprocesses, opens no sockets and probes no environment at import or
 * call time. Validation implements the normative JSON Schema in
 * `docs/mcp-requirements.schema.json` without third-party dependencies.
 */
import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pyRepr, pyStr, pyTypeName } from './lib/pyrepr.ts';
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
} from './lib/pyerrors.ts';

export const MANIFEST = '.agents/mcp-requirements.json';
export const SUPPORTED_VERSION = 1;

const ID = /^[a-z][a-z0-9-]*$/;
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/;
const WORKFLOW = /^(?:\*|[a-z][a-z0-9-]*)$/;
const NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const MACHINE_PATH = /[A-Za-z]:[/\\]/;
// Characters that are whitespace under EITHER regex engine whose semantics
// this contract is checked under (Python `re` and ECMA-262). Prose fields
// must contain at least one character outside this set; the identical class
// is used in docs/mcp-requirements.schema.json so both engines agree.
const VISIBLE_TEXT =
  /[^\t-\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
// Shared with docs/mcp-requirements.schema.json so the URL authority means
// the same thing under Python validation and the normative schema: ASCII
// hostname labels, an optional numeric port, no parser-dependent semantics
// (tab stripping, NFKC normalization) for either side to disagree on.
const HOSTNAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?)*$/;
const PORT = /^[0-9]*$/;
const SERVICE_KEYS = new Set([
  'id', 'purpose', 'required', 'workflows', 'guidance',
  'connection', 'credential_refs', 'verification',
]);
const CONNECTION_KEYS = new Set([
  'type', 'url', 'auth', 'command_ref', 'local_config_ref',
]);

// Parsed JSON objects arrive as `Map`s — plain objects cannot keep
// Python's insertion order for integer-like keys — while dicts callers
// build by hand stay plain objects. Both shapes are dicts here.
type Dict = Record<string, unknown> | Map<string, unknown>;

function isDict(value: unknown): value is Dict {
  if (value instanceof Map) return true;
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat)
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
 * `for key in mapping` — insertion order for parsed `Map` dicts, like
 * Python's. Plain objects follow JavaScript key order, which already
 * sorted integer-like keys at construction; nothing can recover it.
 */
function dictKeys(mapping: Dict): string[] {
  return mapping instanceof Map ? [...mapping.keys()] : Object.keys(mapping);
}

/** `isinstance(value, (int, float))` — callers exclude `bool` first. */
function isPyNumber(value: unknown): value is number | bigint | PyFloat {
  return (
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof PyFloat
  );
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

/** `mapping[key]` — KeyError on dicts, TypeError on non-subscriptables. */
function req(mapping: unknown, key: string): unknown {
  if (isDict(mapping)) {
    if (dictHas(mapping, key)) return dictGet(mapping, key);
    throw new KeyError(key);
  }
  const name = pyTypeName(mapping);
  const detail =
    name === 'str'
      ? 'string indices must be integers'
      : name === 'list'
        ? 'list indices must be integers or slices, not str'
        : `'${name}' object is not subscriptable`;
  throw new PyTypeError(detail);
}

/** `mapping.get(key, default)` — raises AttributeError on non-dicts. */
function pyGet(mapping: unknown, key: string, fallback?: unknown): unknown {
  if (!isDict(mapping)) {
    throw new AttributeError(
      `'${pyTypeName(mapping)}' object has no attribute 'get'`,
    );
  }
  return dictHas(mapping, key) ? dictGet(mapping, key) : fallback;
}

/**
 * The numeric tower Python's `==` and `hash()` share: `bool`, `int` and
 * `float` compare across types (`2.0 in {2}` and `True in {1}` are True),
 * so every integral value reduces to its `bigint` — `BigInt(double)` is
 * exact at any magnitude — while non-integral and non-finite floats stay
 * doubles. `-0.0` reduces to `0n`, matching `-0.0 == 0.0`; `nan` stays a
 * double, which Python reports as equal to nothing, not even itself.
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
 * Python `==` over the values membership compares. Identity
 * short-circuits first like CPython's `is` check inside `in`; survivors
 * compare by value, with numbers crossing `int`/`float`/`bool` through
 * `pyNumeric` and lists and dicts comparing element- and key-wise like
 * Python's deep `==`. Containers reach here only through list
 * membership — `in` rejects them as unhashable on sets and dicts before
 * any comparison.
 */
function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // `==` is deep for containers (`["a"] in [["a"]]` holds); a container
  // on only one side is never equal — Python does not equate a list or
  // dict with a scalar (`["a"] == "a"` is False).
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
  // `undefined` and `null` are both `None` here — a `.get` miss and an
  // explicit JSON null — and `None == None` holds.
  if (a === null || a === undefined || b === null || b === undefined) {
    return (
      (a === null || a === undefined) &&
      (b === null || b === undefined)
    );
  }
  const numericA = pyNumeric(a);
  const numericB = pyNumeric(b);
  if (numericA === undefined || numericB === undefined) return false;
  // A surviving `number` is non-integral or non-finite, so only another
  // `number` can equal it (`0 === -0` holds; `NaN` never matches).
  return numericA === numericB;
}

/**
 * Python dict `==`: the same key set with pairwise-equal values, order-
 * free. Keys are strings on both dict shapes this port handles.
 */
function pyDictEq(a: Dict, b: Dict): boolean {
  const keys = dictKeys(a);
  if (keys.length !== dictKeys(b).length) return false;
  return keys.every(
    (key) => dictHas(b, key) && pyEq(dictGet(a, key), dictGet(b, key)),
  );
}

/** `set(value)` over the JSON-shaped machine descriptors Python accepts. */
function pySet(value: unknown): Set<unknown> {
  // Absent fields arrive as the caller's `[]`/`()` default; an explicit
  // `null` is `None` and `set(None)` raises TypeError, so there is no
  // null shortcut — `pyIterate` raises 'NoneType' for it like CPython.
  const members = new Set<unknown>();
  for (const member of pyIterate(value)) {
    // `set()` hashes every member; lists and dicts cannot be hashed.
    if (Array.isArray(member) || isDict(member)) {
      throw new PyTypeError(`unhashable type: '${pyTypeName(member)}'`);
    }
    members.add(member);
  }
  return members;
}

/** `item in set` — `==` by value like CPython, never object identity. */
function pySetHas(set: Set<unknown>, item: unknown): boolean {
  // Membership hashes the item first: unhashable lookups raise even on
  // an empty set, and only equal values match afterwards.
  if (Array.isArray(item) || isDict(item)) {
    throw new PyTypeError(`unhashable type: '${pyTypeName(item)}'`);
  }
  for (const member of set) {
    if (pyEq(member, item)) return true;
  }
  return false;
}

/** `for x in value` over the JSON-shaped containers Python iterates. */
function pyIterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isDict(value)) return dictKeys(value);
  if (typeof value === 'string') return [...value];
  throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/** `item in container` over the JSON-shaped containers Python supports. */
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
  // List membership is a linear `==` scan: no hashing, and `2 in [2.0]`
  // is True just like `2.0 in {2}`.
  if (Array.isArray(container)) {
    return container.some((member) => pyEq(member, item));
  }
  if (isDict(container)) {
    if (Array.isArray(item) || isDict(item)) {
      throw new PyTypeError(`unhashable type: '${pyTypeName(item)}'`);
    }
    // Dict keys are strings; `Object.hasOwn` would coerce anything else
    // (`1 in {"1": x}` is False in Python, so the coercion must not run).
    return typeof item === 'string' && dictHas(container, item);
  }
  throw new PyTypeError(
    `argument of type '${pyTypeName(container)}' is not iterable`,
  );
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Read and validate a manifest file; return the parsed manifest.
 *
 * `root` resolves `guidance` references; it defaults to the manifest's
 * project root (the parent of its `.agents` directory). Throws ValueError
 * with every diagnostic when the file is unreadable or invalid.
 */
export function load(path: string, root?: string): Map<string, unknown> {
  const resolvedRoot = root ?? dirname(dirname(path));
  // `json.loads(path.read_text())`: readText mirrors read_text (UTF-8
  // with universal newlines, the BOM left in the text) and pyJsonLoads
  // mirrors json.loads — the `NaN`/`Infinity`/`-Infinity` constants and
  // the BOM rejection included — so the values diagnostics runs on are
  // the ones Python produces.
  const text = readText(path);
  let data: unknown;
  try {
    data = pyJsonLoads(text);
  } catch (error) {
    // The decoder's wording is part of the contract: Python embeds
    // `str(JSONDecodeError)` ('{msg}: line {n} column {n} (char {n})'),
    // so the failure is re-scanned for the attributes CPython's scanner
    // reports on the same text. A null result means CPython accepts the
    // document — unreachable past a pyJsonLoads throw — and the original
    // message stands in.
    const decodeError = jsonLoadsError(text);
    const reason =
      decodeError === null
        ? (error as Error).message
        : jsonLoadsErrorMessage(text, decodeError);
    throw new ValueError(
      `Unreadable ${path}: ${reason}; fix the JSON or remove the manifest`,
    );
  }
  const problems = diagnostics(data, resolvedRoot);
  if (problems.length) {
    throw new ValueError(
      `Invalid ${path}:\n${problems.map((p) => `- ${p}`).join('\n')}`,
    );
  }
  return data as Map<string, unknown>;
}

/**
 * Return the consumer manifest under `root`, or null when absent.
 *
 * Absence is not an error: the file is optional and callers keep their
 * existing behavior without it.
 */
export function loadManifest(root: string): Map<string, unknown> | null {
  const path = join(root, MANIFEST);
  if (!isFile(path)) return null;
  return load(path, root);
}

/** Return every contract violation in `data` as actionable text. */
export function diagnostics(data: unknown, root: string): string[] {
  const problems: string[] = [];
  if (!isDict(data)) return ['manifest must be a JSON object'];
  for (const key of dictKeys(data)) {
    if (key !== 'version' && key !== 'services') {
      problems.push(
        `unexpected field ${pyRepr(key)}; the manifest defines only` +
          " 'version' and 'services' (additionalProperties: false)",
      );
    }
  }
  if (!dictHas(data, 'version')) {
    problems.push("missing required field 'version' (integer)");
  } else {
    const version = dictGet(data, 'version');
    // `isinstance(version, (int, float))` — Python's `bool` is an `int`
    // subclass, so the original excludes it explicitly too.
    if (typeof version === 'boolean' || !isPyNumber(version)) {
      problems.push(
        `'version' must be the integer ${SUPPORTED_VERSION},` +
          ` got ${pyRepr(version)}`,
      );
    } else {
      // `version != SUPPORTED_VERSION`: Python compares numerically, so
      // `1`, `1n` and `1.0` are all supported — `2.0` reports as `2.0`.
      const numeric = version instanceof PyFloat ? version.value : version;
      const supported =
        typeof numeric === 'bigint'
          ? numeric === BigInt(SUPPORTED_VERSION)
          : numeric === SUPPORTED_VERSION;
      if (!supported) {
        problems.push(
          `unsupported 'version' ${pyStr(version)}; this toolchain supports` +
            ` version ${SUPPORTED_VERSION} — rewrite the manifest against` +
            ' docs/mcp-requirements.schema.json',
        );
      }
    }
  }
  const services = dictGet(data, 'services');
  if (!dictHas(data, 'services')) {
    problems.push("missing required field 'services' (array)");
  } else if (!Array.isArray(services)) {
    problems.push(
      `'services' must be an array, got ${pyTypeName(services)}`,
    );
  } else {
    const seen = new Set<unknown>();
    services.forEach((service, index) => {
      serviceDiagnostics(problems, index, service, root, seen);
    });
  }
  return problems;
}

function serviceDiagnostics(
  problems: string[],
  index: number,
  service: unknown,
  root: string,
  seen: Set<unknown>,
): void {
  const where = `services[${index}]`;
  if (!isDict(service)) {
    problems.push(`${where} must be an object`);
    return;
  }
  for (const key of dictKeys(service)) {
    if (!SERVICE_KEYS.has(key)) {
      problems.push(
        `${where}: unexpected field ${pyRepr(key)}; allowed fields are` +
          ` ${[...SERVICE_KEYS].sort().join(', ')} (additionalProperties:` +
          ' false, so credential values and machine paths cannot hide)',
      );
    }
  }
  const sid = dictGet(service, 'id');
  if (!dictHas(service, 'id')) {
    problems.push(`${where}: missing required field 'id'`);
  } else if (typeof sid !== 'string' || !ID.test(sid)) {
    problems.push(
      `${where}.id ${pyRepr(sid)} must match ^[a-z][a-z0-9-]*$; it is the` +
        ' stable service identity, distinct from any client registration name',
    );
  } else if (seen.has(sid)) {
    problems.push(
      `${where}.id ${pyRepr(sid)} duplicates an earlier service; ids must be` +
        ' unique',
    );
  } else {
    seen.add(sid);
  }
  const purpose = dictGet(service, 'purpose');
  if (!dictHas(service, 'purpose')) {
    problems.push(`${where}: missing required field 'purpose'`);
  } else if (typeof purpose !== 'string') {
    problems.push(`${where}.purpose must be a string`);
  } else if (!VISIBLE_TEXT.test(purpose)) {
    problems.push(`${where}.purpose must be a non-empty string`);
  }
  const required = dictGet(service, 'required');
  if (!dictHas(service, 'required')) {
    problems.push(`${where}: missing required field 'required'`);
  } else if (typeof required !== 'boolean') {
    problems.push(
      `${where}.required must be a boolean, got ${pyRepr(required)}`,
    );
  }
  const workflows = dictGet(service, 'workflows');
  if (!dictHas(service, 'workflows')) {
    problems.push(`${where}: missing required field 'workflows'`);
  } else if (!Array.isArray(workflows)) {
    problems.push(`${where}.workflows must be an array`);
  } else if (workflows.length === 0) {
    problems.push(
      `${where}.workflows must name at least one workflow; use ["*"]` +
        ' for project-wide applicability',
    );
  } else {
    for (const entry of workflows) {
      if (typeof entry !== 'string' || !WORKFLOW.test(entry)) {
        problems.push(
          `${where}.workflows entry ${pyRepr(entry)} must be '*' or match` +
            ' ^[a-z][a-z0-9-]*$',
        );
      }
    }
  }
  if (!dictHas(service, 'guidance')) {
    problems.push(`${where}: missing required field 'guidance'`);
  } else {
    guidanceDiagnostics(problems, where, dictGet(service, 'guidance'), root);
  }
  if (dictHas(service, 'connection')) {
    connectionDiagnostics(problems, where, dictGet(service, 'connection'));
  }
  if (dictHas(service, 'credential_refs')) {
    credentialRefsDiagnostics(
      problems,
      where,
      dictGet(service, 'credential_refs'),
    );
  }
  if (!dictHas(service, 'verification')) {
    problems.push(`${where}: missing required field 'verification'`);
  } else {
    verificationDiagnostics(problems, where, dictGet(service, 'verification'));
  }
}

function guidanceDiagnostics(
  problems: string[],
  where: string,
  guidance: unknown,
  root: string,
): void {
  if (!Array.isArray(guidance)) {
    problems.push(
      `${where}.guidance must be an array of repo-relative` +
        ' documentation paths',
    );
    return;
  }
  if (guidance.length === 0) {
    problems.push(
      `${where}.guidance must name at least one existing project` +
        ' document (references, not copies)',
    );
    return;
  }
  for (const entry of guidance) {
    if (typeof entry !== 'string' || entry === '') {
      problems.push(
        `${where}.guidance entries must be non-empty strings,` +
          ` got ${pyRepr(entry)}`,
      );
      continue;
    }
    if (unsafeReference(entry)) {
      problems.push(
        `${where}.guidance ${pyRepr(entry)} must be a normalized` +
          " repo-relative path — no absolute paths, '..' or control" +
          ' characters',
      );
      continue;
    }
    if (!existsSync(join(root, entry))) {
      problems.push(
        `${where}.guidance ${pyRepr(entry)} does not resolve in the` +
          ' repository; create the document or fix the reference',
      );
    }
  }
}

// PosixPath.parts/as_posix for the repo-relative references validated here:
// collapse empty and '.' segments, keep '..', absolute when leading '/'.
function purePosixParts(reference: string): string[] {
  return reference.split('/').filter((part) => part !== '' && part !== '.');
}

function purePosixAsPosix(reference: string): string {
  if (reference === '') return '.';
  const joined = purePosixParts(reference).join('/');
  if (reference.startsWith('/')) {
    return reference.startsWith('//') ? `//${joined}` : `/${joined}`;
  }
  return joined === '' ? '.' : joined;
}

function unsafeReference(reference: string): boolean {
  if ([...reference].some((c) => (c.codePointAt(0) ?? 0) < 32)) return true;
  return (
    reference.startsWith('/') ||
    purePosixParts(reference).length === 0 ||
    purePosixParts(reference).includes('..') ||
    purePosixAsPosix(reference) !== reference
  );
}

function connectionDiagnostics(
  problems: string[],
  where: string,
  connection: unknown,
): void {
  if (!isDict(connection)) {
    problems.push(`${where}.connection must be an object`);
    return;
  }
  for (const key of dictKeys(connection)) {
    if (!CONNECTION_KEYS.has(key)) {
      problems.push(
        `${where}.connection: unexpected field ${pyRepr(key)}; allowed fields` +
          ` are ${[...CONNECTION_KEYS].sort().join(', ')}`,
      );
    }
  }
  const kind = dictGet(connection, 'type');
  if (kind !== 'remote' && kind !== 'stdio') {
    problems.push(
      `${where}.connection.type must be 'remote' or 'stdio',` +
        ` got ${pyRepr(kind)}`,
    );
    return;
  }
  if (kind === 'remote') {
    if (dictHas(connection, 'command_ref')) {
      problems.push(
        `${where}.connection: 'command_ref' applies only to type` +
          " 'stdio'",
      );
    }
    const hasUrl = dictHas(connection, 'url');
    const hasLocal = dictHas(connection, 'local_config_ref');
    if (hasUrl === hasLocal) {
      problems.push(
        `${where}.connection: a remote service declares exactly one of` +
          " 'url' (an https endpoint) or 'local_config_ref' (separately" +
          ' configured machine-local connection details)',
      );
    }
    if (hasUrl) urlDiagnostics(problems, where, dictGet(connection, 'url'));
    if (hasLocal) localConfigDiagnostics(problems, where, connection);
    if (dictHas(connection, 'auth')) {
      authDiagnostics(problems, where, dictGet(connection, 'auth'));
    }
  } else {
    for (const key of ['url', 'auth']) {
      if (dictHas(connection, key)) {
        problems.push(
          `${where}.connection: ${pyRepr(key)} applies only to type` +
            " 'remote'",
        );
      }
    }
    const ref = dictGet(connection, 'command_ref');
    if (!dictHas(connection, 'command_ref')) {
      problems.push(
        `${where}.connection: a stdio service needs 'command_ref'` +
          ' naming an environment variable or machine-local setting' +
          ' that holds the executable command — never the command or' +
          ' its path',
      );
    } else if (typeof ref !== 'string' || !NAME.test(ref)) {
      problems.push(
        `${where}.connection.command_ref ${pyRepr(ref)} must be a name` +
          ' matching ^[A-Za-z][A-Za-z0-9_.-]*$ — the environment' +
          ' variable or machine-local setting holding the executable' +
          ' command, never the command, its path or a command line',
      );
    }
    localConfigDiagnostics(problems, where, connection);
  }
}

function urlDiagnostics(
  problems: string[],
  where: string,
  url: unknown,
): void {
  if (typeof url !== 'string') {
    problems.push(`${where}.connection.url must be a string`);
    return;
  }
  if (!url.startsWith('https://')) {
    problems.push(`${where}.connection.url ${pyRepr(url)} must be an https URL`);
    return;
  }
  const rest = url.slice('https://'.length);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const colonIndex = authority.indexOf(':');
  const colon = colonIndex !== -1;
  const host = colon ? authority.slice(0, colonIndex) : authority;
  const port = colon ? authority.slice(colonIndex + 1) : '';
  if (authority.includes('[') || authority.includes(']')) {
    problems.push(
      `${where}.connection.url ${pyRepr(url)} is not a valid URL; bracketed` +
        ' hosts are not supported — use a hostname or' +
        " 'local_config_ref'",
    );
  } else if (authority.includes('@')) {
    problems.push(
      `${where}.connection.url ${pyRepr(url)} must not embed credentials; use` +
        " 'credential_refs' to name the environment variable instead",
    );
  } else if (colon && port.includes(':')) {
    problems.push(
      `${where}.connection.url ${pyRepr(url)} is not a valid URL; the host` +
        " takes at most one ':port' suffix",
    );
  } else if (colon && !PORT.test(port)) {
    problems.push(
      `${where}.connection.url ${pyRepr(url)} is not a valid URL; the port` +
        ' must be numeric when present',
    );
  } else if (!HOSTNAME.test(host)) {
    problems.push(
      `${where}.connection.url ${pyRepr(url)} is not a valid URL; the host` +
        ' must be a dot-separated ASCII hostname of letters, digits,' +
        ' hyphens and underscores — bracketed or internationalized' +
        ' hosts belong in the machine-local details a' +
        " 'local_config_ref' points at",
    );
  } else if (rest.includes('?') || rest.includes('#')) {
    problems.push(
      `${where}.connection.url ${pyRepr(url)} must not carry a query string or` +
        ' fragment — parameterized endpoints belong to the machine-local' +
        " details a 'local_config_ref' points at",
    );
  } else {
    try {
      // Only parser-rejection (e.g. NFKC netloc normalization) remains;
      // the grammar above already fixed hostname and port semantics.
      urlsplitMayRaise(url);
    } catch {
      problems.push(`${where}.connection.url ${pyRepr(url)} is not a valid URL`);
    }
  }
}

/**
 * The remaining `urlsplit(url)` call from the Python original. CPython strips
 * `\t`, `\r` and `\n` before splitting, then only rejects netlocs that are
 * non-ASCII or contain unmatched/invalid brackets — the hostname and port
 * grammar above restricts the authority to ASCII letters, digits, `.`, `_`,
 * `-` and at most one `:` separator, so nothing reaching this point raises.
 * Kept as a function so the port preserves the original's structure.
 */
function urlsplitMayRaise(url: string): void {
  const cleaned = url.replace(/[\t\r\n]/g, '');
  const netloc = cleaned.slice('https://'.length).split(/[/?#]/)[0];
  if (netloc.includes('[') || netloc.includes(']')) {
    throw new ValueError('Invalid IPv6 URL');
  }
}

function localConfigDiagnostics(
  problems: string[],
  where: string,
  connection: Dict,
): void {
  if (!dictHas(connection, 'local_config_ref')) return;
  const ref = dictGet(connection, 'local_config_ref');
  if (typeof ref !== 'string' || ref === '') {
    problems.push(
      `${where}.connection.local_config_ref must be a non-empty pointer` +
        ' to separately configured local connection details',
    );
  } else if (
    [...ref].some((c) => (c.codePointAt(0) ?? 0) < 32) ||
    ref.startsWith('/') ||
    ref.startsWith('~') ||
    ref.includes('\\') ||
    MACHINE_PATH.test(ref)
  ) {
    problems.push(
      `${where}.connection.local_config_ref ${pyRepr(ref)} must not be an` +
        ' absolute or machine-specific path; describe where the details' +
        ' live instead — the path itself stays on the machine',
    );
  }
}

function authDiagnostics(
  problems: string[],
  where: string,
  auth: unknown,
): void {
  if (!isDict(auth)) {
    problems.push(`${where}.connection.auth must be an object`);
    return;
  }
  for (const key of dictKeys(auth)) {
    if (key !== 'mechanism' && key !== 'credential_ref') {
      problems.push(
        `${where}.connection.auth: unexpected field ${pyRepr(key)}; allowed` +
          ' fields are mechanism, credential_ref',
      );
    }
  }
  const mechanism = dictGet(auth, 'mechanism');
  if (mechanism !== 'oauth' && mechanism !== 'api-key') {
    problems.push(
      `${where}.connection.auth.mechanism must be 'oauth' or 'api-key',` +
        ` got ${pyRepr(mechanism)}`,
    );
    return;
  }
  if (mechanism === 'oauth') {
    if (dictHas(auth, 'credential_ref')) {
      problems.push(
        `${where}.connection.auth: OAuth is an interactive flow;` +
          " 'credential_ref' applies only to 'api-key'",
      );
    }
  } else if (!dictHas(auth, 'credential_ref')) {
    problems.push(
      `${where}.connection.auth: 'api-key' needs 'credential_ref'` +
        ' naming the environment variable that holds the credential — the' +
        ' name, never the value',
    );
  } else {
    envVarDiagnostics(
      problems,
      `${where}.connection.auth.credential_ref`,
      dictGet(auth, 'credential_ref'),
    );
  }
}

function credentialRefsDiagnostics(
  problems: string[],
  where: string,
  refs: unknown,
): void {
  if (!Array.isArray(refs)) {
    problems.push(
      `${where}.credential_refs must be an array of environment-variable` +
        ' names',
    );
    return;
  }
  for (const ref of refs) {
    envVarDiagnostics(problems, `${where}.credential_refs`, ref);
  }
}

function envVarDiagnostics(
  problems: string[],
  where: string,
  ref: unknown,
): void {
  if (typeof ref !== 'string' || !ENV_VAR.test(ref)) {
    problems.push(
      `${where} entry ${pyRepr(ref)} must match ^[A-Z][A-Z0-9_]*$ — credential` +
        ' names only, never values',
    );
  }
}

function verificationDiagnostics(
  problems: string[],
  where: string,
  verification: unknown,
): void {
  if (!isDict(verification)) {
    problems.push(`${where}.verification must be an object`);
    return;
  }
  for (const key of dictKeys(verification)) {
    if (key !== 'description' && key !== 'read_only') {
      problems.push(
        `${where}.verification: unexpected field ${pyRepr(key)}; allowed` +
          ' fields are description, read_only',
      );
    }
  }
  const description = dictGet(verification, 'description');
  if (!dictHas(verification, 'description')) {
    problems.push(`${where}.verification: missing 'description'`);
  } else if (typeof description !== 'string' || !VISIBLE_TEXT.test(description)) {
    problems.push(`${where}.verification.description must be a non-empty string`);
  }
  if (!dictHas(verification, 'read_only')) {
    problems.push(`${where}.verification: missing 'read_only'`);
  } else if (dictGet(verification, 'read_only') !== true) {
    problems.push(
      `${where}.verification.read_only must be literally true; this` +
        ' contract declares bounded read-only checks only',
    );
  }
}

/** Whether a service requirement covers `workflow`. */
export function applies(service: Dict, workflow: string): boolean {
  const workflows = req(service, 'workflows');
  return pyContains(workflows, '*') || pyContains(workflows, workflow);
}

/**
 * Prerequisites of one service a machine descriptor does not satisfy.
 *
 * `machine` is caller-supplied synthetic data describing one machine:
 *
 * - `env`: environment-variable names present there (credential names,
 *   and names holding executable commands or settings).
 * - `local_config_refs`: `local_config_ref` and `command_ref` pointers
 *   that resolve there. A mapping may carry the resolved details (endpoint,
 *   credential env-var name, launch command) for the caller's reporting;
 *   the values stay machine-local and are never read back into the
 *   manifest.
 * - `registrations`: mapping of service id to the client registration
 *   name(s) providing it. Registration names need not equal the service id;
 *   an existing `basic_memory_nas` entry satisfies id `basic-memory`.
 *
 * Returns a list of unmet prerequisite descriptions; empty means the
 * machine provides the service.
 */
export function unmet(service: Dict, machine: Dict): string[] {
  const registrations = pyGet(machine, 'registrations', {});
  if (pyContains(registrations, req(service, 'id'))) {
    return []; // native configuration provides this service id already
  }
  const env = pySet(pyGet(machine, 'env', []));
  const local = pySet(pyGet(machine, 'local_config_refs', []));
  const missing: string[] = [];
  const connection = pyGet(service, 'connection');
  if (connection === undefined || connection === null) {
    missing.push(
      'no client registration bound to this service id and the service' +
        " declares no connection — register it natively or declare" +
        " 'connection'",
    );
  } else if (req(connection, 'type') === 'remote') {
    const remote = connection as Dict;
    if (dictHas(remote, 'local_config_ref')) {
      const ref = req(remote, 'local_config_ref');
      if (!pySetHas(local, ref)) {
        missing.push(
          `local_config_ref ${pyRepr(ref)}: separately configured` +
            ' machine-local connection details not present',
        );
      }
    }
    // `connection.get("auth") or {}` — falsy auth becomes {}; a truthy
    // non-dict makes Python's auth.get raise AttributeError.
    const authValue = pyGet(remote, 'auth');
    const auth = pyTruthy(authValue) ? authValue : {};
    if (!isDict(auth)) {
      throw new AttributeError(
        `'${pyTypeName(auth)}' object has no attribute 'get'`,
      );
    }
    if (
      dictGet(auth, 'mechanism') === 'api-key' &&
      !pySetHas(env, req(auth, 'credential_ref'))
    ) {
      missing.push(
        `credential_ref ${pyStr(req(auth, 'credential_ref'))}: environment` +
          ' variable not present',
      );
    }
  } else {
    const stdio = connection as Dict;
    const ref = req(stdio, 'command_ref');
    if (!pySetHas(env, ref) && !pySetHas(local, ref)) {
      missing.push(
        `command_ref ${pyRepr(ref)}: no environment variable or` +
          ' machine-local setting holding the executable command',
      );
    }
    if (dictHas(stdio, 'local_config_ref')) {
      const other = req(stdio, 'local_config_ref');
      if (!pySetHas(local, other)) {
        missing.push(
          `local_config_ref ${pyRepr(other)}: separately configured` +
            ' machine-local connection details not present',
        );
      }
    }
  }
  const credentialRefs = pyGet(service, 'credential_refs', []);
  for (const ref of pyIterate(credentialRefs)) {
    if (!pySetHas(env, ref)) {
      missing.push(
        `credential_ref ${pyStr(ref)}: environment variable not present`,
      );
    }
  }
  return missing;
}

/**
 * Readiness verdict for one workflow on a described machine.
 *
 * `manifest` is a validated manifest dict (see `load`) or a bare
 * services list. Required-but-unavailable services block only the workflows
 * they apply to (all of them when they declare `["*"]`); unavailable
 * optional services are reported as degraded and never block.
 */
export function readiness(
  manifest: unknown,
  machine: Dict,
  workflow: string,
): Record<string, unknown> {
  const services = isDict(manifest) ? req(manifest, 'services') : manifest;
  const blocked: Dict[] = [];
  const degraded: Dict[] = [];
  const satisfied: unknown[] = [];
  for (const service of pyIterate(services)) {
    const serviceDict = service as Dict;
    if (!applies(serviceDict, workflow)) continue;
    const missing = unmet(serviceDict, machine);
    if (missing.length === 0) {
      satisfied.push(req(serviceDict, 'id'));
    } else if (req(serviceDict, 'required')) {
      blocked.push({ id: req(serviceDict, 'id'), unmet: missing });
    } else {
      degraded.push({ id: req(serviceDict, 'id'), unmet: missing });
    }
  }
  return {
    workflow,
    ready: blocked.length === 0,
    blocked,
    degraded,
    satisfied,
  };
}
