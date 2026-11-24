/**
 * `json.loads` semantics for CPython 3.12.
 *
 * `pyJsonLoads` parses the way `json.loads` does — the same grammar, the
 * same `JSONDecodeError` attributes on failure (`msg` and `pos`, from
 * which `line`/`column`/`char` are derived exactly like
 * `JSONDecodeError.__init__`), and the same extensions over `JSON.parse`:
 * `NaN`/`Infinity`/`-Infinity` tokens decode through `parse_constant`
 * semantics rather than failing, and a `str` beginning with U+FEFF is
 * rejected before scanning (`Unexpected UTF-8 BOM (decode using
 * utf-8-sig)`), exactly like `json.loads`.
 *
 * The scanner is a port of `json/decoder.py` and `json/scanner.py` (`strict`
 * mode, the default), adjusted for the `_json` C accelerator that actually
 * runs: it reports `Invalid control character at` and `Invalid \escape`
 * without the character repr the pure-Python fallbacks include, and points
 * `Invalid \escape` at the backslash. All positions are in Unicode code
 * points because CPython strings are code-point sequences — the document is
 * exploded to code points up front so astral characters count once.
 *
 * Materialization keeps what plain JavaScript values cannot. Objects become
 * `Map`s: JavaScript objects order integer-like keys numerically, which
 * would reorder `{"9": ..., "2": ...}` against the insertion order Python
 * dicts keep (and `__proto__` is an ordinary `Map` key, not a prototype
 * hazard). Integer tokens become `bigint` — arbitrary precision, like
 * Python `int`. Float tokens (a `.` or an exponent) become `PyFloat` so
 * `str`, `repr` and `json.dumps` can keep `2.0` distinct from `2`; the
 * wrapped `number` is the same IEEE-754 double `float()` builds. The
 * `parse_constant` non-finite tokens materialize as shared `PyFloat`
 * sentinels, mirroring `json.decoder`'s module-level constants.
 */

/**
 * A Python `float`. JSON number tokens carrying a `.` or an exponent
 * materialize as `PyFloat` so the int/float distinction survives;
 * `PyFloat.value` is the IEEE-754 double CPython's `float` produces.
 */
export class PyFloat {
  readonly value: number;

  constructor(value: number) {
    this.value = value;
  }
}

/**
 * `json.decoder.NaN`/`PosInf`/`NegInf`: CPython's decoder constructs each
 * non-finite constant once, so every `NaN`/`Infinity`/`-Infinity` token
 * materializes the same float object. Parsed NaNs then match one another
 * through the identity shortcut `in` and `==` apply before `__eq__` — the
 * only way `nan == nan` ever holds, since a `float('nan')` built
 * elsewhere is a different object and still compares unequal.
 */
const JSON_NAN = new PyFloat(NaN);
const JSON_INFINITY = new PyFloat(Infinity);
const JSON_NEG_INFINITY = new PyFloat(-Infinity);

const WHITESPACE = ' \t\n\r';

/** Simple escape characters CPython accepts after a backslash. */
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

const HEX = /[0-9A-Fa-f]/;

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE.includes(char);
}

/**
 * The internal carrier for a located error. `StopIteration` from
 * `scan_once` converts to `Expecting value` at every CPython call site, so
 * the scanner raises the final wording directly.
 */
class DecodeError extends Error {
  pos: number;
  constructor(msg: string, pos: number) {
    super(msg);
    this.pos = pos;
  }
}

/** `WHITESPACE.match(s, end).end()` — first index at or past `end` not in ` \t\n\r`. */
function whitespaceEnd(doc: string[], end: number): number {
  let index = end;
  while (index < doc.length && isWhitespace(doc[index])) index += 1;
  return index;
}

/** `string[idx:idx + lit.length] == lit` for ASCII literals. */
function startsWith(doc: string[], idx: number, literal: string): boolean {
  for (let offset = 0; offset < literal.length; offset += 1) {
    if (doc[idx + offset] !== literal[offset]) return false;
  }
  return true;
}

/**
 * `_decode_uXXXX`/`HEXDIGITS`: the four characters after `u` must all be
 * ASCII hex digits.
 */
function isHexEscape(doc: string[], uIndex: number): boolean {
  for (let offset = 1; offset <= 4; offset += 1) {
    const char = doc[uIndex + offset];
    if (char === undefined || !HEX.test(char)) return false;
  }
  return true;
}

/** A scanned JSON value and the index one past it. */
interface Scanned {
  end: number;
  value: unknown;
}

