// Generated consumer bootstrap for the TypeScript T3 port (issue #117,
// made the only generated launcher by the #118 cutover).
// `t3_readiness --configure-action` copies this file verbatim to
// `.agent-workflows-t3.mjs` in the consumer root.
// Plain JavaScript, no TypeScript syntax: this standalone copy is the
// trusted half of the boundary — it performs the same trust checks as
// `scripts/t3_bootstrap.py` `bootstrap()` in order (arguments first, then
// the worktree root, recorded choice, base ref, gitlink and submodule
// state), never imports anything from the pin before the checks pass, and
// `--check` never initializes a submodule. Only then does it import the
// pin's verified `scripts/t3_bootstrap.ts` to delegate to its `main`.
// Before that, the pin's `scripts/t3_readiness.ts` passes
// `t3_bootstrap.ts`'s own trust check — a real non-symlink file inside
// the library whose bytes equal `git show HEAD:scripts/t3_readiness.ts`.
// A pin that still carries only `scripts/t3_bootstrap.py` or
// `scripts/t3_readiness.py` is reported — `Pinned <name>.py needs
// migration to <name>.ts`, exit 1, no traceback; a pin carrying neither
// reports `pinned library scripts/t3_bootstrap.ts is unavailable` under
// the `T3 bootstrap: ` prefix.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONFIG = '.agent-workflows-t3.json';
const READINESS = 'scripts/t3_readiness.ts';
const READINESS_PY = 'scripts/t3_readiness.py';
const HELPER = 'scripts/t3_bootstrap.ts';
const HELPER_PY = 'scripts/t3_bootstrap.py';
const FIELDS = new Set(['choice', 'library', 'base', 'profiles', 'memory']);
// Legacy files may still carry an ignored consumer skill selection.
const LEGACY_FIELDS = new Set([...FIELDS, 'skills']);

// --- Python value semantics -----------------------------------------------

// Python `str.strip()` whitespace: CPython's set includes \x1c-\x1f and
// \x85 (which JavaScript `\s` lacks) plus the Unicode separators — minus
// U+FEFF, which Python does not count as whitespace.
const PY_WS =
  '\t\n\v\f\r \x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004' +
  '\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
const PY_WS_CLASS =
  '\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029' +
  '\\u202f\\u205f\\u3000';
const PY_WS_RE = new RegExp(`[${PY_WS_CLASS}]+`, 'u');
const PY_WS_ONE = new RegExp(`[${PY_WS_CLASS}]`, 'u');

