/**
 * Generated project-scope Basic Memory client connections (issue #100).
 *
 * `[connection] clients = [...]` in the reviewed routing input opts a
 * consumer into generated, git-ignored project-scope connection files. The
 * endpoint and the credential's environment-variable NAME live in one
 * machine-local profile outside the checkout; the generated files never
 * carry a credential value.
 *
 * A selected client's connection file is either GENERATED (untracked and
 * git-ignored; generation-equality governs) or CONSUMER-OWNED (git-tracked
 * or otherwise hand-maintained; never written). Consumer-owned files are
 * validated through the alignment path, which reuses the client-file
 * inspection the Python module defers to `mcp_configure` — ported here as
 * the private `inspectClient`/`equivalentUrl` subset (issue #116 ports the
 * full `mcp_configure` module and may unify).
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  parse as tomlParse,
  TomlDate,
  TomlError,
} from './vendor/smol-toml/index.js';
import { atomicWrite } from './lib/atomic.ts';
import { runGit } from './lib/git.ts';
import { pyJson } from './lib/pyjson.ts';
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
import { pyFloatRepr, pyStrRepr, pyTypeName } from './lib/pyrepr.ts';
import { pyUrlsplit } from './lib/pyurl.ts';
import type { InspectEntry } from './mcp_configure.ts';

// --- Python value semantics ----------------------------------------------------
//
// The helpers below mirror the ones `mcp_requirements.ts` carries privately;
// parsed JSON objects arrive as `Map`s (plain objects cannot keep Python's
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
export function pyTruthy(value: unknown): boolean {
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
function pyEq(a: unknown, b: unknown): boolean {
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

/** `for x in value` over the containers Python iterates. */
function pyIterate(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isDict(value)) return dictKeys(value);
  if (typeof value === 'string') return [...value];
  throw new PyTypeError(`'${pyTypeName(value)}' object is not iterable`);
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
  if (isDict(container)) {
    return typeof item === 'string' && dictHas(container, item);
  }
  throw new PyTypeError(
    `argument of type '${pyTypeName(container)}' is not iterable`,
  );
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

// --- Serialization ------------------------------------------------------------

const JSON_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

function escapeJsonString(value: string): string {
  let out = '"';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const code = char.charCodeAt(0);
    const short = JSON_ESCAPES[char];
    if (short !== undefined) out += short;
    else if (code < 0x20 || code >= 0x7f) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += char;
  }
  return out + '"';
}

function serializeOrdered(
  value: unknown,
  level: number,
  indent: number | undefined,
  sorted: boolean,
): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) {
      return value < 0 ? '-Infinity' : 'Infinity';
    }
    if (Object.is(value, -0)) return '-0.0';
    return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  }
  if (typeof value === 'bigint') return String(value);
  if (value instanceof PyFloat) {
    const v = value.value;
    if (Number.isNaN(v)) return 'NaN';
    if (!Number.isFinite(v)) return v < 0 ? '-Infinity' : 'Infinity';
    return pyFloatRepr(v);
  }
  if (typeof value === 'string') return escapeJsonString(value);
  const pair = (key: string, member: unknown): string =>
    `${escapeJsonString(key)}: ${serializeOrdered(member, level + 1, indent, sorted)}`;
  const joinItems = (open: string, close: string, items: string[]): string => {
    if (indent === undefined) return open + items.join(', ') + close;
    const pad = ' '.repeat(indent * (level + 1));
    const closing = ' '.repeat(indent * level);
    return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${closing}${close}`;
  };
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return joinItems(
      '[',
      ']',
      value.map((v) => serializeOrdered(v, level + 1, indent, sorted)),
    );
  }
  if (value instanceof Map) {
    let entries = [...value.entries()];
    if (sorted) {
      entries = entries.sort(([left], [right]) =>
        compareCodePoints(left, right),
      );
    }
    const items = entries.map(([k, v]) => pair(k, v));
    if (items.length === 0) return '{}';
    return joinItems('{', '}', items);
  }
  if (typeof value === 'object') {
    let keys = Object.keys(value);
    if (sorted) keys = keys.sort(compareCodePoints);
    const items = keys.map((key) =>
      pair(key, (value as Record<string, unknown>)[key]),
    );
    if (items.length === 0) return '{}';
    return joinItems('{', '}', items);
  }
  throw new PyTypeError(
    `Object of type ${pyTypeName(value)} is not JSON serializable`,
  );
}

/**
 * `json.dumps(value, indent=2)` — unlike `pyJson`, dict order is the
 * insertion order Python preserves through `json.loads`/`json.dumps`,
 * which the merge paths depend on byte-for-byte.
 */
export function jsonDumps(value: unknown): string {
  return serializeOrdered(value, 0, 2, false);
}

/**
 * `json.dumps(value)` — default separators `(', ', ': ')` with insertion
 * order preserved, the shape `setup_memory.policy` embeds in generated
 * instructions.
 */
export function jsonDumpsDefault(value: unknown): string {
  return serializeOrdered(value, 0, undefined, false);
}

/**
 * `json.dumps(value, sort_keys=True)` — default separators `(', ', ': ')`,
 * a mode pyJson does not cover; the alignment instructions embed it.
 */
export function jsonDumpsSorted(value: unknown): string {
  return serializeOrdered(value, 0, undefined, true);
}

// --- Decoding -----------------------------------------------------------------

/** `json.loads` raising `ValueError` carrying the CPython error text. */
function jsonLoads(text: string): unknown {
  const error = jsonLoadsError(text);
  if (error !== null) {
    throw new ValueError(jsonLoadsErrorMessage(text, error));
  }
  return pyJsonLoads(text);
}

/**
 * `tomllib.loads` through the vendored smol-toml parser. Parse verdicts
 * and values are CPython-compatible: accepted documents are re-scanned
 * by `tomllibCompatCheck`, which raises `ValueError` on the constructs
 * smol-toml accepts but `tomllib` rejects. Embedded diagnostic wording
 * is smol-toml's or the check's and is allowed difference 3 in
 * docs/node-port.md. Do not translate it into `tomllib` sentences.
 */
export function tomlLoads(text: string): Record<string, unknown> {
  let data: Record<string, unknown>;
  try {
    data = tomlParse(text, { integersAsBigInt: true }) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (error instanceof TomlError) {
      const short = error.message.split('\n')[0];
      throw new ValueError(
        `${short} (at line ${error.line}, column ${error.column})`,
      );
    }
    throw error;
  }
  tomllibCompatCheck(text);
  return data;
}

// --- `tomllib` verdict compatibility ---------------------------------------
//
// smol-toml 1.9.1 accepts documents CPython 3.12 `tomllib` rejects, so
// `tomlLoads` re-scans every accepted document for those constructs and
// raises `ValueError`; every load path in this module shares `tomllib`'s
// verdict while parsed values still come from smol-toml. The covered
// classes:
//
// - inline tables spanning a newline — any raw `\n`/`\r` between `{`
//   and its `}` outside strings — or carrying a trailing comma;
// - `\e` and `\x` escapes in basic strings, including quoted keys;
//   `tomllib` accepts only `\b \t \n \f \r \" \\ \uXXXX \UXXXXXXXX`
//   while smol-toml maps `\e` to ESC and reads `\x` as a two-digit
//   Unicode escape;
// - local times without a seconds field (`10:00`, including inside
//   datetimes) — `tomllib` requires `HH:MM:SS`;
// - calendar values JavaScript's `Date` normalizes where `datetime`
//   raises: `1979-02-29`, `0000-01-01` and friends roll over.
//
// The document already parsed, so the scan only lexes strings, comments,
// bare atoms and the `{}`/`[]` nesting — it does not re-validate grammar.

/** Escape characters `tomllib` allows after `\` in a basic string. */
const TOML_BASIC_ESCAPES = new Set('btnfr"\\uU');

/**
 * `tomllib`'s datetime grammar minus the space separator — a
 * space-separated pair is validated in two steps below. Offsets and
 * ranges are regex-bound so a full match only needs the calendar check.
 */
const TOML_DATETIME =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:[Tt]([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6}\d*)?(?:(?:[Zz])|(?:[+-])([01]\d|2[0-3]):([0-5]\d))?)?$/;
/** The time half of a space-separated datetime (offset allowed). */
const TOML_DATETIME_TIME =
  /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6}\d*)?(?:(?:[Zz])|(?:[+-])([01]\d|2[0-3]):([0-5]\d))?$/;
/** `tomllib`'s local-time grammar: seconds are required. */
const TOML_LOCALTIME =
  /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6}\d*)?$/;
const TOML_DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;
const TOML_TIME_LIKE = /^\d{2}:\d{2}/;
/** Characters that terminate a bare TOML value token. */
const TOML_ATOM_END = /[\s,#[\]{}"'=]/;

/** Line/column for `pos`, computed like smol-toml's `TomlError`. */
function tomlLineColumn(text: string, pos: number): [number, number] {
  const before = text.slice(0, pos).split(/\r?\n/);
  return [before.length, before[before.length - 1].length + 1];
}

function tomlCompatReject(text: string, pos: number, reason: string): never {
  const [line, column] = tomlLineColumn(text, pos);
  throw new ValueError(
    `Invalid TOML document: ${reason} (at line ${line}, column ${column})`,
  );
}

/** Days in `month` of `year`, matching `datetime`'s calendar rules. */
function tomlDaysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * Scan a string token starting at `start` (`'` or `"`, single-line or
 * triple-quoted) and return the index after its closing delimiter.
 * Basic strings are checked for escapes `tomllib` rejects.
 */
function scanTomlString(text: string, start: number): number {
  const quote = text.charCodeAt(start);
  const multiline =
    text.charCodeAt(start + 1) === quote &&
    text.charCodeAt(start + 2) === quote;
  let i = start + (multiline ? 3 : 1);
  if (multiline) {
    // The first newline after the opening delimiter is trimmed.
    if (text.charCodeAt(i) === 0x0a) i += 1;
    else if (text.charCodeAt(i) === 0x0d && text.charCodeAt(i + 1) === 0x0a)
      i += 2;
  }
  const basic = quote === 0x22;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === quote) {
      if (!multiline) return i + 1;
      if (
        text.charCodeAt(i + 1) === quote &&
        text.charCodeAt(i + 2) === quote
      ) {
        // A run of 3-5 quotes closes the string; the fourth and fifth
        // are content.
        i += 3;
        while (text.charCodeAt(i) === quote) i += 1;
        return i;
      }
      i += 1;
      continue;
    }
    if (basic && c === 0x5c /* \ */) {
      const next = text.charCodeAt(i + 1);
      const lineEscape =
        multiline &&
        (next === 0x20 ||
          next === 0x09 ||
          next === 0x0a ||
          (next === 0x0d && text.charCodeAt(i + 2) === 0x0a));
      if (!lineEscape && !TOML_BASIC_ESCAPES.has(text[i + 1] ?? '')) {
        tomlCompatReject(text, i, 'unsupported escape sequence');
      }
      i += 2;
      continue;
    }
    if (!multiline && (c === 0x0a || c === 0x0d)) return i;
    i += 1;
  }
  return i;
}