/**
 * `scanstring`: `end` is the index after the opening quote; returns the
 * decoded string and the index after the closing quote. Positions follow
 * the C accelerator. The validated literal is handed to `JSON.parse` for
 * decoding so escapes — `\uXXXX` pairs and lone surrogates included —
 * produce exactly the `str` CPython builds.
 */
function scanString(doc: string[], end: number): Scanned {
  const begin = end - 1;
  let index = end;
  for (;;) {
    while (index < doc.length) {
      const char = doc[index];
      if (char === '"' || char === '\\' || char < ' ') break;
      index += 1;
    }
    if (index === doc.length) {
      throw new DecodeError('Unterminated string starting at', begin);
    }
    const char = doc[index];
    if (char === '"') {
      return {
        end: index + 1,
        value: JSON.parse(doc.slice(begin, index + 1).join('')),
      };
    }
    if (char < ' ') {
      throw new DecodeError('Invalid control character at', index);
    }
    // `char` is the backslash; `esc` is the character after it.
    const escIndex = index + 1;
    if (escIndex >= doc.length) {
      throw new DecodeError('Unterminated string starting at', begin);
    }
    const esc = doc[escIndex];
    if (esc !== 'u') {
      if (!SIMPLE_ESCAPES.has(esc)) {
        throw new DecodeError('Invalid \\escape', index);
      }
      index = escIndex + 1;
    } else {
      if (!isHexEscape(doc, escIndex)) {
        throw new DecodeError('Invalid \\uXXXX escape', escIndex);
      }
      // Surrogate-pair folding changes the decoded value, never validity;
      // a following bad escape is still caught on the next iteration.
      index = escIndex + 5;
    }
  }
}

/** `NUMBER_RE.match` — `-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?`. */
function matchNumber(doc: string[], idx: number): number | null {
  let index = idx;
  if (doc[index] === '-') index += 1;
  if (doc[index] === '0') {
    index += 1;
  } else if (doc[index] !== undefined && doc[index] >= '1' && doc[index] <= '9') {
    index += 1;
    while (isDigit(doc[index])) index += 1;
  } else {
    return null;
  }
  if (doc[index] === '.' && isDigit(doc[index + 1])) {
    index += 2;
    while (isDigit(doc[index])) index += 1;
  }
  if (doc[index] === 'e' || doc[index] === 'E') {
    let tail = index + 1;
    if (doc[tail] === '-' || doc[tail] === '+') tail += 1;
    if (isDigit(doc[tail])) {
      tail += 1;
      while (isDigit(doc[tail])) tail += 1;
      index = tail;
    }
  }
  return index;
}

/** `scan_once`: returns the parsed value and the index after it. */
function scanOnce(doc: string[], idx: number): Scanned {
  const nextchar = doc[idx];
  if (nextchar === '"') return scanString(doc, idx + 1);
  if (nextchar === '{') return scanObject(doc, idx + 1);
  if (nextchar === '[') return scanArray(doc, idx + 1);
  if (nextchar === 'n' && startsWith(doc, idx, 'null')) {
    return { end: idx + 4, value: null };
  }
  if (nextchar === 't' && startsWith(doc, idx, 'true')) {
    return { end: idx + 4, value: true };
  }
  if (nextchar === 'f' && startsWith(doc, idx, 'false')) {
    return { end: idx + 5, value: false };
  }
  const numEnd = matchNumber(doc, idx);
  if (numEnd !== null) {
    const token = doc.slice(idx, numEnd).join('');
    if (/[.eE]/.test(token)) {
      // The matched literal is strict JSON; `JSON.parse` decodes it to
      // the same IEEE-754 double CPython's `float()` builds.
      return { end: numEnd, value: new PyFloat(JSON.parse(token)) };
    }
    // Integer tokens are Python `int`s: `bigint` keeps digits past 2**53.
    return { end: numEnd, value: BigInt(token) };
  }
  // `parse_constant` spellings CPython accepts though JSON forbids them.
  if (nextchar === 'N' && startsWith(doc, idx, 'NaN')) {
    return { end: idx + 3, value: JSON_NAN };
  }
  if (nextchar === 'I' && startsWith(doc, idx, 'Infinity')) {
    return { end: idx + 8, value: JSON_INFINITY };
  }
  if (nextchar === '-' && startsWith(doc, idx, '-Infinity')) {
    return { end: idx + 9, value: JSON_NEG_INFINITY };
  }
  throw new DecodeError('Expecting value', idx);
}