/** Python `str.strip()` over the CPython whitespace set. */
function pyStrip(text) {
  let start = 0;
  let end = text.length;
  while (start < end && PY_WS.includes(text[start])) start += 1;
  while (end > start && PY_WS.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** `text.split()` with no separator — runs of whitespace, ends stripped. */
function pySplit(text) {
  const stripped = pyStrip(text);
  return stripped === '' ? [] : stripped.split(PY_WS_RE);
}

/** `text.split(None, 1)` — first field, then the remainder left-stripped. */
function pySplit1(text) {
  const stripped = pyStrip(text);
  const match = PY_WS_ONE.exec(stripped);
  if (match === null) return [stripped];
  return [stripped.slice(0, match.index), pyStrip(stripped.slice(match.index))];
}

/** `text.splitlines()` — universal newlines, no keepends. */
function pySplitlines(text) {
  if (text === '') return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** `repr()` of a Python str — single-quoted with CPython's escapes. */
function pyStrRepr(value) {
  const escapes = {
    '\\': '\\\\',
    "'": "\\'",
    '\n': '\\n',
    '\r': '\\r',
    '\t': '\\t',
  };
  let out = "'";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (escapes[char] !== undefined) out += escapes[char];
    else if (code < 32 || code === 127) {
      out += `\\x${code.toString(16).padStart(2, '0')}`;
    } else out += char;
  }
  return out + "'";
}

// --- Python dict access -------------------------------------------------------
//
// `pyJsonLoads` materializes JSON objects as `Map`s — JavaScript objects
// order integer-like keys numerically, which would reorder
// `{"9": ..., "2": ...}` against the insertion order Python dicts keep.

function isDict(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dictHas(mapping, key) {
  return mapping instanceof Map
    ? mapping.has(key)
    : Object.hasOwn(mapping, key);
}

function dictGet(mapping, key) {
  return mapping instanceof Map ? mapping.get(key) : mapping[key];
}

function dictGetOr(mapping, key, fallback) {
  return dictHas(mapping, key) ? dictGet(mapping, key) : fallback;
}

function dictKeys(mapping) {
  return mapping instanceof Map ? [...mapping.keys()] : Object.keys(mapping);
}

// --- Filesystem helpers -----------------------------------------------------

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSym(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `Path.resolve()` — realpath when the entry exists, normalized else. */
function pyResolve(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Map a Node errno error's code to Python's `[Errno N] {strerror}`. */
const OS_ERRNO = {
  ENOENT: [2, 'No such file or directory'],
  ENOTDIR: [20, 'Not a directory'],
  EISDIR: [21, 'Is a directory'],
  EEXIST: [17, 'File exists'],
  EACCES: [13, 'Permission denied'],
  EPERM: [1, 'Operation not permitted'],
  ELOOP: [40, 'Too many levels of symbolic links'],
  ENAMETOOLONG: [36, 'File name too long'],
};

const OS_ERROR_NAMES = {
  ENOENT: 'FileNotFoundError',
  ENOTDIR: 'NotADirectoryError',
  EISDIR: 'IsADirectoryError',
  EEXIST: 'FileExistsError',
  EACCES: 'PermissionError',
  EPERM: 'PermissionError',
  EROFS: 'PermissionError',
  ELOOP: 'OSError',
  ENAMETOOLONG: 'OSError',
};

/** Map a Node errno error to the name of the OSError subclass Python raises. */
function osErrorName(error) {
  const code = error?.code;
  return (code && OS_ERROR_NAMES[code]) || 'OSError';
}

/** `str(OSError)` for a Node errno error. */
function pyOsError(error) {
  const pair = error?.code !== undefined ? OS_ERRNO[error.code] : undefined;
  if (pair === undefined) return error;
  const [number, strerror] = pair;
  const suffix = error?.path !== undefined ? `: '${error.path}'` : '';
  const renamed = new Error(`[Errno ${number}] ${strerror}${suffix}`);
  renamed.name = osErrorName(error);
  return renamed;
}

/** `str(error)` for embedding in diagnostic messages. */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// --- PurePosixPath subset -----------------------------------------------------

/**
 * `PurePosixPath(value)` parts: absolute flag, the components with `.` and
 * empty segments dropped (`..` kept), and the `as_posix()` spelling.
 */
function purePath(value) {
  const absolute = value.startsWith('/');
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  let asPosix = (absolute ? '/' : '') + parts.join('/');
  if (asPosix === '') asPosix = absolute ? '/' : '.';
  return { absolute, parts, asPosix };
}

// --- `Path.read_text()` decoding (inlined port of scripts/lib/pyio.ts) --------
//
// The standalone copy cannot import the pin, so the strict `utf-8` decode
// behind `read_text()` is inlined: invalid bytes raise the
// `UnicodeDecodeError` whose `str()` CPython 3.12 prints verbatim —
// `'utf-8' codec can't decode byte 0xNN in position N: reason` (or `bytes
// in position N-M` for a multi-byte span) — while a leading BOM stays
// U+FEFF like the plain codec. `_load` lets the decode failure reach
// stderr unwrapped: a `ValueError`, not the `OSError`/`JSONDecodeError`
// the `Cannot read` prefix covers.

/** `UnicodeDecodeError` — a `ValueError` under Python's hierarchy. */
class UnicodeDecodeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnicodeDecodeError';
  }
}

/**
 * CPython 3.12's strict UTF-8 validation: where the first decoding
 * failure sits and which of its three reasons applies (`invalid start
 * byte`, `invalid continuation byte`, `unexpected end of data`). The
 * span is the valid prefix of the attempted sequence — one byte for a
 * bad start byte or a first bad continuation, more when later
 * continuations fail or the data ends mid-sequence — because
 * `str(UnicodeDecodeError)` prints `byte 0x{hex} in position {start}`
 * for a single byte and `bytes in position {start}-{end - 1}` for
 * longer spans. null when the input decodes cleanly; CPython and the
 * WHATWG decoder below accept the same sequences, so a clean scan means
 * the decode emits no replacements.
 */
function utf8Error(data) {
  let index = 0;
  while (index < data.length) {
    const first = data[index];
    if (first < 0x80) {
      index += 1;
      continue;
    }
    let length = 0;
    // The first continuation's valid range narrows for the boundary
    // start bytes (overlongs, surrogates, above U+10FFFF); every later
    // continuation must sit in 0x80-0xBF.
    let low = 0x80;
    let high = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
    } else if (first === 0xe0) {
      length = 3;
      low = 0xa0;
    } else if (
      (first >= 0xe1 && first <= 0xec) ||
      first === 0xee ||
      first === 0xef
    ) {
      length = 3;
    } else if (first === 0xed) {
      length = 3;
      high = 0x9f;
    } else if (first === 0xf0) {
      length = 4;
      low = 0x90;
    } else if (first >= 0xf1 && first <= 0xf3) {
      length = 4;
    } else if (first === 0xf4) {
      length = 4;
      high = 0x8f;
    } else {
      return {
        start: index,
        end: index + 1,
        reason: 'invalid start byte',
      };
    }
    for (let offset = 1; offset < length; offset += 1) {
      const position = index + offset;
      if (position >= data.length) {
        return {
          start: index,
          end: data.length,
          reason: 'unexpected end of data',
        };
      }
      const continuation = data[position];
      const floor = offset === 1 ? low : 0x80;
      const ceiling = offset === 1 ? high : 0xbf;
      if (continuation < floor || continuation > ceiling) {
        return {
          start: index,
          end: position,
          reason: 'invalid continuation byte',
        };
      }
    }
    index += length;
  }
  return null;
}

/**
 * `bytes.decode("utf-8")` — strict UTF-8, the BOM left as U+FEFF like
 * the plain codec. A failure raises `UnicodeDecodeError` carrying
 * CPython 3.12's `str()` wording, since diagnostics print `str(error)`.
 */
function pyDecodeUtf8(data) {
  const error = utf8Error(data);
  if (error !== null) {
    const detail =
      error.end === error.start + 1
        ? `byte 0x${data[error.start].toString(16).padStart(2, '0')}` +
          ` in position ${error.start}`
        : `bytes in position ${error.start}-${error.end - 1}`;
    throw new UnicodeDecodeError(
      `'utf-8' codec can't decode ${detail}: ${error.reason}`,
    );
  }
  // `ignoreBOM` keeps a leading BOM as U+FEFF in the decoded text, like
  // the plain `utf-8` codec.
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
}

// --- json.loads semantics (inlined port of scripts/lib/pyloads.ts) ------------
//
// The standalone copy cannot import the pin, so `json.loads` is inlined:
// the same grammar, the same `JSONDecodeError` `msg`/`pos`, and the same
// `NaN`/`Infinity`/`-Infinity` and U+FEFF-BOM behavior, so `Cannot read
// .agent-workflows-t3.json` reports CPython's `str(JSONDecodeError)` —
// `'{msg}: line {lineno} column {colno} (char {pos})'` — never V8's
// `JSON.parse` wording.

/**
 * A Python `float`. JSON number tokens carrying a `.` or an exponent
 * materialize as `PyFloat` so the int/float distinction survives;
 * `PyFloat.value` is the IEEE-754 double CPython's `float` produces.
 */
class PyFloat {
  constructor(value) {
    this.value = value;
  }
}

/**
 * `json.decoder.NaN`/`PosInf`/`NegInf`: CPython's decoder constructs each
 * non-finite constant once, so every `NaN`/`Infinity`/`-Infinity` token
 * materializes the same float object.
 */
const JSON_NAN = new PyFloat(NaN);
const JSON_INFINITY = new PyFloat(Infinity);
const JSON_NEG_INFINITY = new PyFloat(-Infinity);

const WHITESPACE = ' \t\n\r';

/** Simple escape characters CPython accepts after a backslash. */
const SIMPLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't']);