/**
 * Scan a `[table]` or `[[array]]` header at `start` and return the index
 * after its closing bracket(s). Quoted key parts go through the string
 * scanner so `\e`-style escapes in keys are checked.
 */
function scanTomlTableHeader(text: string, start: number): number {
  let i = start + 1;
  let closing = 1;
  if (text.charCodeAt(i) === 0x5b) {
    i += 1;
    closing = 2;
  }
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x22 || c === 0x27) {
      i = scanTomlString(text, i);
      continue;
    }
    if (c === 0x5d /* ] */) {
      i += 1;
      closing -= 1;
      if (closing === 0) return i;
      continue;
    }
    i += 1;
  }
  return i;
}

/** Index after the bare atom starting at `start`. */
function scanTomlAtomEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && !TOML_ATOM_END.test(text[i])) i += 1;
  return i;
}

/**
 * Scan a bare value token at `start`, validate date/time shapes against
 * `tomllib`'s grammar, and return the index after it. A `YYYY-MM-DD`
 * atom followed by a space and a digit is smol-toml's space-separated
 * datetime; the time atom is validated too.
 */
function scanTomlValueAtom(text: string, start: number): number {
  const end = scanTomlAtomEnd(text, start);
  const atom = text.slice(start, end);
  const reject = (pos: number): never =>
    tomlCompatReject(text, pos, 'invalid date, datetime or time value');
  if (TOML_DATE_LIKE.test(atom)) {
    const match = TOML_DATETIME.exec(atom);
    if (match === null) reject(start);
    else {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      if (year === 0 || day > tomlDaysInMonth(year, month)) reject(start);
      if (
        match[4] === undefined &&
        text[end] === ' ' &&
        text.charCodeAt(end + 1) >= 0x30 &&
        text.charCodeAt(end + 1) <= 0x39
      ) {
        // Space-separated datetime: the second atom must be a full
        // time.
        const timeEnd = scanTomlAtomEnd(text, end + 1);
        if (!TOML_DATETIME_TIME.test(text.slice(end + 1, timeEnd))) {
          reject(end + 1);
        }
        return timeEnd;
      }
    }
  } else if (TOML_TIME_LIKE.test(atom) && !TOML_LOCALTIME.test(atom)) {
    reject(start);
  }
  return end;
}

/**
 * Reject an accepted document when `tomllib` would reject it — see the
 * section comment for the covered constructs.
 */
function tomllibCompatCheck(text: string): void {
  const stack: ('a' | 'i')[] = [];
  let mode: 'stmt' | 'key' | 'ikey' | 'value' | 'sep' = 'stmt';
  let afterComma = false;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x20 || c === 0x09) {
      i += 1;
      continue;
    }
    if (c === 0x23 /* # */) {
      while (i < text.length && text.charCodeAt(i) !== 0x0a) i += 1;
      continue;
    }
    if (c === 0x0a || c === 0x0d) {
      // Only the innermost container matters: a newline inside an array
      // nested in an inline table is legal because the array's parser
      // consumes it.
      if (stack[stack.length - 1] === 'i') {
        tomlCompatReject(
          text,
          i,
          'newlines are not allowed inside inline tables',
        );
      }
      i += c === 0x0d && text.charCodeAt(i + 1) === 0x0a ? 2 : 1;
      if (stack.length === 0) mode = 'stmt';
      else if (stack[stack.length - 1] === 'a') mode = 'value';
      continue;
    }
    switch (mode) {
      case 'stmt': {
        if (c === 0x5b /* [ */) {
          i = scanTomlTableHeader(text, i);
          mode = 'sep';
        } else {
          mode = 'key';
        }
        break;
      }
      case 'key': {
        if (c === 0x3d /* = */) {
          i += 1;
          mode = 'value';
        } else if (c === 0x22 || c === 0x27) {
          i = scanTomlString(text, i);
        } else {
          i += 1;
        }
        break;
      }
      case 'ikey': {
        if (c === 0x7d /* } */) {
          if (afterComma) {
            tomlCompatReject(
              text,
              i,
              'trailing commas are not allowed inside inline tables',
            );
          }
          stack.pop();
          i += 1;
          mode = 'sep';
        } else if (c === 0x3d) {
          i += 1;
          afterComma = false;
          mode = 'value';
        } else if (c === 0x22 || c === 0x27) {
          afterComma = false;
          i = scanTomlString(text, i);
        } else {
          afterComma = false;
          i += 1;
        }
        break;
      }
      case 'value': {
        if (c === 0x7b /* { */) {
          stack.push('i');
          afterComma = false;
          i += 1;
          mode = 'ikey';
        } else if (c === 0x5b /* [ */) {
          stack.push('a');
          i += 1;
        } else if (c === 0x22 || c === 0x27) {
          i = scanTomlString(text, i);
          mode = 'sep';
        } else if (c === 0x5d /* ] */ && stack[stack.length - 1] === 'a') {
          stack.pop();
          i += 1;
          mode = 'sep';
        } else if (c === 0x2c || c === 0x3d || c === 0x7d) {
          // Not a value start; unreachable for accepted documents.
          i += 1;
        } else {
          i = scanTomlValueAtom(text, i);
          mode = 'sep';
        }
        break;
      }
      case 'sep': {
        if (c === 0x2c /* , */) {
          i += 1;
          if (stack[stack.length - 1] === 'i') {
            mode = 'ikey';
            afterComma = true;
          } else {
            mode = 'value';
          }
        } else if (c === 0x5d && stack[stack.length - 1] === 'a') {
          stack.pop();
          i += 1;
        } else if (c === 0x7d && stack[stack.length - 1] === 'i') {
          stack.pop();
          i += 1;
        } else {
          // Unreachable for accepted documents.
          i += 1;
        }
        break;
      }
    }
  }
}

/** Whether `error` is one of the Python `OSError` subclasses. */
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
 * deepest existing ancestor and append the remaining components. The
 * paths this module resolves (the consumer root and files directly
 * beneath it) never carry `..` past a symlink boundary.
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

/** `path.parents` — every ancestor from the immediate parent to `/`. */
function pathParents(path: string): string[] {
  const parents: string[] = [];
  let current = dirname(path);
  for (;;) {
    parents.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return parents;
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

/**
 * `str.splitlines()` — Python splits on `\n` plus the other ASCII and
 * Unicode line boundaries `splitlines` recognizes.
 */
function pySplitlines(text: string): string[] {
  const parts = text.split(/[\n\x0b\f\x1c-\x1e\x85\u2028\u2029]/);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** `re.fullmatch(pattern, value or '')` with Python's TypeError on non-str. */
function fullmatchOrEmpty(
  pattern: RegExp,
  value: unknown,
): RegExpExecArray | null {
  const text = pyTruthy(value) ? value : '';
  if (typeof text !== 'string') {
    throw new PyTypeError(
      `expected string or bytes-like object,` +
        ` got ${pyStrRepr(pyTypeName(text))}`,
    );
  }
  return pattern.exec(text);
}

// --- Module constants -----------------------------------------------------------

export const CONNECTION_CLIENTS = ['claude', 'codex', 'opencode'] as const;
export const CONNECTION_PATHS: Record<string, string> = {
  claude: '.mcp.json',
  codex: '.codex/config.toml',
  opencode: 'opencode.json',
};
export const CONNECTION_IGNORE: Record<string, string> = Object.fromEntries(
  Object.entries(CONNECTION_PATHS).map(([client, path]) => [
    client,
    `/${path}`,
  ]),
);
export const CONNECTION_MARKER =
  /<!-- agent-workflows:memory-connections: ([a-z]+(?: [a-z]+)*) -->/;
// Ownership record for helper-generated entries. An existing entry may be
// updated only while it still equals what the helper wrote; a hand-written
// entry can share the generated shape, so shape alone never proves ownership.
export const CONNECTION_STATE = '.agents/memory/connections.json';
export const CONNECTION_STATE_IGNORE = `/${CONNECTION_STATE}`;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Variable names some clients resolve as their own credential; a remote
// header would then send the client's login instead of the Basic Memory
// token, or an empty value. The list mirrors the client guides; it is not
// exhaustive.
const RESERVED_TOKEN_VARS = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BEARER_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_AUTH_TOKEN',
  'CODEX_API_KEY',
]);
export const T3_CONFIG = '.agent-workflows-t3.json';
export const DEFAULT_CONN_REPAIR =
  'node .agent-workflows/bin/agent-workflows.ts ' +
  'setup_memory_connections --project .';
export const DEFAULT_SETUP_REPAIR =
  'node .agent-workflows/bin/agent-workflows.ts setup_memory --project .';
export const DEFAULT_RECONCILE =
  'node .agent-workflows/bin/agent-workflows.ts t3_readiness --project .' +
  ' --reconcile-routing-source';
export let OPENCODE_ETC = '/etc/opencode';
export const CLAUDE_MANAGED_SETTINGS = '/etc/claude-code/managed-settings.json';

/** Test seam: `mock.patch.object(connections, 'OPENCODE_ETC', path)`. */
export function setOpencodeEtcForTesting(path: string): void {
  OPENCODE_ETC = path;
}

// `memory_connections.atomic`, swappable for the tests that inject
// failures — module internals call `atomic` like the Python code does.
let atomicImpl: (path: string, text: string) => void = atomicWrite;

/** Test seam: `mock.patch.object(connections, 'atomic', fake)`. */
export function setAtomicForTesting(
  implementation?: (path: string, text: string) => void,
): void {
  atomicImpl = implementation ?? atomicWrite;
}

export function atomic(path: string, text: string): void {
  atomicImpl(path, text);
}

// --- Paths and profiles ---------------------------------------------------------

export function contained(root: string, path: string): string {
  const resolved = resolvePath(path);
  if (!isRelativeTo(root, resolved) || resolved === root) {
    throw new ValueError(`Setup path escapes the consumer root: ${resolved}`);
  }
  return resolved;
}

/** Selected connection clients from validated routing (possibly empty). */
export function connectionClients(data: unknown): unknown[] {
  const conn = pyGet(data, 'connection');
  const connection = pyTruthy(conn) ? conn : {};
  const clients = pyGet(connection, 'clients');
  return pyIterate(pyTruthy(clients) ? clients : []);
}

/** Generated config.md paragraph + machine-readable selection marker. */
export function connectionGuidance(clients: string[]): string {
  const names = clients.map((client) => `\`${client}\``).join(', ');
  return `Project-scope MCP connection files for ${names} are generated from
this machine's local connection profile; they are git-ignored, regenerated per
checkout, and never contain a credential value. Regenerate or verify them with
the library's \`setup_memory_connections\` (\`--check\` reports drift, shadowing
and missing prerequisites such as the machine profile, Codex project trust or
the Claude approval prompt).
<!-- agent-workflows:memory-connections: ${clients.join(' ')} -->
`;
}

/** The one machine-local connection profile, outside every checkout. */
export function defaultProfilePath(home?: string): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || join(home || homedir(), '.config');
  return join(base, 'agent-workflows', 'memory-connection.toml');
}

