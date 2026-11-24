/**
 * Formatting helpers that reproduce CPython `repr()`/`str()` and the type
 * names used in diagnostic messages, so ported code emits byte-identical
 * text to the Python original.
 */
import { PyFloat } from './pyloads.ts';

/**
 * CPython `repr()` for floats: the shortest string that round-trips, in fixed
 * notation for exponents in [-4, 16) and scientific notation (sign and at
 * least two exponent digits) outside it.
 */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return value < 0 ? '-inf' : 'inf';
  if (Object.is(value, -0)) return '-0.0';
  if (value === 0) return '0.0';
  const absolute = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (absolute < 1e-4 || absolute >= 1e16) {
    const [mantissa, exponent] = absolute.toExponential().split('e');
    const digits = Math.abs(Number(exponent)).toString().padStart(2, '0');
    return `${sign}${mantissa}e${Number(exponent) < 0 ? '-' : '+'}${digits}`;
  }
  return `${sign}${absolute}${Number.isInteger(value) ? '.0' : ''}`;
}

// Python `str.isprintable`: every general category except the C* categories,
// Zl and Zp is printable, and of the Zs separators only U+0020 is. General
// categories partition all code points, so "no assigned L/M/N/P/S/Z category
// or a non-space Z" is exactly the set `repr` escapes.
const PRINTABLE = /[\p{L}\p{M}\p{N}\p{P}\p{S}]/u;

function pyIsPrintable(char: string): boolean {
  return char === ' ' || PRINTABLE.test(char);
}

const SHORT_ESCAPES: Record<string, string> = {
  '\\': '\\\\',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
};

function pyEscapeChar(char: string, quote: string): string {
  if (char === quote || char === '\\') return `\\${char}`;
  const short = SHORT_ESCAPES[char];
  if (short !== undefined) return short;
  if (pyIsPrintable(char)) return char;
  const point = char.codePointAt(0) ?? 0;
  const hex = point.toString(16);
  if (point < 0x100) return `\\x${hex.padStart(2, '0')}`;
  if (point < 0x10000) return `\\u${hex.padStart(4, '0')}`;
  return `\\U${hex.padStart(8, '0')}`;
}

/** CPython `repr()` for `str` (quote choice and escaping included). */
export function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of value) out += pyEscapeChar(char, quote);
  return out + quote;
}

function isDict(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof PyFloat)
  );
}

/** CPython `repr()` for the JSON-shaped values this port handles. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  // `bigint` is a Python `int`: its digits, unbounded.
  if (typeof value === 'bigint') return String(value);
  if (value instanceof PyFloat) return pyFloatRepr(value.value);
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0.0';
    return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  }
  if (typeof value === 'string') return pyStrRepr(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => pyRepr(entry)).join(', ')}]`;
  }
  if (value instanceof Map) {
    // Dict repr shows members in insertion order — exactly the order a
    // `Map` from `pyJsonLoads` preserves.
    const entries = [...value.entries()].map(
      ([key, entry]) => `${pyStrRepr(key)}: ${pyRepr(entry)}`,
    );
    return `{${entries.join(', ')}}`;
  }
  if (isDict(value)) {
    const entries = Object.keys(value).map(
      (key) => `${pyStrRepr(key)}: ${pyRepr(value[key])}`,
    );
    return `{${entries.join(', ')}}`;
  }
  return pyStrRepr(String(value));
}

/** CPython `str()`: identical to `repr` except strings stay unquoted. */
export function pyStr(value: unknown): string {
  return typeof value === 'string' ? value : pyRepr(value);
}

/** `type(value).__name__` for the JSON-shaped values this port handles. */
export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'bigint') return 'int';
  if (value instanceof PyFloat) return 'float';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}