/** `JSONObject`: `end` is the index after `{`; returns the index after `}`. */
function scanObject(doc: string[], start: number): Scanned {
  // A `Map`, not a plain object: JavaScript objects order integer-like
  // keys numerically, which would reorder `{"9": ..., "2": ...}` against
  // the insertion order Python dicts keep.
  const obj = new Map<string, unknown>();
  let end = start;
  let nextchar = doc[end];
  if (nextchar !== '"') {
    if (isWhitespace(nextchar)) {
      end = whitespaceEnd(doc, end);
      nextchar = doc[end];
    }
    if (nextchar === '}') return { end: end + 1, value: obj };
    if (nextchar !== '"') {
      throw new DecodeError(
        'Expecting property name enclosed in double quotes', end);
    }
  }
  end += 1;
  for (;;) {
    const scannedKey = scanString(doc, end);
    end = scannedKey.end;
    const key = scannedKey.value as string;
    if (doc[end] !== ':') {
      end = whitespaceEnd(doc, end);
      if (doc[end] !== ':') {
        throw new DecodeError("Expecting ':' delimiter", end);
      }
    }
    end = whitespaceEnd(doc, end + 1);
    const member = scanOnce(doc, end);
    end = member.end;
    obj.set(key, member.value);
    nextchar = doc[end];
    if (isWhitespace(nextchar)) {
      end = whitespaceEnd(doc, end);
      nextchar = doc[end];
    }
    end += 1;
    if (nextchar === '}') return { end, value: obj };
    if (nextchar !== ',') {
      throw new DecodeError("Expecting ',' delimiter", end - 1);
    }
    end = whitespaceEnd(doc, end);
    nextchar = doc[end];
    end += 1;
    if (nextchar !== '"') {
      throw new DecodeError(
        'Expecting property name enclosed in double quotes', end - 1);
    }
  }
}

/** `JSONArray`: `end` is the index after `[`; returns the index after `]`. */
function scanArray(doc: string[], start: number): Scanned {
  const list: unknown[] = [];
  let end = start;
  if (isWhitespace(doc[end])) end = whitespaceEnd(doc, end);
  if (doc[end] === ']') return { end: end + 1, value: list };
  for (;;) {
    const member = scanOnce(doc, end);
    end = member.end;
    list.push(member.value);
    let nextchar = doc[end];
    if (isWhitespace(nextchar)) {
      end = whitespaceEnd(doc, end);
      nextchar = doc[end];
    }
    end += 1;
    if (nextchar === ']') return { end, value: list };
    if (nextchar !== ',') {
      throw new DecodeError("Expecting ',' delimiter", end - 1);
    }
    end = whitespaceEnd(doc, end);
  }
}

/**
 * `json.loads(text)` on a decoded string. A `str` starting with U+FEFF is
 * rejected before scanning — CPython checks for the BOM itself, since the
 * caller is meant to open such files as `utf-8-sig`. Throws the internal
 * DecodeError with the `msg`/`pos` CPython's `JSONDecodeError` carries;
 * `jsonLoadsError` exposes them as attributes.
 */
export function pyJsonLoads(text: string): unknown {
  const doc = [...text];
  if (doc[0] === '\uFEFF') {
    throw new DecodeError(
      'Unexpected UTF-8 BOM (decode using utf-8-sig)', 0);
  }
  let end = whitespaceEnd(doc, 0);
  const scanned = scanOnce(doc, end);
  end = whitespaceEnd(doc, scanned.end);
  if (end !== doc.length) {
    throw new DecodeError('Extra data', end);
  }
  return scanned.value;
}

export interface JsonDecodeError {
  /** `JSONDecodeError.msg` — the unformatted message. */
  msg: string;
  /** `JSONDecodeError.pos` — the code-point index where parsing failed. */
  pos: number;
}

/**
 * The `JSONDecodeError` CPython 3.12 `json.loads` would raise on `text`, or
 * null when CPython would parse it (which for `JSON.parse` rejects means a
 * bare `NaN`/`Infinity`/`-Infinity` token).
 */
export function jsonLoadsError(text: string): JsonDecodeError | null {
  try {
    pyJsonLoads(text);
    return null;
  } catch (error) {
    if (error instanceof DecodeError) {
      return { msg: error.message, pos: error.pos };
    }
    throw error;
  }
}

/**
 * `str(JSONDecodeError)` — `'{msg}: line {lineno} column {colno} (char
 * {pos})'` with `lineno`/`colno` derived like `JSONDecodeError.__init__`.
 */
export function jsonLoadsErrorMessage(
  text: string,
  error: JsonDecodeError,
): string {
  const doc = [...text];
  let lineno = 1;
  let lastNewline = -1;
  for (let index = 0; index < error.pos; index += 1) {
    if (doc[index] === '\n') {
      lineno += 1;
      lastNewline = index;
    }
  }
  const colno = error.pos - lastNewline;
  return `${error.msg}: line ${lineno} column ${colno} (char ${error.pos})`;
}