/** Read the machine connection profile; never creates or edits it. */
export function loadProfile(path: string): Record<string, unknown> {
  if (!isFile(path)) {
    throw new ValueError(
      `Missing machine connection profile: ${path}; each machine needs` +
        ' one reviewed profile holding the service endpoint and, when the' +
        ' service needs a bearer token, the environment-variable NAME the' +
        ' client reads — never the token value. See' +
        ' docs/memory/connections.md',
    );
  }
  let data: unknown;
  try {
    data = tomlLoads(readText(path));
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    throw new ValueError(
      `Unreadable machine connection profile ${path}: ${errorText(error)};` +
        ' preserve and review',
    );
  }
  if (
    !isDict(data) ||
    !['schema_version', 'endpoint'].every((key) => dictHas(data, key)) ||
    !dictKeys(data).every((key) =>
      ['schema_version', 'endpoint', 'bearer_token_env'].includes(key),
    )
  ) {
    throw new ValueError(
      `Invalid machine connection profile ${path}: expected` +
        ' schema_version, endpoint and an optional bearer_token_env',
    );
  }
  if (!pyEq(dictGet(data, 'schema_version'), 1)) {
    throw new ValueError(
      `Invalid machine connection profile ${path}: expected` +
        ' schema_version = 1',
    );
  }
  const endpoint = dictGet(data, 'endpoint');
  if (typeof endpoint !== 'string') {
    throw new ValueError(
      `Invalid machine connection profile ${path}: endpoint must be a` +
        ' string',
    );
  }
  const parts = pyUrlsplit(endpoint);
  if (
    (parts.scheme !== 'http' && parts.scheme !== 'https') ||
    !parts.hostname ||
    parts.username !== null ||
    parts.password !== null
  ) {
    throw new ValueError(
      `Invalid machine connection profile ${path}: endpoint must be an` +
        ' http(s) URL and must not embed credentials (userinfo); pass' +
        ' authentication by environment-variable name only',
    );
  }
  if (
    [...endpoint].some(
      (char) =>
        (char.codePointAt(0) ?? 0) < 32 || char === '"' || char === '\\',
    )
  ) {
    throw new ValueError(
      `Invalid machine connection profile ${path}: endpoint contains` +
        ' characters that cannot be rendered safely',
    );
  }
  const env = dictGet(data, 'bearer_token_env');
  if (env !== null && env !== undefined) {
    if (typeof env !== 'string' || !ENV_VAR_NAME.test(env)) {
      throw new ValueError(
        `Invalid machine connection profile ${path}: bearer_token_env` +
          ' must be an environment-variable NAME, not a value',
      );
    }
    if (RESERVED_TOKEN_VARS.has(env)) {
      throw new ValueError(
        `Invalid machine connection profile ${path}: ${env} is a` +
          ' variable clients treat as their own credential; choose a' +
          ' Basic Memory-specific name (see docs/claude.md)',
      );
    }
  }
  return { endpoint, bearer_token_env: env ?? null };
}

// --- Generated entries -----------------------------------------------------------

export function claudeEntry(profile: Dict): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: 'http',
    url: dictGet(profile, 'endpoint'),
  };
  if (pyTruthy(dictGet(profile, 'bearer_token_env'))) {
    entry['headers'] = {
      Authorization: `Bearer \${${dictGet(profile, 'bearer_token_env')}}`,
    };
  }
  return entry;
}

export function opencodeEntry(profile: Dict): Record<string, unknown> {
  // oauth: false selects the header-only path; OAuth flows stay a separate
  // owner decision (docs/opencode.md) and are outside the generated entry.
  const entry: Record<string, unknown> = {
    type: 'remote',
    url: dictGet(profile, 'endpoint'),
    oauth: false,
  };
  if (pyTruthy(dictGet(profile, 'bearer_token_env'))) {
    entry['headers'] = {
      Authorization: `Bearer {env:${dictGet(profile, 'bearer_token_env')}}`,
    };
  }
  return entry;
}

export function codexEntry(profile: Dict): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    url: dictGet(profile, 'endpoint'),
  };
  if (pyTruthy(dictGet(profile, 'bearer_token_env'))) {
    entry['bearer_token_env_var'] = dictGet(profile, 'bearer_token_env');
  }
  return entry;
}

export function codexBlock(name: string, entry: Dict): string {
  const lines = [
    `[mcp_servers."${name}"]`,
    `url = "${dictGet(entry, 'url')}"`,
  ];
  if (dictHas(entry, 'bearer_token_env_var')) {
    lines.push(
      `bearer_token_env_var = "${dictGet(entry, 'bearer_token_env_var')}"`,
    );
  }
  return lines.join('\n') + '\n';
}

export function expectedEntry(client: string, profile: Dict): Dict {
  const builder = {
    claude: claudeEntry,
    codex: codexEntry,
    opencode: opencodeEntry,
  }[client];
  if (!builder) throw new KeyError(client);
  return builder(profile);
}

/** Selected clients whose connection file is git-tracked. */
export function consumerOwnedClients(
  root: string,
  clients: string[],
): string[] {
  return clients.filter(
    (client) => gitConnectionState(root, CONNECTION_PATHS[client])[0],
  );
}

/**
 * The machine connection profile for the current selection.
 *
 * Generation needs it, so a missing profile stays the named prerequisite
 * whenever any selected client's file is untracked. When every selected
 * file is consumer-owned (tracked) nothing is generated: an absent
 * profile degrades to structural-only alignment validation instead of
 * failing the check.
 */
export function connectionProfile(
  root: string,
  clients: string[],
  path: string,
): Record<string, unknown> | null {
  const generated = clients.filter(
    (client) => !gitConnectionState(root, CONNECTION_PATHS[client])[0],
  );
  if (generated.length === 0 && !isFile(path)) return null;
  return loadProfile(path);
}

/** Whether an existing entry matches the generated shape for a client. */
export function looksGenerated(client: string, entry: unknown): boolean {
  if (!isDict(entry)) return false;
  if (client === 'claude') {
    const headers = dictGetOr(entry, 'headers', {});
    return (
      keySubset(entry, new Set(['type', 'url', 'headers'])) &&
      dictGet(entry, 'type') === 'http' &&
      dictHas(entry, 'url') &&
      (!pyTruthy(headers) ||
        (isDict(headers) &&
          keySetEquals(headers, new Set(['Authorization'])) &&
          claudeEnvRef(dictGet(headers, 'Authorization')) !== null))
    );
  }
  if (client === 'codex') {
    return (
      keySubset(entry, new Set(['url', 'bearer_token_env_var'])) &&
      dictHas(entry, 'url')
    );
  }
  const headers = dictGetOr(entry, 'headers', {});
  return (
    keySubset(entry, new Set(['type', 'url', 'oauth', 'headers'])) &&
    dictGet(entry, 'type') === 'remote' &&
    dictHas(entry, 'url') &&
    dictGet(entry, 'oauth') === false &&
    (!pyTruthy(headers) ||
      (isDict(headers) &&
        keySetEquals(headers, new Set(['Authorization'])) &&
        opencodeEnvRef(dictGet(headers, 'Authorization')) !== null))
  );
}

