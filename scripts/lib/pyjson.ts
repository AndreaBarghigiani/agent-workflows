/**
 * `pyJson`: byte-identical `json.dumps` for the shapes this port writes.
 *
 * Matches CPython 3.12 `json.dumps(value, ensure_ascii=True, sort_keys=True)`
 * in the two modes the codebase uses:
 *
 * - `pyJson(value)` — compact output with `separators=(",", ":")`.
 * - `pyJson(value, 2)` — `indent=2` output (separator pair `(",", ": ")`,
 *   two spaces per level, empty containers rendered inline).
 *
 * Non-ASCII input is escaped as `\uXXXX` (astral characters as surrogate
 * pairs), DEL and remaining C0 controls too, exactly like `ensure_ascii`.
 * Non-finite floats follow `allow_nan=True`: `NaN`, `Infinity`, `-Infinity`.
 * Parsed dicts arrive as `Map`s (`sort_keys` orders them identically),
 * Python `int`s as `bigint` and floats as `PyFloat`.
 */
import { PyFloat } from './pyloads.ts';
import { pyFloatRepr } from './pyrepr.ts';

const JSON_ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

export function escapeString(value: string): string {
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

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  if (Object.is(value, -0)) return '-0.0';
  if (Number.isInteger(value)) return String(value);
  return pyFloatRepr(value);
}

/** `json.dumps` for a Python `float` — always the float repr (`2.0`). */
function formatFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  return pyFloatRepr(value);
}

/**
 * `sort_keys=True` orders keys by Unicode code point, but JavaScript's
 * default string sort uses UTF-16 code units — which inverts BMP characters
 * at or above U+E000 against astral characters (their leading surrogates
 * sort first under UTF-16). Comparing code point by code point reproduces
 * CPython's ordering.
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

function serialize(value: unknown, indent: number | undefined, level: number): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return formatNumber(value);
  // `bigint` is a Python `int`: its digits, unbounded by 2**53.
  if (typeof value === 'bigint') return String(value);
  if (value instanceof PyFloat) return formatFloat(value.value);
  if (typeof value === 'string') return escapeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((entry) => serialize(entry, indent, level + 1));
    return joinItems('[', ']', items, indent, level);
  }
  const pair = (key: string, member: unknown): string =>
    `${escapeString(key)}${indent === undefined ? ':' : ': '}${
      serialize(member, indent, level + 1)
    }`;
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, member]) => pair(key, member));
    if (entries.length === 0) return '{}';
    return joinItems('{', '}', entries, indent, level);
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort(compareCodePoints)
      .map((key) =>
        pair(key, (value as Record<string, unknown>)[key]),
      );
    if (entries.length === 0) return '{}';
    return joinItems('{', '}', entries, indent, level);
  }
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

function joinItems(
  open: string,
  close: string,
  items: string[],
  indent: number | undefined,
  level: number,
): string {
  if (indent === undefined) return open + items.join(',') + close;
  const pad = ' '.repeat(indent * (level + 1));
  const closing = ' '.repeat(indent * level);
  return `${open}\n${pad}${items.join(`,\n${pad}`)}\n${closing}${close}`;
}

/**
 * Serialize `value` like `json.dumps(..., ensure_ascii=True, sort_keys=True)`:
 * compact `(",", ":")` by default, or `indent`-spaced `(",", ": ")` when an
 * indent is given.
 */
export function pyJson(value: unknown, indent?: number): string {
  return serialize(value, indent, 0);
}