const HEX = /[0-9A-Fa-f]/;

function isDigit(char) {
  return char !== undefined && char >= '0' && char <= '9';
}

function isWhitespace(char) {
  return char !== undefined && WHITESPACE.includes(char);
}

/**
 * The internal carrier for a located error. `StopIteration` from
 * `scan_once` converts to `Expecting value` at every CPython call site, so
 * the scanner raises the final wording directly.
 */
class DecodeError extends Error {
  constructor(msg, pos) {
    super(msg);
    this.pos = pos;
  }
}

/** `WHITESPACE.match(s, end).end()` — first index at or past `end` not in ` \t\n\r`. */
function whitespaceEnd(doc, end) {
  let index = end;
  while (index < doc.length && isWhitespace(doc[index])) index += 1;
  return index;
}

/** `string[idx:idx + lit.length] == lit` for ASCII literals. */
function startsWith(doc, idx, literal) {
  for (let offset = 0; offset < literal.length; offset += 1) {
    if (doc[idx + offset] !== literal[offset]) return false;
  }
  return true;
}

/**
 * `_decode_uXXXX`/`HEXDIGITS`: the four characters after `u` must all be
 * ASCII hex digits.
 */
function isHexEscape(doc, uIndex) {
  for (let offset = 1; offset <= 4; offset += 1) {
    const char = doc[uIndex + offset];
    if (char === undefined || !HEX.test(char)) return false;
  }
  return true;
}