const CLAUDE_ENV_REF = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const OPENCODE_ENV_REF = /^Bearer \{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function claudeEnvRef(header: unknown): string | null {
  const match = fullmatchOrEmpty(CLAUDE_ENV_REF, header);
  return match ? match[1] : null;
}

export function opencodeEnvRef(header: unknown): string | null {
  const match = fullmatchOrEmpty(OPENCODE_ENV_REF, header);
  return match ? match[1] : null;
}

function sameEndpoint(existing: unknown, endpoint: unknown): boolean {
  return isDict(existing) && dictGet(existing, 'url') === endpoint;
}

// --- Generated-entry ownership ----------------------------------------------------

/**
 * The recorded generated entries; empty when absent.
 *
 * `state` is `{server: name, entries: {client: entry}}`; entries are
 * keyed by the server name recorded at generation time so a renamed
 * `mcp_server` leaves its old entries detectable. An unreadable or
 * malformed record never proves ownership and requires explicit repair.
 */
export function readState(root: string): [Dict, string | null] {
  const empty: Dict = new Map<string, unknown>([
    ['server', null],
    ['entries', new Map<string, unknown>()],
  ]);
  const path = join(root, CONNECTION_STATE);
  if (!existsSync(path)) return [empty, null];
  let data: unknown;
  try {
    data = jsonLoads(readText(path));
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    throw new ValueError(
      'Unreadable generated-ownership record' +
        ` ${CONNECTION_STATE}: ${errorText(error)}; setup stopped — preserve and review`,
    );
  }
  if (
    !isDict(data) ||
    dictKeys(data).some((key) => key !== 'server' && key !== 'entries') ||
    !(
      typeof dictGet(data, 'server') === 'string' ||
      dictGet(data, 'server') === null ||
      dictGet(data, 'server') === undefined
    ) ||
    !isDict(dictGet(data, 'entries')) ||
    dictItems(dictGet(data, 'entries') as Dict).some(
      ([client, entry]) =>
        !(CONNECTION_CLIENTS as readonly string[]).includes(client) ||
        !isDict(entry),
    )
  ) {
    throw new ValueError(
      'Unexpected generated-ownership record shape in' +
        ` ${CONNECTION_STATE}; setup stopped — preserve and review`,
    );
  }
  return [data, null];
}

/** Record the entries the helper generated for the current selection. */
export function writeState(
  root: string,
  server: string | null,
  entries: Dict,
): void {
  atomic(
    join(root, CONNECTION_STATE),
    jsonDumps({ server, entries }) + '\n',
  );
}

/** The servers mapping of an existing client file, or null. */
export function clientServers(path: string, client: string): Dict | null {
  let servers: unknown;
  try {
    if (client === 'codex') {
      const doc = tomlLoads(readText(path));
      servers = dictGetOr(doc, 'mcp_servers', {});
    } else {
      const doc = jsonLoads(readText(path));
      servers =
        client === 'claude'
          ? dictGetOr(doc as Dict, 'mcpServers', {})
          : isDict(dictGet(doc as Dict, 'mcp'))
            ? dictGetOr(dictGet(doc as Dict, 'mcp') as Dict, 'servers', {})
            : {};
    }
  } catch (error) {
    if (isValueOrOSError(error)) return null;
    throw error;
  }
  return isDict(servers) ? servers : null;
}

/**
 * Release deselected ownership only after the recorded server is absent.
 *
 * A recorded client whose file became git-tracked is consumer-owned now:
 * the record is released regardless of the entry's content, because
 * generation can never write that file again.
 */
export function pruneCleanedOwnership(
  root: string,
  clients: string[],
  state: Dict,
  persist = false,
): Dict {
  const recordedEntries = dictGetOr(state, 'entries', {});
  const entries = new Map<string, unknown>(
    isDict(recordedEntries) ? dictItems(recordedEntries) : [],
  );
  const stateServer = dictGet(state, 'server');
  for (const client of dictKeys(entries)) {
    const [tracked] = gitConnectionState(root, CONNECTION_PATHS[client]);
    if (tracked) {
      dictDel(entries, client);
      continue;
    }
    if (clients.includes(client)) continue;
    const path = join(root, CONNECTION_PATHS[client]);
    const servers: Dict | null = existsSync(path)
      ? clientServers(path, client)
      : ({} as Dict);
    if (servers !== null && !pyContains(servers, stateServer ?? null)) {
      dictDel(entries, client);
    }
  }
  const original = isDict(recordedEntries) ? recordedEntries : {};
  if (persist && !pyDictEq(entries, original)) {
    writeState(root, (stateServer ?? null) as string | null, entries);
  }
  return dictSpread(state, 'entries', entries);
}

/**
 * (failures, warnings) for entries left behind by a deselection.
 *
 * An entry counts as a leftover only when the ownership record says the
 * helper generated it — a hand-written same-name entry is reported as an
 * unowned duplicate (warning) and never blocks another client's opt-in.
 */
export function leftoverDiagnostics(
  root: string,
  clients: string[],
  server: string | null,
  state: Dict,
): [string[], string[]] {
  const failures: string[] = [];
  const warnings: string[] = [];
  const recordedServer = dictGet(state, 'server');
  const recordedRaw = dictGet(state, 'entries');
  const recorded: Dict = pyTruthy(recordedRaw)
    ? (recordedRaw as Dict)
    : new Map<string, unknown>();
  for (const [client, relativePath] of Object.entries(CONNECTION_PATHS)) {
    const path = join(root, relativePath);
    if (!isFile(path)) continue;
    const servers = clientServers(path, client);
    if (servers === null) continue;
    const owned = dictGet(recorded, client);
    if (
      recordedServer !== null &&
      recordedServer !== undefined &&
      owned !== undefined &&
      owned !== null &&
      pyContains(servers, recordedServer) &&
      (!clients.includes(client) || recordedServer !== server)
    ) {
      const [tracked] = gitConnectionState(root, relativePath);
      if (tracked) {
        warnings.push(
          `\`${recordedServer}\` entry in tracked ${relativePath} was` +
            ' recorded as generated; the file is consumer-owned' +
            ' now — the entry is preserved and its ownership' +
            ' record released',
        );
      } else if (pyEq(dictGet(servers, recordedServer as string), owned)) {
        failures.push(
          `generated \`${recordedServer}\` entry in` +
            ` ${relativePath} (client \`${client}\`)`,
        );
      } else {
        failures.push(
          `generated \`${recordedServer}\` entry in ${relativePath} was` +
            ` modified (client \`${client}\`); preserve and review`,
        );
      }
    }
    if (
      server !== null &&
      !clients.includes(client) &&
      pyContains(servers, server) &&
      !(recordedServer === server && owned !== undefined && owned !== null)
    ) {
      warnings.push(
        `\`${server}\` entry in ${relativePath} is not recorded as generated` +
          ' — preserved; if an older revision generated it, remove it' +
          ' manually',
      );
    }
  }
  return [failures, warnings];
}

export function raiseForLeftovers(
  root: string,
  clients: string[],
  server: string | null,
  state: Dict,
  header: string,
): string[] {
  const [failures, warnings] = leftoverDiagnostics(
    root,
    clients,
    server,
    state,
  );
  if (failures.length) {
    throw new ValueError(
      `${header}:\n${failures.join('\n')}` +
        '\nRemove or reconcile them manually — the helper never deletes' +
        ' client configuration',
    );
  }
  return warnings;
}

// --- Connection file planning -----------------------------------------------------

export interface Plan {
  client: string;
  path: string;
  state: string;
  content: string | null;
  entry: unknown;
  registration: string | null;
  alignment?: Record<string, unknown>;
}

/**
 * Plan one JSON connection file against an existing file.
 *
 * `parents` walks to the servers object (`('mcpServers',)` for Claude,
 * `('mcp', 'servers')` for OpenCode v2). `owned` is the entry the
 * ownership record says the helper generated — an unchanged owned entry
 * may be regenerated ('update'), while a modified one and a foreign
 * same-name entry both refuse. `legacyParent` names a legacy sibling
 * object (OpenCode v1 `mcp.<name>`) whose same-name entry is a conflict.
 * Returns `(state, content)` with state `missing`, `merge`, `update` or
 * `current`.
 */
export function planJsonConnection(
  client: string,
  path: string,
  parents: string[],
  name: string,
  entry: Dict,
  owned: unknown = null,
  legacyParent: string | null = null,
): [string, string | null] {
  const parentName = basename(path);
  if (!existsSync(path)) {
    const doc = new Map<string, unknown>();
    let cursor: Dict = doc;
    for (const key of parents.slice(0, -1)) {
      const node = new Map<string, unknown>();
      dictSet(cursor, key, node);
      cursor = node;
    }
    dictSet(cursor, parents[parents.length - 1], new Map([[name, entry]]));
    return ['missing', jsonDumps(doc) + '\n'];
  }
  const text = readText(path);
  let doc: unknown;
  try {
    doc = jsonLoads(text);
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    let hint = '';
    try {
      parseJsonc(text);
      hint = ' it uses JSONC syntax the helper cannot rewrite safely;';
    } catch (inner) {
      if (!isValueOrOSError(inner)) throw inner;
    }
    throw new ValueError(
      `Unparseable ${parentName}: ${errorText(error)};${hint} preserve and review`,
    );
  }
  if (!isDict(doc)) {
    throw new ValueError(
      `Unexpected ${parentName} shape; preserve and review`,
    );
  }
  if (legacyParent !== null) {
    const legacy = dictGetOr(doc, legacyParent, {});
    if (isDict(legacy)) {
      const old = dictGet(legacy, name);
      if (isDict(old) && (dictHas(old, 'url') || dictHas(old, 'type'))) {
        throw new ValueError(
          `Legacy \`mcp.${name}\` entry in ${parentName} conflicts with` +
            ' the generated `mcp.servers` entry; reconcile it manually' +
            ' (see docs/opencode.md)',
        );
      }
    }
  }
  let cursor: Dict = doc;
  for (const key of parents.slice(0, -1)) {
    if (!dictHas(cursor, key)) dictSet(cursor, key, new Map<string, unknown>());
    const node = dictGet(cursor, key);
    if (!isDict(node)) {
      throw new ValueError(
        `Unexpected ${parentName} \`${key}\` shape; preserve and review`,
      );
    }
    cursor = node;
  }
  const last = parents[parents.length - 1];
  if (!dictHas(cursor, last)) dictSet(cursor, last, new Map<string, unknown>());
  const servers = dictGet(cursor, last);
  if (!isDict(servers)) {
    throw new ValueError(
      `Unexpected ${parentName} \`${last}\` shape; preserve and` + ' review',
    );
  }
  if (!dictHas(servers, name)) {
    dictSet(servers, name, entry);
    return ['merge', jsonDumps(doc) + '\n'];
  }
  const existing = dictGet(servers, name);
  if (pyEq(existing, entry) && owned !== null && owned !== undefined) {
    return ['current', null];
  }
  if (owned !== null && owned !== undefined && pyEq(existing, owned)) {
    dictSet(servers, name, entry);
    return ['update', jsonDumps(doc) + '\n'];
  }
  if (owned !== null && owned !== undefined) {
    throw new ValueError(
      `Generated connection entry \`${name}\` in ${parentName} was modified` +
        ' after generation; preserve and review an explicit edit',
    );
  }
  if (looksGenerated(client, existing)) {
    throw new ValueError(
      `Connection entry \`${name}\` in ${parentName} matches the generated` +
        ' shape but is not recorded as generated (it predates ownership' +
        ' tracking or is hand-written); to adopt it, remove it and rerun' +
        ' the setup command — otherwise keep it as a manual entry and' +
        ' remove the opt-in for this client',
    );
  }
  throw new ValueError(
    `Conflicting connection entry \`${name}\` in ${parentName}; preserve` +
      ' and review an explicit edit',
  );
}

/** Plan the Codex project layer; edits only its own generated block. */
export function planCodexConnection(
  path: string,
  name: string,
  entry: Dict,
  owned: unknown = null,
): [string, string | null] {
  const block = codexBlock(name, entry);
  if (!existsSync(path)) return ['missing', block];
  let text: string;
  let data: unknown;
  try {
    text = readText(path);
    data = tomlLoads(text);
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    throw new ValueError(
      `Unparseable ${path}: ${errorText(error)}; preserve and review`,
    );
  }
  const servers = dictGetOr(data as Dict, 'mcp_servers', {});
  if (!isDict(servers)) {
    throw new ValueError(
      `Unexpected mcp_servers shape in ${path}; preserve and review`,
    );
  }
  if (dictHas(servers, name)) {
    const existing = dictGet(servers, name);
    if (pyEq(existing, entry) && owned !== null && owned !== undefined) {
      return ['current', null];
    }
    if (owned !== null && owned !== undefined && pyEq(existing, owned)) {
      const oldBlock = codexBlock(name, owned as Dict);
      if (countOccurrences(text, oldBlock) !== 1) {
        throw new ValueError(
          `Generated \`mcp_servers.${name}\` entry in ${path} could` +
            ' not be located verbatim; preserve and review',
        );
      }
      return ['update', replaceFirst(text, oldBlock, block)];
    }
    if (owned !== null && owned !== undefined) {
      throw new ValueError(
        `Generated \`mcp_servers.${name}\` entry in ${path} was modified` +
          ' after generation; preserve and review an explicit edit',
      );
    }
    if (looksGenerated('codex', existing)) {
      throw new ValueError(
        `Connection entry \`mcp_servers.${name}\` in ${path} matches the` +
          ' generated shape but is not recorded as generated (it' +
          ' predates ownership tracking or is hand-written); to adopt' +
          ' it, remove it and rerun the setup command — otherwise keep' +
          ' it as a manual entry and remove the opt-in for this client',
      );
    }
    throw new ValueError(
      `Conflicting connection entry \`mcp_servers.${name}\` in ${path};` +
        ' preserve and review an explicit edit',
    );
  }
  const updated =
    text + (text === '' || text.endsWith('\n') ? '' : '\n') + block;
  let reparsed: unknown;
  try {
    reparsed = tomlLoads(updated);
  } catch (error) {
    if ((error as Error)?.name !== 'ValueError') throw error;
    throw new ValueError(
      `Cannot extend ${path}: the existing mcp_servers structure is not` +
        ` a table this helper can append to (${errorText(error)}); add the` +
        ` documented [mcp_servers."${name}"] table by hand`,
    );
  }
  const reparsedServers = dictGetOr(reparsed as Dict, 'mcp_servers', {});
  if (
    !isDict(reparsedServers) ||
    !pyEq(dictGet(reparsedServers, name), entry)
  ) {
    throw new ValueError(
      `Cannot extend ${path}: the appended entry did not take effect;` +
        ` add [mcp_servers."${name}"] by hand`,
    );
  }
  return ['merge', updated];
}

/** (tracked, ignored) for a connection path under the consumer root. */
export function gitConnectionState(
  root: string,
  relativePath: string,
): [boolean, boolean] {
  const tracked =
    runGit(root, ['ls-files', '--error-unmatch', '--', relativePath])
      .status === 0;
  const ignored =
    runGit(root, ['check-ignore', '-q', '--', relativePath]).status === 0;
  return [tracked, ignored];
}

/**
 * Preflight per-client writes; tracked files become consumer-owned.
 *
 * A git-tracked client file is consumer-owned: generation never writes
 * it, so the plan records an alignment verdict instead of content. An
 * untracked file follows generation-equality as before — missing, merge,
 * update or current under the recorded ownership.
 */
export function planConnectionFiles(
  root: string,
  clients: string[],
  server: string,
  profile: Dict | null,
  state?: Dict,
): Plan[] {
  const plans: Plan[] = [];
  const stateEntries = isDict(state) ? dictGet(state, 'entries') : undefined;
  const owned: Dict = pyTruthy(stateEntries)
    ? (stateEntries as Dict)
    : new Map<string, unknown>();
  const recordedServer = isDict(state) ? dictGet(state, 'server') : undefined;
  for (const client of clients) {
    const relativePath = CONNECTION_PATHS[client];
    const path = contained(root, join(root, relativePath));
    const [tracked] = gitConnectionState(root, relativePath);
    if (tracked) {
      const alignment = memoryAlignment(root, client, server, profile);
      plans.push({
        client,
        path,
        state: 'consumer-owned',
        content: null,
        entry: alignment['entry'],
        registration: alignment['registration'] as string | null,
        alignment,
      });
      continue;
    }
    const entry = expectedEntry(client, profile as Dict);
    const ownedEntry =
      recordedServer === server ? (dictGet(owned, client) ?? null) : null;
    let stateName: string;
    let content: string | null;
    if (client === 'claude') {
      [stateName, content] = planJsonConnection(
        client,
        path,
        ['mcpServers'],
        server,
        entry,
        ownedEntry,
      );
    } else if (client === 'opencode') {
      [stateName, content] = planJsonConnection(
        client,
        path,
        ['mcp', 'servers'],
        server,
        entry,
        ownedEntry,
        'mcp',
      );
    } else {
      [stateName, content] = planCodexConnection(
        path,
        server,
        entry,
        ownedEntry,
      );
    }
    plans.push({
      client,
      path,
      state: stateName,
      content,
      entry,
      registration: server,
    });
  }
  return plans;
}

// --- Consumer-owned (tracked) alignment ------------------------------------------

function alignedShapeHint(client: string, profile: Dict | null): string {
  if (profile !== null) {
    return (
      'the shape this machine profile generates: ' +
      jsonDumpsSorted(expectedEntry(client, profile))
    );
  }
  return (
    'a remote http(s) entry: `url` naming the reviewed endpoint and' +
    ' credentials referenced by environment-variable NAME only' +
    ' (no machine connection profile is available here to resolve' +
    ' against)'
  );
}

function alignmentInstruction(
  client: string,
  server: string,
  profile: Dict | null,
  reason: string,
  registration: string | null,
): string {
  const relativePath = CONNECTION_PATHS[client];
  const target = registration ?? server;
  return (
    `Consumer-owned connection file ${relativePath} is not verifiably` +
    ` aligned with the memory service: ${reason}. Align \`${target}\`` +
    ' through a reviewed edit — the helpers never write tracked files: ' +
    alignedShapeHint(client, profile) +
    '. Authentication and live access stay unverified by this check.'
  );
}

/**
 * Classify the memory registration in a tracked client file.
 *
 * Returns a verdict dict: `state` is 'consumer-owned-aligned',
 * 'consumer-owned-unaligned' or 'unknown-inspection' (unsupported
 * inspection is unknown, not missing); `registration` names the mapped
 * entry — the routing's `mcp_server` value or an endpoint-equivalent
 * name, which is preserved; `entry` is the raw registered entry for
 * downstream shadow checks; `notes` are reported for aligned entries
 * and `instruction` carries the targeted alignment instruction for
 * every other verdict.
 */
function memoryAlignment(
  root: string,
  client: string,
  server: string,
  profile: Dict | null,
): Record<string, unknown> {
  // The import cycle matches Python: `mcp_configure.py` imports `atomic`
  // and `parse_jsonc` from `memory_connections` at module top, so this
  // module reaches `inspect_client`/`equivalent_url` only inside the
  // function that calls them — a synchronous `require` keeps the Python
  // signatures intact where `import()` would have forced `async`.
  const mcpConfigure = createRequire(import.meta.url)(
    './mcp_configure.ts',
  ) as typeof import('./mcp_configure.ts');
  const relativePath = CONNECTION_PATHS[client];
  const verdict: Record<string, unknown> = {
    state: 'consumer-owned-unaligned',
    registration: null,
    entry: null,
    notes: [] as string[],
    reasons: [] as string[],
    instruction: null,
  };
  const [block, entries, aux] = mcpConfigure.inspectClient(root, client);
  if (!(block['present'] as boolean)) {
    (verdict['reasons'] as string[]).push(
      `${relativePath} is tracked but absent`,
    );
    verdict['instruction'] = alignmentInstruction(
      client,
      server,
      profile,
      `${relativePath} is tracked but absent — restore the reviewed` +
        ` registration \`${server}\``,
      server,
    );
    return verdict;
  }
  if (!(block['readable'] as boolean)) {
    verdict['state'] = 'unknown-inspection';
    verdict['reasons'] = [...(block['diagnostics'] as string[])];
    verdict['instruction'] = alignmentInstruction(
      client,
      server,
      profile,
      'the file cannot be inspected: ' +
        (block['diagnostics'] as string[]).join('; '),
      server,
    );
    return verdict;
  }
  let name: string | null = dictHas(entries, server) ? server : null;
  const endpoint = profile ? dictGet(profile, 'endpoint') : null;
  const equivalents = pySortedStrings(
    [...entries]
      .filter(
        ([n, e]) =>
          n !== name &&
          e.inspection === 'ok' &&
          e.transport === 'remote' &&
          e.url !== null &&
          endpoint !== null &&
          mcpConfigure.equivalentUrl(e.url, endpoint),
      )
      .map(([n]) => n),
  );
  const reasons: string[] = [];
  if (name === null) {
    if (equivalents.length === 1) {
      name = equivalents[0];
      (verdict['notes'] as string[]).push(
        `registration \`${name}\` maps to the memory service by` +
          ' endpoint equivalence; its name is preserved',
      );
    } else if (equivalents.length > 1) {
      reasons.push(
        'multiple registrations point at the reviewed endpoint: ' +
          equivalents.map((n) => `\`${n}\``).join(', ') +
          '; an explicit owner selection is required',
      );
    } else {
      reasons.push(
        `no registration \`${server}\`` +
          (profile ? ' or endpoint-equivalent registration' : '') +
          ' was found',
      );
    }
  }
  verdict['registration'] = name;
  if (name !== null) {
    const raw =
      clientServers(join(root, relativePath), client) ??
      new Map<string, unknown>();
    const rawEntry = dictGet(raw, name);
    verdict['entry'] = isDict(rawEntry) ? rawEntry : null;
    const entry = dictGet(entries, name) as InspectEntry;
    if (aux.shadowed.has(name)) {
      reasons.push(
        `registration \`${name}\` is defined under both \`mcp\` and` +
          ' `mcp.servers`; the shadowing needs explicit resolution',
      );
    } else if (entry.inspection === 'unknown') {
      verdict['state'] = 'unknown-inspection';
      reasons.push(
        ...(entry.notes.length
          ? entry.notes
          : ['the registration shape is unrecognized']),
      );
    } else if (entry.inspection === 'unsupported') {
      reasons.push(...entry.notes);
    } else {
      if (entry.enabled === false) {
        reasons.push(`registration \`${name}\` is explicitly disabled`);
      }
      if (entry.transport !== 'remote') {
        reasons.push(
          `registration \`${name}\` is a ${entry.transport} entry;` +
            ' the memory service is reached over http(s)',
        );
      } else {
        let badUrl: boolean;
        try {
          const parts = pyUrlsplit(entry.url);
          badUrl =
            (parts.scheme !== 'http' && parts.scheme !== 'https') ||
            !parts.hostname ||
            parts.username !== null ||
            parts.password !== null;
        } catch (error) {
          if (
            (error as Error)?.name !== 'ValueError' &&
            (error as Error)?.name !== 'TypeError'
          ) {
            throw error;
          }
          badUrl = true;
        }
        if (badUrl) {
          reasons.push('the endpoint is not a credential-free http(s) URL');
        } else if (
          endpoint !== null &&
          !mcpConfigure.equivalentUrl(entry.url, endpoint)
        ) {
          reasons.push(
            "the endpoint differs from this machine's" +
              ' connection profile',
          );
        }
      }
      if (entry.inline_secrets > 0) {
        reasons.push(
          'literal value(s) are present where only' +
            ' environment-variable NAMEs belong (redacted)',
        );
      }
      const declared = profile ? dictGet(profile, 'bearer_token_env') : null;
      const envNames = new Set<string>([
        ...entry.env_refs,
        ...entry.credential_names,
      ]);
      if (
        declared !== null &&
        declared !== undefined &&
        !envNames.has(declared as string)
      ) {
        reasons.push(
          'it does not reference the credential' +
            ` environment-variable NAME \`${declared}\``,
        );
      }
    }
    const others = equivalents.filter((n) => n !== name);
    if (others.length) {
      reasons.push(
        'duplicate registration(s) ' +
          others.map((n) => `\`${n}\``).join(', ') +
          ' also point at the endpoint; explicit resolution' +
          ' required',
      );
    }
  }
  if (reasons.length) {
    if (verdict['state'] !== 'unknown-inspection') {
      verdict['state'] = 'consumer-owned-unaligned';
    }
    verdict['reasons'] = reasons;
    verdict['instruction'] = alignmentInstruction(
      client,
      server,
      profile,
      reasons.join('; '),
      name,
    );
  } else {
    verdict['state'] = 'consumer-owned-aligned';
    const inspected =
      name === null ? null : (dictGet(entries, name) as InspectEntry);
    (verdict['notes'] as string[]).push(
      ...(inspected?.notes ?? []),
      'authentication and live access stay unverified by this' +
        ' check — live verification is a separate authorized action',
    );
    if (profile === null) {
      (verdict['notes'] as string[]).push(
        'no machine connection profile is available; the literal' +
          ' endpoint and credential NAMEs were validated' +
          ' structurally only',
      );
    }
  }
  return verdict;
}

/** Targeted instructions for consumer-owned entries not aligned. */
export function alignmentFailures(plans: Plan[]): string[] {
  return plans
    .filter(
      (plan) =>
        plan.state === 'consumer-owned' &&
        plan.alignment?.['state'] !== 'consumer-owned-aligned',
    )
    .map((plan) => plan.alignment?.['instruction'] as string);
}

/** Distinct consumer-owned-aligned labels and their limitations. */
export function alignedNotes(root: string, plans: Plan[]): string[] {
  const notes: string[] = [];
  for (const plan of plans) {
    if (plan.state !== 'consumer-owned') continue;
    const verdict = plan.alignment as Record<string, unknown>;
    if (verdict['state'] !== 'consumer-owned-aligned') continue;
    const relativePath = relative(root, plan.path);
    notes.push(
      `${relativePath}: registration \`${verdict['registration']}\` is` +
        ' consumer-owned (tracked) and aligned with the memory' +
        ' service; generation never writes it',
    );
    notes.push(...(verdict['notes'] as string[]));
  }
  return notes;
}

// --- JSONC ------------------------------------------------------------------------

/**
 * Parse the JSONC dialect: comments and trailing commas over JSON.
 *
 * Anything the bounded normalizer cannot reduce to strict JSON raises, so
 * callers report an explicit diagnostic instead of silently skipping a
 * layer. Ported statement-for-statement from the Python original.
 */
export function parseJsonc(text: string): unknown {
  let out: string[] = [];
  let index = 0;
  let size = text.length;
  let inString = false;
  while (index < size) {
    const char = text[index];
    if (inString) {
      out.push(char);
      if (char === '\\' && index + 1 < size) {
        out.push(text[index + 1]);
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out.push(char);
      index += 1;
      continue;
    }
    if (char === '/' && index + 1 < size && text[index + 1] === '/') {
      index += 2;
      while (index < size && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && index + 1 < size && text[index + 1] === '*') {
      index += 2;
      while (
        index + 1 < size &&
        !(text[index] === '*' && text[index + 1] === '/')
      ) {
        index += 1;
      }
      index = index + 1 < size ? index + 2 : size;
      continue;
    }
    out.push(char);
    index += 1;
  }
  const stripped = out.join('');
  out = [];
  index = 0;
  size = stripped.length;
  inString = false;
  while (index < size) {
    const char = stripped[index];
    if (inString) {
      out.push(char);
      if (char === '\\' && index + 1 < size) {
        out.push(stripped[index + 1]);
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out.push(char);
      index += 1;
      continue;
    }
    if (char === ',') {
      let lookahead = index + 1;
      while (lookahead < size && ' \t\r\n'.includes(stripped[lookahead])) {
        lookahead += 1;
      }
      if (lookahead < size && '}]'.includes(stripped[lookahead])) {
        index += 1;
        continue;
      }
    }
    out.push(char);
    index += 1;
  }
  return jsonLoads(out.join(''));
}

// --- Shadowing and prerequisites ---------------------------------------------------

/**
 * Accessible Claude settings files: (path, scope, applies_untrusted).
 *
 * Approvals recorded in committed project settings are ignored until the
 * workspace is trusted, so a cloned repository cannot approve its own
 * servers; user, local-untracked and managed sources apply regardless.
 * Runtime-only sources (`--settings`, `--setting-sources`, permission
 * modes) cannot be inspected and are documented as a limitation.
 */
export function claudeSettingsLayers(
  root: string,
  home: string,
): [string, string, boolean][] {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const [tracked] = gitConnectionState(root, '.claude/settings.local.json');
  return [
    [join(configDir, 'settings.json'), '~/.claude/settings.json', true],
    [CLAUDE_MANAGED_SETTINGS, CLAUDE_MANAGED_SETTINGS, true],
    [
      join(root, '.claude/settings.local.json'),
      '.claude/settings.local.json',
      !tracked,
    ],
    [join(root, '.claude/settings.json'), '.claude/settings.json', false],
  ];
}

/** Local-scope shadowing, user-scope duplicates and approval state. */
function claudeShadowing(
  root: string,
  name: string,
  profile: Dict | null,
  home: string,
): [string[], string[]] {
  const failures: string[] = [];
  const warnings: string[] = [];
  const path = join(home, '.claude.json');
  let record: Dict = new Map<string, unknown>();
  let data: unknown = null;
  if (isFile(path)) {
    try {
      data = jsonLoads(readText(path));
    } catch (error) {
      if (!isValueOrOSError(error)) throw error;
      data = null;
      warnings.push(
        '~/.claude.json is unreadable; local-scope and' +
          ' user-scope shadowing unverified',
      );
    }
    if (isDict(data)) {
      const projects = dictGetOr(data, 'projects', {});
      const found = isDict(projects) ? dictGetOr(projects, root, {}) : {};
      record = isDict(found) ? found : new Map<string, unknown>();
    } else if (data !== null && data !== undefined) {
      warnings.push(
        '~/.claude.json has an unexpected shape;' + ' shadowing unverified',
      );
    }
  }
  const servers = dictGetOr(record, 'mcpServers', {});
  const entry = isDict(servers) ? dictGet(servers, name) : undefined;
  if (isDict(entry)) {
    if (profile === null) {
      warnings.push(
        `~/.claude.json local-scope entry \`${name}\` exists; with` +
          ' no machine connection profile its endpoint cannot be' +
          ' compared to the project entry — shadowing unverified',
      );
    } else {
      const auth = dictGetOr(entry, 'headers', {});
      const same =
        sameEndpoint(entry, dictGet(profile, 'endpoint')) &&
        claudeEnvRef(isDict(auth) ? dictGet(auth, 'Authorization') : null) ===
          dictGet(profile, 'bearer_token_env');
      if (same) {
        warnings.push(
          `~/.claude.json local-scope entry \`${name}\` duplicates the` +
            ' generated project entry (local scope wins; consider the' +
            ' gradual migration in docs/memory/connections.md)',
        );
      } else {
        failures.push(
          `~/.claude.json local-scope entry \`${name}\` shadows the` +
            ' generated project entry with a different endpoint or' +
            ' credential reference (local > project > user); resolve it' +
            ' manually — it is never moved or overwritten',
        );
      }
    }
  }
  if (isDict(data)) {
    const user = dictGetOr(data, 'mcpServers', {});
    const userEntry = isDict(user) ? dictGet(user, name) : undefined;
    if (isDict(userEntry)) {
      let match: string;
      if (profile === null) {
        match =
          'an endpoint that cannot be compared (no machine' +
          ' connection profile)';
      } else {
        match = sameEndpoint(userEntry, dictGet(profile, 'endpoint'))
          ? 'the same'
          : 'a different';
      }
      warnings.push(
        `~/.claude.json user-scope entry \`${name}\` points to ${match}` +
          ' endpoint; the project entry wins here, and the user entry' +
          ' still applies to other projects',
      );
    }
  }
  const [status, detail] = claudeApproval(root, name, home, record, warnings);
  if (status === 'disabled') {
    failures.push(
      `Claude Code records \`${name}\` in disabledMcpjsonServers` +
        ` (${detail}); the generated .mcp.json entry stays rejected in` +
        ' every permission mode until the entry is removed (see' +
        ' docs/claude.md)',
    );
  } else if (status === 'committed') {
    warnings.push(
      `Claude Code approval for \`${name}\` is recorded only in committed` +
        ` settings (${detail}), which apply once this workspace is` +
        ' trusted; verify the effective approval in a session (see' +
        ' docs/claude.md)',
    );
  } else if (status === 'pending') {
    warnings.push(
      `Claude Code has no recorded approval for \`${name}\` at this` +
        ' checkout; an interactive session prompts once to approve the' +
        ' project .mcp.json entry, while `claude -p` and Agent SDK' +
        ' sessions require the projectSettings source; upstream describes' +
        ' prompt-free loading, but this is unverified here. Verify' +
        ' effective tools in the live pilot (see' +
        ' docs/claude.md)',
    );
  }
  return [failures, warnings];
}

/**
 * Recorded approval state for a project .mcp.json server.
 *
 * Returns ('disabled' | 'approved' | 'committed' | 'pending', detail).
 * A `disabledMcpjsonServers` entry in any settings file rejects the server
 * in every permission mode. Approvals count from the sources that apply
 * without workspace trust — user and managed settings, an untracked
 * `.claude/settings.local.json`, `--settings` (not inspectable here) and the
 * recorded interactive choice in `~/.claude.json` — and from committed
 * project settings only once the workspace is trusted ('committed' reports
 * that caveat instead of counting as approval).
 */
function claudeApproval(
  root: string,
  name: string,
  home: string,
  record: Dict,
  warnings: string[],
): [string, string] {
  const disabled: string[] = [];
  const committedDisabled: string[] = [];
  const enabled: string[] = [];
  const committed: string[] = [];
  for (const [path, scope, appliesUntrusted] of claudeSettingsLayers(
    root,
    home,
  )) {
    if (!isFile(path)) continue;
    let data: unknown;
    try {
      data = jsonLoads(readText(path));
    } catch (error) {
      if (!isValueOrOSError(error)) throw error;
      warnings.push(`${scope} is unreadable; approval state unverified`);
      continue;
    }
    if (!isDict(data)) continue;
    const denied = dictGetOr(data, 'disabledMcpjsonServers', []);
    if (Array.isArray(denied) && pyContains(denied, name)) {
      (appliesUntrusted ? disabled : committedDisabled).push(scope);
    }
    const granted = dictGetOr(data, 'enabledMcpjsonServers', []);
    if (
      (Array.isArray(granted) && pyContains(granted, name)) ||
      dictGet(data, 'enableAllProjectMcpServers') === true
    ) {
      (appliesUntrusted ? enabled : committed).push(scope);
    }
  }
  let recorded = dictGetOr(record, 'disabledMcpjsonServers', []);
  if (Array.isArray(recorded) && pyContains(recorded, name)) {
    disabled.push('~/.claude.json project record');
  }
  recorded = dictGetOr(record, 'enabledMcpjsonServers', []);
  if (Array.isArray(recorded) && pyContains(recorded, name)) {
    enabled.push('~/.claude.json project record');
  }
  const trusted = dictGet(record, 'hasTrustDialogAccepted') === true;
  if (committedDisabled.length && !trusted) {
    warnings.push(
      `Claude Code records \`${name}\` in disabledMcpjsonServers in` +
        ` committed settings (${committedDisabled.join(', ')}); it takes` +
        ' effect once this workspace is trusted and then rejects the' +
        ' generated entry in every permission mode — reconcile it now' +
        ' (see docs/claude.md)',
    );
  }
  if (trusted) {
    disabled.push(...committedDisabled);
    enabled.push(...committed);
  }
  if (disabled.length) return ['disabled', disabled.join(', ')];
  if (enabled.length) return ['approved', enabled.join(', ')];
  if (committed.length) return ['committed', committed.join(', ')];
  return ['pending', ''];
}

/**
 * Whether Codex treats this checkout path as trusted.
 *
 * A linked worktree inherits the primary checkout's trust through the
 * common git dir; an explicit trust level for the worktree path takes
 * precedence over that fallback; entries without a trust level are
 * skipped.
 */
export function codexTrusted(root: string, projects: Dict): boolean {
  const record = dictGet(projects, root);
  if (
    isDict(record) &&
    ['trusted', 'untrusted'].includes(
      dictGet(record, 'trust_level') as string,
    )
  ) {
    return dictGet(record, 'trust_level') === 'trusted';
  }
  const result = runGit(root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (result.status !== 0) return false;
  const primary = dirname(resolvePath(result.stdout.trim()));
  if (primary === root) return false;
  const primaryRecord = dictGet(projects, primary);
  return (
    isDict(primaryRecord) &&
    dictGet(primaryRecord, 'trust_level') === 'trusted'
  );
}

/**
 * User-layer field shadowing and the project-trust prerequisite.
 *
 * Returns (failures, warnings, trusted). Codex merges layers field by
 * field, so a user-layer entry only shadows the generated entry through
 * fields the project layer does not set.
 */
function codexShadowing(
  root: string,
  name: string,
  entry: Dict,
  home: string,
): [string[], string[], boolean] {
  const failures: string[] = [];
  const warnings: string[] = [];
  const base = process.env.CODEX_HOME || join(home, '.codex');
  const path = join(base, 'config.toml');
  if (!isFile(path)) return [failures, warnings, false];
  let data: unknown;
  try {
    data = tomlLoads(readText(path));
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    return [
      failures,
      [
        `${path} is unreadable; trust state and user-scope` +
          ' shadowing unverified',
      ],
      false,
    ];
  }
  if (!isDict(data)) {
    return [
      failures,
      [`${path} has an unexpected shape; trust state` + ' unverified'],
      false,
    ];
  }
  const projects = dictGetOr(data, 'projects', {});
  const trusted = codexTrusted(
    root,
    isDict(projects) ? projects : ({} as Dict),
  );
  const servers = dictGetOr(data, 'mcp_servers', {});
  const user = isDict(servers) ? dictGet(servers, name) : undefined;
  if (isDict(user) && !pyTruthy(entry)) {
    warnings.push(
      `~/.codex/config.toml user-scope entry \`mcp_servers.${name}\`` +
        ' provides the registration while the tracked project layer' +
        ' has none; it applies to this checkout under field-level' +
        ' merge',
    );
  } else if (isDict(user)) {
    const entryKeys = new Set(dictKeys(entry));
    const leaked = pySortedStrings(
      dictKeys(user).filter((key) => !entryKeys.has(key)),
    );
    if (leaked.length) {
      failures.push(
        `~/.codex/config.toml user-scope entry \`mcp_servers.${name}\`` +
          ` contributes field(s) the project layer does not set:` +
          ` ${leaked.join(', ')}; the effective configuration would` +
          ' differ from the generated entry — reconcile it manually' +
          ' (field-level merge, see docs/codex.md)',
      );
    } else {
      warnings.push(
        `~/.codex/config.toml user-scope entry \`mcp_servers.${name}\`` +
          ' is fully overridden by the project layer for this checkout;' +
          ' it still applies to other projects',
      );
    }
  }
  return [failures, warnings, trusted];
}

interface OpencodeLayer {
  severity: 'lower' | 'higher';
  scope: string;
  payload: { file: string } | { inline: string };
}

/**
 * (severity, source, payload) candidates in precedence order.
 *
 * Direct files merge farthest-to-closest, then every discovered `.opencode`
 * config overrides every direct file, then inline and system/managed layers.
 * 'lower' layers can only duplicate the generated entry; 'higher' ones
 * shadow it. `payload` is a path, or inline content for
 * OPENCODE_CONFIG_CONTENT.
 */
export function opencodeLayers(root: string, home: string): OpencodeLayer[] {
  const layers: OpencodeLayer[] = [];
  const xdg = process.env.XDG_CONFIG_HOME || join(home, '.config');
  for (const leaf of ['opencode.json', 'opencode.jsonc']) {
    layers.push({
      severity: 'lower',
      scope: 'global',
      payload: { file: join(xdg, 'opencode', leaf) },
    });
  }
  const custom = process.env.OPENCODE_CONFIG;
  if (custom) {
    layers.push({
      severity: 'lower',
      scope: 'OPENCODE_CONFIG',
      payload: { file: custom },
    });
  }
  for (const ancestor of pathParents(root)) {
    for (const leaf of ['opencode.json', 'opencode.jsonc']) {
      layers.push({
        severity: 'lower',
        scope: ancestor,
        payload: { file: join(ancestor, leaf) },
      });
    }
  }
  for (const base of [...pathParents(root), root, home]) {
    const directory = join(base, '.opencode');
    if (!isDir(directory)) continue;
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      layers.push({
        severity: 'higher',
        scope: directory,
        payload: { file: join(directory, name) },
      });
    }
  }
  // Within one directory opencode.jsonc loads after opencode.json.
  layers.push({
    severity: 'higher',
    scope: 'project',
    payload: { file: join(root, 'opencode.jsonc') },
  });
  const content = process.env.OPENCODE_CONFIG_CONTENT;
  if (typeof content === 'string' && content.trim()) {
    layers.push({
      severity: 'higher',
      scope: 'OPENCODE_CONFIG_CONTENT',
      payload: { inline: content },
    });
  }
  for (const leaf of [
    ...etcGlobSorted('.json'),
    ...etcGlobSorted('.jsonc'),
  ]) {
    layers.push({
      severity: 'higher',
      scope: OPENCODE_ETC,
      payload: { file: leaf },
    });
  }
  return layers;
}

/** `sorted(OPENCODE_ETC.glob('*.ext'))` — full paths, sorted. */
function etcGlobSorted(suffix: string): string[] {
  try {
    return pySortedStrings(
      readdirSync(OPENCODE_ETC)
        .filter(
          (name) =>
            name.endsWith(suffix) && isFile(join(OPENCODE_ETC, name)),
        )
        .map((name) => join(OPENCODE_ETC, name)),
    );
  } catch {
    return [];
  }
}

/** The recorded server entry in a parsed OpenCode config, or null. */
export function opencodeEntryIn(data: unknown, name: string): unknown {
  if (!isDict(data)) return null;
  const mcp = dictGetOr(data, 'mcp', {});
  if (!isDict(mcp)) return null;
  const servers = dictGetOr(mcp, 'servers', {});
  if (isDict(servers)) {
    const inServers = dictGet(servers, name);
    if (isDict(inServers)) return inServers;
  }
  const direct = dictGet(mcp, name);
  if (isDict(direct) && (dictHas(direct, 'url') || dictHas(direct, 'type'))) {
    return direct;
  }
  return null;
}

/** Lower-precedence duplicates and higher-precedence OpenCode layers. */
function opencodeShadowing(
  root: string,
  name: string,
  profile: Dict | null,
  home: string,
): [string[], string[]] {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const { severity, scope, payload } of opencodeLayers(root, home)) {
    let text: string;
    let origin: string;
    if ('file' in payload) {
      if (!isFile(payload.file)) continue;
      try {
        text = readText(payload.file);
      } catch (error) {
        if (!isOSError(error)) throw error;
        warnings.push(
          `${payload.file} is unreadable; ${scope} shadowing` +
            ' unverified',
        );
        continue;
      }
      origin = payload.file;
    } else {
      text = payload.inline;
      origin = scope;
    }
    let data: unknown;
    try {
      data = jsonLoads(text);
    } catch (error) {
      if ((error as Error)?.name !== 'ValueError') throw error;
      try {
        data = parseJsonc(text);
      } catch (inner) {
        if ((inner as Error)?.name !== 'ValueError') throw inner;
        warnings.push(
          `${origin} could not be parsed even as JSONC;` +
            ` ${scope} shadowing unverified`,
        );
        continue;
      }
    }
    const found = opencodeEntryIn(data, name);
    if (found === null || found === undefined) continue;
    let match: string;
    if (profile === null) {
      match =
        'an endpoint that cannot be compared (no machine' +
        ' connection profile)';
    } else {
      match = sameEndpoint(found, dictGet(profile, 'endpoint'))
        ? 'the same'
        : 'a different';
    }
    const message =
      `${scope} entry \`${name}\` in ${origin} points to ${match}` +
      ' endpoint';
    if (profile === null) {
      warnings.push(
        `${message}; precedence-layer shadowing is` +
          ' unverified without the machine profile',
      );
    } else if (severity === 'lower') {
      warnings.push(
        `${message}; the project entry wins for this` +
          ' checkout, and the other entry still applies' +
          ' where no closer file defines it',
      );
    } else {
      failures.push(
        `${message}; a higher-precedence OpenCode layer` +
          ' shadows the generated project entry — resolve' +
          ' it manually (see docs/opencode.md)',
      );
    }
  }
  return [failures, warnings];
}

/**
 * (failures, warnings, prerequisites) for home-folder scopes.
 *
 * Failures mean the effective configuration would differ from the generated
 * intent (a higher- or equal-precedence entry wins, or a layer contributes
 * fields the project layer does not set). Warnings cover harmless
 * duplicates, pending approvals and unreadable layers. Prerequisites name
 * missing client-side requirements such as Codex project trust.
 */
export function shadowReport(
  root: string,
  clients: string[],
  server: string,
  profile: Dict | null,
  plans: Plan[],
  home?: string,
): [string[], string[], string[]] {
  const homeDir = home ?? homedir();
  const failures: string[] = [];
  const warnings: string[] = [];
  const prerequisites: string[] = [];
  const entries: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  for (const plan of plans) {
    entries[plan.client] = plan.entry;
    names[plan.client] = plan.registration ?? server;
  }
  if (clients.includes('claude')) {
    const [fail, warn] = claudeShadowing(
      root,
      names['claude'],
      profile,
      homeDir,
    );
    failures.push(...fail);
    warnings.push(...warn);
  }
  if (clients.includes('codex')) {
    const [fail, warn, trusted] = codexShadowing(
      root,
      names['codex'],
      (pyTruthy(entries['codex']) ? entries['codex'] : {}) as Dict,
      homeDir,
    );
    failures.push(...fail);
    warnings.push(...warn);
    if (!trusted) {
      prerequisites.push(
        'Codex project trust is not recorded for this checkout or' +
          ' its primary checkout; the project .codex/config.toml' +
          ' applies only to trusted paths. Trust it through Codex' +
          ' itself (see docs/codex.md) — this helper never edits' +
          ' client trust',
      );
    }
  }
  if (clients.includes('opencode')) {
    const [fail, warn] = opencodeShadowing(
      root,
      names['opencode'],
      profile,
      homeDir,
    );
    failures.push(...fail);
    warnings.push(...warn);
  }
  return [failures, warnings, prerequisites];
}

// --- Routing-source propagation (T3 worktrees) -------------------------------------

/**
 * Describe drift between the tracked routing source and generated routing.
 *
 * In a consumer with an enabled `.agent-workflows-t3.json`, the generated
 * `.agents/memory/config.md` — including its connection marker — reaches a
 * worktree only through the tracked file named by `memory.routing_source`.
 * When that file is missing or stale, fresh worktrees silently lose the
 * opt-in. Returns a short drift description or null.
 */
export function routingSourceDrift(root: string): string | null {
  const config = join(root, T3_CONFIG);
  if (!isFile(config)) return null;
  let sourceName: unknown;
  try {
    const data = jsonLoads(readText(config));
    if (!isDict(data)) return 'the T3 configuration must be a JSON object';
    const memory = dictGet(data, 'memory');
    sourceName = isDict(memory)
      ? dictGet(memory, 'routing_source')
      : null;
  } catch (error) {
    if (!isValueOrOSError(error)) throw error;
    return 'the T3 configuration is unreadable or invalid JSON';
  }
  if (typeof sourceName !== 'string' || !sourceName) return null;
  if (isAbsolute(sourceName) || sourceName.split('/').includes('..')) {
    return `the recorded routing_source ${sourceName} is unsafe`;
  }
  const source = join(root, sourceName);
  const generated = join(root, '.agents/memory/config.md');
  if (!isFile(source)) {
    return `the tracked routing source ${sourceName} is missing`;
  }
  if (!isFile(generated)) return null;
  for (const relativeName of [sourceName, '.gitignore', T3_CONFIG]) {
    const tracked = runGit(root, ['cat-file', '-e', `HEAD:${relativeName}`]);
    const changed = runGit(root, [
      'diff',
      '--quiet',
      'HEAD',
      '--',
      relativeName,
    ]);
    if (tracked.status !== 0 || changed.status !== 0) {
      return `${relativeName} differs from HEAD; review and commit it before creating worktrees`;
    }
  }
  if (!readFileSync(source).equals(readFileSync(generated))) {
    return (
      `the tracked routing source ${sourceName} predates the` +
      ' current generated routing'
    );
  }
  return null;
}

export function routingSourceWarning(
  root: string,
  reconcile: string,
): string | null {
  const drift = routingSourceDrift(root);
  if (drift === null) return null;
  return (
    `Routing-source drift: ${drift}. Fresh worktrees would restore stale` +
    ' routing and silently lose the connection opt-in. Repair from the' +
    ` main checkout: \`${reconcile}\`, review its diff, then commit the` +
    ' routing source and .gitignore before creating worktrees'
  );
}

/**
 * Generated connection ignore lines present in .gitignore.
 *
 * These tracked lines are the only opt-in evidence that survives into a
 * worktree whose tracked routing source predates the opt-in.
 */
export function connectionIgnoreEvidence(root: string): string[] {
  const ignore = join(root, '.gitignore');
  if (!isFile(ignore)) return [];
  let lines: string[];
  try {
    lines = pySplitlines(readText(ignore));
  } catch (error) {
    if (!isOSError(error)) throw error;
    return [];
  }
  return Object.values(CONNECTION_IGNORE).filter((line) =>
    lines.includes(line),
  );
}

export function checkConnectionIgnores(
  root: string,
  clients: string[],
  setupRepair?: string,
): void {
  const repair = setupRepair ?? DEFAULT_SETUP_REPAIR;
  // Consumer-owned (tracked) files need no ignore entry — generation
  // never writes them, and git-ignore lines do not untrack files.
  const generated = clients.filter(
    (client) => !gitConnectionState(root, CONNECTION_PATHS[client])[0],
  );
  const missing: [string, string][] = [];
  for (const client of generated) {
    const relativePath = CONNECTION_PATHS[client];
    if (!gitConnectionState(root, relativePath)[1]) {
      missing.push([CONNECTION_IGNORE[client], relativePath]);
    }
  }
  if (generated.length && !gitConnectionState(root, CONNECTION_STATE)[1]) {
    missing.push([CONNECTION_STATE_IGNORE, CONNECTION_STATE]);
  }
  for (const [line, relativePath] of missing) {
    throw new ValueError(
      `${relativePath} is not git-ignored; generated connection files must` +
        ' stay uncommitted. The ignore entries live in the tracked' +
        ' .gitignore, which `setup_memory` manages — and that helper' +
        ' needs the reviewed routing input present only in the main' +
        ` checkout: add the entries there (\`${repair}\`), commit` +
        ' .gitignore, then bring the commit into this worktree or' +
        ` recreate it. For this checkout alone, add \`${line}\` to the` +
        " repository's `.git/info/exclude` instead",
    );
  }
}

/**
 * Write missing, mergeable or owned-stale files; return warnings.
 *
 * Consumer-owned (tracked) files are validated, never written: an entry
 * that is not verifiably aligned refuses the whole run before any write.
 * Raises on leftovers and hard shadowing; prerequisites are returned as
 * warnings: the written file is still correct when a client prerequisite
 * (for example Codex trust) is resolved later. The ownership record is
 * updated only after the files it describes are written.
 */
export function renderConnections(
  root: string,
  clients: string[],
  server: string,
  profile: Dict | null,
  plans: Plan[],
  home?: string,
  setupRepair?: string,
  reconcile?: string,
  state?: Dict,
): [string[], string[]] {
  checkConnectionIgnores(root, clients, setupRepair);
  let stateValue: Dict;
  let stateWarning: string | null;
  if (state !== undefined) {
    stateValue = state;
    stateWarning = null;
  } else {
    [stateValue, stateWarning] = readState(root);
  }
  let warnings = raiseForLeftovers(
    root,
    clients,
    server,
    stateValue,
    'Deselected connection client(s) still carry generated-looking' +
      ` \`${server}\` entries`,
  );
  const [failures, shadowWarnings, prerequisites] = shadowReport(
    root,
    clients,
    server,
    profile,
    plans,
    home,
  );
  if (failures.length) {
    throw new ValueError(
      'Shadowing detected — no connection files written:\n' +
        failures.join('\n'),
    );
  }
  const unaligned = alignmentFailures(plans);
  if (unaligned.length) {
    throw new ValueError(
      'Consumer-owned memory connection entries are not' +
        ' verifiably aligned — no connection files' +
        ' written:\n' +
        unaligned.join('\n'),
    );
  }
  warnings = [...warnings, ...alignedNotes(root, plans)];
  const written: string[] = [];
  const cleaned = pruneCleanedOwnership(root, clients, stateValue, true);
  const cleanedEntries = dictGet(cleaned, 'entries');
  const recorded: Dict = new Map<string, unknown>(
    dictGet(cleaned, 'server') === server && isDict(cleanedEntries)
      ? dictItems(cleanedEntries)
      : [],
  );
  for (const plan of plans) {
    if (plan.state === 'current' || plan.state === 'consumer-owned') {
      continue;
    }
    const previous = existsSync(plan.path) ? readText(plan.path) : null;
    atomic(plan.path, plan.content as string);
    dictSet(recorded, plan.client, plan.entry);
    try {
      writeState(root, server, recorded);
    } catch (error) {
      if (!isOSError(error)) throw error;
      if (previous === null) {
        unlinkSync(plan.path);
      } else {
        atomic(plan.path, previous);
      }
      throw error;
    }
    written.push(plan.client);
  }
  warnings = [...warnings, ...shadowWarnings];
  if (stateWarning) warnings.push(stateWarning);
  const drift = routingSourceWarning(root, reconcile ?? DEFAULT_RECONCILE);
  if (drift) warnings.push(drift);
  return [written, [...warnings, ...prerequisites]];
}

/** --check: drift, shadowing, duplicates and missing prerequisites. */
export function checkConnections(
  root: string,
  clients: string[],
  server: string,
  profile: Dict | null,
  plans: Plan[],
  home?: string,
  repair?: string,
  setupRepair?: string,
  reconcile?: string,
  state?: Dict,
): string[] {
  const repairCommand = repair ?? DEFAULT_CONN_REPAIR;
  const reconcileCommand = reconcile ?? DEFAULT_RECONCILE;
  checkConnectionIgnores(root, clients, setupRepair);
  let stateValue: Dict;
  let stateWarning: string | null;
  if (state !== undefined) {
    stateValue = state;
    stateWarning = null;
  } else {
    [stateValue, stateWarning] = readState(root);
  }
  let warnings: string[] = [];
  if (stateWarning) warnings.push(stateWarning);
  const [failures, shadowWarnings, prerequisites] = shadowReport(
    root,
    clients,
    server,
    profile,
    plans,
    home,
  );
  warnings = [...warnings, ...shadowWarnings];
  const drift: string[] = [];
  for (const plan of plans) {
    if (plan.state === 'consumer-owned') {
      const verdict = plan.alignment as Record<string, unknown>;
      if (verdict['state'] === 'consumer-owned-aligned') {
        warnings = [...warnings, ...alignedNotes(root, [plan])];
      } else {
        drift.push(verdict['instruction'] as string);
      }
      continue;
    }
    if (plan.state !== 'current') {
      const relativePath = relative(root, plan.path);
      let stateName: string;
      if (plan.state === 'missing') {
        stateName = 'Missing connection file';
      } else if (plan.state === 'merge') {
        stateName = 'Missing entry in';
      } else {
        stateName = 'Profile drift: the generated entry in';
      }
      drift.push(
        `${stateName} ${relativePath}; repair from the consumer` +
          ` root: \`${repairCommand}\`. Local artifact state only; this check` +
          ' does not assess MCP connectivity',
      );
    }
  }
  const allFailures = [...drift, ...failures];
  const [leftoverFailures, leftoverWarnings] = leftoverDiagnostics(
    root,
    clients,
    server,
    stateValue,
  );
  warnings = [...warnings, ...leftoverWarnings];
  allFailures.push(
    ...leftoverFailures.map(
      (item) =>
        `${item}; remove or reconcile it manually — the helper never deletes` +
        ' client configuration',
    ),
  );
  const sourceDrift = routingSourceDrift(root);
  if (sourceDrift) {
    allFailures.push(
      `Routing-source drift: ${sourceDrift}; fresh worktrees would` +
        ' restore stale routing and silently lose the connection opt-in.' +
        ` Repair from the consumer root: \`${reconcileCommand}\`, review its diff,` +
        ' then commit the routing source and .gitignore before creating' +
        ' worktrees',
    );
  }
  if (allFailures.length || prerequisites.length) {
    throw new ValueError(
      'Connection check failed:\n' +
        [
          ...allFailures,
          ...prerequisites.map((item) => `Missing prerequisite: ${item}`),
        ].join('\n'),
    );
  }
  return warnings;
}