/**
 * `scanstring`: `end` is the index after the opening quote; returns the
 * decoded string and the index after the closing quote. Positions follow
 * the C accelerator. The validated literal is handed to `JSON.parse` for
 * decoding so escapes — `\uXXXX` pairs and lone surrogates included —
 * produce exactly the `str` CPython builds.
 */
function scanString(doc, end) {
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
function matchNumber(doc, idx) {
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
function scanOnce(doc, idx) {
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
function scanObject(doc, start) {
  // A `Map`, not a plain object: JavaScript objects order integer-like
  // keys numerically, which would reorder `{"9": ..., "2": ...}` against
  // the insertion order Python dicts keep.
  const obj = new Map();
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
    const key = scannedKey.value;
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
function scanArray(doc, start) {
  const list = [];
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
function pyJsonLoads(text) {
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

/**
 * The `JSONDecodeError` CPython 3.12 `json.loads` would raise on `text`, or
 * null when CPython would parse it (which for `JSON.parse` rejects means a
 * bare `NaN`/`Infinity`/`-Infinity` token).
 */
function jsonLoadsError(text) {
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
function jsonLoadsErrorMessage(text, error) {
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

// --- Trusted bootstrap (mirrors scripts/t3_bootstrap.py `bootstrap()`) --------

/**
 * Raised for the pinned-helper migration path: the message reaches stderr
 * verbatim — one line, no `T3 bootstrap:` prefix, no traceback.
 */
class MigrationError extends Error {}

function _git(cwd, args, check = true) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  const status = result.status === null ? 1 : result.status;
  if (check && status) {
    throw new Error(
      pyStrip(result.stderr ?? '') || `git ${args.join(' ')} failed`,
    );
  }
  return {
    status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function _safe_relative(value, label) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    [...value].some(
      (c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127,
    )
  ) {
    throw new Error(`${label} must be a nonempty relative path`);
  }
  const path = purePath(value);
  if (
    path.absolute ||
    path.parts.includes('..') ||
    path.parts.length === 0 ||
    path.asPosix !== value
  ) {
    throw new Error(`Unsafe ${label}: ${pyStrRepr(value)}`);
  }
  return path.parts;
}

function _load(root) {
  const config = join(root, CONFIG);
  if (isSym(config) || !isFile(config)) {
    throw new Error(
      `Missing or unsafe ${CONFIG}; make an explicit T3 choice first`,
    );
  }
  let text;
  try {
    // `pyDecodeUtf8` over the raw bytes — strict, so the errno error
    // reaching `pyOsError` keeps its code/path for the `[Errno N]`
    // wording and undecodable bytes raise `UnicodeDecodeError` instead of
    // decoding to U+FFFD replacements.
    text = pyDecodeUtf8(readFileSync(config));
  } catch (error) {
    // `UnicodeDecodeError` is a `ValueError`, not the `OSError` or
    // `JSONDecodeError` `t3_bootstrap.py` wraps in `Cannot read`.
    if (error instanceof UnicodeDecodeError) throw error;
    throw new Error(
      `Cannot read ${CONFIG}: ${errorText(pyOsError(error))}`,
    );
  }
  // Text mode's universal newlines: `\r\n` and a bare `\r` both read
  // `\n`, so the JSON scan reports positions in the text Python scanned.
  text = text.replace(/\r\n?/g, '\n');
  const decode = jsonLoadsError(text);
  if (decode !== null) {
    throw new Error(
      `Cannot read ${CONFIG}: ${jsonLoadsErrorMessage(text, decode)}`,
    );
  }
  const data = pyJsonLoads(text);
  const keys = isDict(data) ? dictKeys(data) : [];
  const fieldSet = new Set(keys);
  const exact = (wanted) =>
    fieldSet.size === wanted.size && [...wanted].every((k) => fieldSet.has(k));
  if (!isDict(data) || (!exact(FIELDS) && !exact(LEGACY_FIELDS))) {
    throw new Error(
      `${CONFIG} must declare exactly ` +
        `['base', 'choice', 'library', 'memory', 'profiles'] ` +
        `(a legacy skills array is ignored)`,
    );
  }
  const choice = dictGet(data, 'choice');
  if (choice !== 'enabled' && choice !== 'declined') {
    throw new Error('choice must be enabled or declined');
  }
  if (choice === 'declined') return data;
  _safe_relative(dictGet(data, 'library'), 'library');
  const base = dictGet(data, 'base');
  if (
    typeof base !== 'string' ||
    base === '' ||
    base.startsWith('-') ||
    [...base].some((c) => c.codePointAt(0) < 32)
  ) {
    throw new Error('base must be a nonempty resolvable ref');
  }
  const profiles = dictGet(data, 'profiles');
  if (!Array.isArray(profiles)) {
    throw new Error('profiles must be an array');
  }
  for (const name of profiles) {
    const last = typeof name === 'string' ? basename(name) : name;
    if (
      typeof name !== 'string' ||
      name === '' ||
      last !== name ||
      !name.endsWith('.toml')
    ) {
      throw new Error('Invalid profile selection');
    }
  }
  if (profiles.length !== new Set(profiles).size) {
    throw new Error('Duplicate profile selection');
  }
  const memory = dictGet(data, 'memory');
  const memoryKeys = isDict(memory) ? new Set(dictKeys(memory)) : new Set();
  const memoryOk =
    (memoryKeys.size === 1 && memoryKeys.has('routing_source')) ||
    (memoryKeys.size === 2 &&
      memoryKeys.has('enabled') &&
      memoryKeys.has('routing_source'));
  if (!isDict(memory) || !memoryOk) {
    throw new Error(
      'memory must declare routing_source (a legacy enabled boolean is tolerated)',
    );
  }
  if (dictHas(memory, 'enabled') && typeof dictGet(memory, 'enabled') !== 'boolean') {
    throw new Error('memory enabled must be a boolean');
  }
  if (dictGet(memory, 'routing_source') !== null) {
    _safe_relative(dictGet(memory, 'routing_source'), 'memory.routing_source');
  }
  if (
    dictGetOr(memory, 'enabled', undefined) === false &&
    dictGet(memory, 'routing_source') !== null
  ) {
    throw new Error(
      'Memory-disabled consumers must not declare a routing source',
    );
  }
  return data;
}

function _worktree_root(root) {
  const top = pyResolve(
    pyStrip(_git(root, ['rev-parse', '--show-toplevel']).stdout),
  );
  if (top !== root) {
    throw new Error(`Bootstrap must run at the worktree root (${top})`);
  }
}

function _base(root, base) {
  const resolved = _git(
    root,
    ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    false,
  );
  if (resolved.status) {
    throw new Error(
      `Base ${pyStrRepr(base)} does not resolve to a commit; ` +
        'no submodule was initialized',
    );
  }
  const ancestor = _git(
    root,
    ['merge-base', '--is-ancestor', pyStrip(resolved.stdout), 'HEAD'],
    false,
  );
  if (ancestor.status) {
    throw new Error(
      `Base ${pyStrRepr(base)} is not an ancestor of HEAD; ` +
        'no submodule was initialized',
    );
  }
}

function _gitlink(root, rel) {
  const path = rel.join('/');
  const indexed = _git(root, ['ls-files', '-s', '-z', '--', path], false);
  if (indexed.status) {
    throw new Error('Cannot inspect the library index entry');
  }
  const lines = indexed.stdout.split('\0').filter((line) => line !== '');
  if (lines.length !== 1 || !/^160000 ([0-9a-f]+) 0\t/.test(lines[0])) {
    throw new Error(
      'Declared library must have one stage-0 gitlink index entry; ' +
        'resolve conflicts first',
    );
  }
  const committed = _git(root, ['ls-tree', '-z', 'HEAD', '--', path])
    .stdout.split('\0')
    .filter((line) => line !== '');
  if (committed.length !== 1 || !committed[0].startsWith('160000 commit ')) {
    throw new Error('Declared library is not a committed submodule gitlink');
  }
  const index_pin = pySplit(lines[0])[1];
  const head_pin = pySplit(committed[0])[2].split('\t', 1)[0];
  if (index_pin !== head_pin) {
    throw new Error(
      'Submodule index pin differs from committed HEAD; review the pin',
    );
  }
  if (
    lines[0].slice(lines[0].indexOf('\t') + 1) !== path ||
    committed[0].slice(committed[0].indexOf('\t') + 1) !== path
  ) {
    throw new Error('Declared path must match the exact gitlink');
  }
  const modules = join(root, '.gitmodules');
  if (isSym(modules) || !isFile(modules)) {
    throw new Error('Tracked .gitmodules is missing or unsafe');
  }
  for (const diffArgs of [
    ['diff', '--quiet', '--', '.gitmodules'],
    ['diff', '--cached', '--quiet', 'HEAD', '--', '.gitmodules'],
  ]) {
    if (_git(root, diffArgs, false).status) {
      throw new Error(
        '.gitmodules differs from committed HEAD; review before initializing',
      );
    }
  }
  const configured = _git(
    root,
    [
      'config',
      '--blob',
      'HEAD:.gitmodules',
      '--get-regexp',
      '^submodule\\..*\\.path$',
    ],
    false,
  );
  if (configured.status) {
    throw new Error('Cannot read submodule paths from .gitmodules');
  }
  const paths = [];
  for (const line of pySplitlines(configured.stdout)) {
    const fields = pySplit1(line);
    if (fields.length === 2) paths.push(fields[1]);
  }
  if (!paths.includes(path)) {
    throw new Error(
      'Declared library path does not match a .gitmodules entry',
    );
  }
  const tracked = _git(root, ['ls-files', '--error-unmatch', '.gitmodules'], false);
  if (tracked.status) {
    throw new Error('.gitmodules must be tracked by the worktree');
  }
  return index_pin;
}

function _library_path(root, rel) {
  let current = root;
  for (const part of rel) {
    current = join(current, part);
    if (isSym(current)) {
      throw new Error(`Library path contains a symlink: ${current}`);
    }
  }
  return current;
}

function _initialized(library) {
  const dotgit = join(library, '.git');
  if (!(isFile(dotgit) || isDir(dotgit)) || isSym(dotgit)) return false;
  const top = _git(library, ['rev-parse', '--show-toplevel'], false);
  return (
    top.status === 0 &&
    pyResolve(pyStrip(top.stdout)) === pyResolve(library)
  );
}

function _verify_library(library, pin) {
  if (!_initialized(library)) {
    throw new Error('Library is not an initialized standalone submodule');
  }
  const actual = pyStrip(_git(library, ['rev-parse', 'HEAD']).stdout);
  if (actual !== pin) {
    throw new Error(
      'Initialized library HEAD differs from the committed gitlink pin',
    );
  }
  const status = pyStrip(_git(library, ['status', '--porcelain']).stdout);
  if (status) {
    throw new Error(
      'Pinned library worktree is dirty; review local changes before using it',
    );
  }
}

/**
 * `helper.resolve(strict=True).relative_to(library.resolve(strict=True))`:
 * any escape or resolution failure is the pinned-helper refusal.
 */
function _helper_inside(library, helper) {
  try {
    const inside = relative(realpathSync(library), realpathSync(helper));
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error('outside');
    }
  } catch {
    throw new Error('Pinned helper resolves outside the library');
  }
}

// --- argparse-compatible command line -----------------------------------------

function prog() {
  return basename(process.argv[1] ?? 't3_bootstrap.mjs');
}

function usageText() {
  return `usage: ${prog()} [-h] [--check]`;
}

function helpText() {
  return (
    `${usageText()}\n` +
    '\n' +
    'Bootstrap the pinned agent-workflows submodule in a fresh worktree.\n' +
    '\n' +
    'options:\n' +
    '  -h, --help  show this help message and exit\n' +
    '  --check     check prerequisites without initializing or preparing\n'
  );
}

/** Raised to unwind `parser.error`/`--help` through the entry point. */
class ExitError extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function parserError(message) {
  process.stderr.write(`${usageText()}\n${prog()}: error: ${message}\n`);
  throw new ExitError(2);
}

const OPTIONS = [
  { names: ['-h', '--help'], dest: 'help', takesValue: false },
  { names: ['--check'], dest: 'check', takesValue: false },
];

function optionLabel(option) {
  return option.names.join('/');
}

function parseArgs(argv) {
  const values = {};
  const extras = [];
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
      // Python 3.12 reports the separator itself among the extras.
      extras.push(arg);
      pastSeparator = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const optName = eq < 0 ? arg : arg.slice(0, eq);
      const explicit = eq < 0 ? undefined : arg.slice(eq + 1);
      let option = OPTIONS.find((o) => o.names.includes(optName));
      if (option === undefined) {
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
              ` ${pyStrRepr(explicit)}`,
          );
        }
        process.stdout.write(helpText());
        throw new ExitError(0);
      }
      if (explicit !== undefined) {
        parserError(
          `argument ${optionLabel(option)}: ignored explicit argument` +
            ` ${pyStrRepr(explicit)}`,
        );
      }
      values[option.dest] = true;
      continue;
    }
    if (arg === '-h') {
      process.stdout.write(helpText());
      throw new ExitError(0);
    }
    if (arg.startsWith('-h')) {
      let explicit = arg.slice(2);
      let separated = explicit.startsWith('=');
      if (separated) explicit = explicit.slice(1);
      for (;;) {
        if (separated || explicit.startsWith('-')) {
          parserError(
            `argument ${optionLabel(OPTIONS[0])}: ignored explicit argument` +
              ` ${pyStrRepr(explicit)}`,
          );
        }
        if (explicit === '' || explicit[0] !== 'h') {
          process.stdout.write(helpText());
          throw new ExitError(0);
        }
        explicit = explicit.slice(1);
        separated = explicit.startsWith('=');
        if (separated) explicit = explicit.slice(1);
      }
    }
    extras.push(arg);
  }
  return { values, extras };
}

// --- Entry point ----------------------------------------------------------------

const root = pyResolve(dirname(fileURLToPath(import.meta.url)));

async function run() {
  // Arguments parse before any repository state is touched: usage errors
  // and --help must not initialize a submodule or import pinned code.
  const { values, extras } = parseArgs(process.argv.slice(2));
  if (extras.length) {
    parserError(`unrecognized arguments: ${extras.join(' ')}`);
  }
  _worktree_root(root);
  const data = _load(root);
  if (dictGet(data, 'choice') !== 'enabled') {
    throw new Error('T3 bootstrap requires an enabled choice');
  }
  _base(root, dictGet(data, 'base'));
  const rel = _safe_relative(dictGet(data, 'library'), 'library');
  const pin = _gitlink(root, rel);
  const library = _library_path(root, rel);
  if (values.check === true) {
    // --check is read-only: an uninitialized pin is reported, never
    // initialized, and nothing from the pin is imported either way.
    if (!_initialized(library)) {
      throw new Error(
        'Pinned library submodule is not initialized; ' +
          'run bootstrap without --check',
      );
    }
    _verify_library(library, pin);
    process.stdout.write(
      'Pinned library bootstrap prerequisites are ready\n',
    );
    return 0;
  }
  if (!existsSync(library)) {
    mkdirSync(dirname(library), { recursive: true });
  }
  if (!_initialized(library)) {
    if (
      existsSync(library) &&
      (!isDir(library) || readdirSync(library).length !== 0)
    ) {
      throw new Error(
        'Library destination is nonempty and is not its own ' +
          'initialized submodule; preserving it',
      );
    }
    const result = _git(
      root,
      ['submodule', 'update', '--init', '--', rel.join('/')],
      false,
    );
    if (result.status) {
      const detail =
        pyStrip(result.stderr) ||
        pyStrip(result.stdout) ||
        'git submodule update failed';
      throw new Error(
        `Could not initialize the pinned library submodule: ${detail}`,
      );
    }
  }
  _verify_library(library, pin);
  // Match `t3_bootstrap.ts` first: the pinned `scripts/t3_readiness.ts`
  // must be a real non-symlink file inside the library whose bytes equal
  // `git show HEAD:scripts/t3_readiness.ts`. Its diagnostics stay the
  // helper's and nothing is imported when they fail — so a pin missing
  // the readiness helper reports it even without `t3_bootstrap.ts`.
  const readiness = join(library, READINESS);
  if (isSym(readiness) || !isFile(readiness)) {
    const legacy = join(library, READINESS_PY);
    if (!isSym(readiness) && isFile(legacy)) {
      throw new MigrationError(
        'Pinned t3_readiness.py needs migration to t3_readiness.ts',
      );
    }
    throw new Error('Pinned t3_readiness.ts helper is missing or unsafe');
  }
  _helper_inside(library, readiness);
  const readinessExpected = _git(library, ['show', `HEAD:${READINESS}`])
    .stdout;
  if (
    !readFileSync(readiness).equals(
      Buffer.from(readinessExpected, 'utf8'),
    )
  ) {
    throw new Error('Pinned helper content differs from library HEAD');
  }
  // The readiness helper is trustworthy, so `scripts/t3_bootstrap.ts`
  // can be required and byte-verified the same way before it is
  // imported.
  const helper = join(library, HELPER);
  if (isSym(helper) || !isFile(helper)) {
    const legacy = join(library, HELPER_PY);
    if (!isSym(helper) && isFile(legacy)) {
      throw new MigrationError(
        'Pinned t3_bootstrap.py needs migration to t3_bootstrap.ts',
      );
    }
    throw new Error(`pinned library ${HELPER} is unavailable`);
  }
  _helper_inside(library, helper);
  const expected = _git(library, ['show', `HEAD:${HELPER}`]).stdout;
  if (!readFileSync(helper).equals(Buffer.from(expected, 'utf8'))) {
    throw new Error('Pinned helper content differs from library HEAD');
  }
  const module = await import(pathToFileURL(helper).href);
  return module.main(process.argv.slice(2), root);
}

try {
  process.exitCode = await run();
} catch (error) {
  if (error instanceof ExitError) {
    process.exitCode = error.code;
  } else if (error instanceof MigrationError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(
      `T3 bootstrap: ${error && error.message ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }
}
