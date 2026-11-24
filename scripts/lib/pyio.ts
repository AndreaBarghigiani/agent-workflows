/**
 * `Path(path).read_text()` semantics for the ported modules.
 *
 * CPython's `read_text()` opens in text mode with the platform default
 * encoding (UTF-8 on the systems this tooling runs on) and universal
 * newlines, so two details differ from a naive decode: `\r\n` and bare
 * `\r` line endings arrive as `\n`, and a leading byte-order mark stays
 * in the text as U+FEFF — the codec is `utf-8`, not `utf-8-sig`. Both
 * matter downstream: `json.loads` sees the same string Python produces,
 * including the BOM it rejects.
 *
 * `pyDecodeUtf8` is the strict `bytes.decode("utf-8")` half of the same
 * codec for the sites that read bytes rather than text; both share the
 * `str(UnicodeDecodeError)` wording CPython 3.12 prints (`'utf-8' codec
 * can't decode byte 0xNN in position N: reason`), because diagnostics
 * surface `str(error)` verbatim.
 *
 * Failures are renamed to the Python exception classes `read_text()`
 * raises — `UnicodeDecodeError` for undecodable bytes, the `OSError`
 * subclasses for I/O — so callers surface the same error the original
 * does without translating at each site.
 */
import { readFileSync } from 'node:fs';
import { osErrorName, UnicodeDecodeError } from './pyerrors.ts';

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
function utf8Error(
  data: Uint8Array,
): { start: number; end: number; reason: string } | null {
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
export function pyDecodeUtf8(data: Uint8Array): string {
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

/** `Path(path).read_text()` — UTF-8, universal newlines, BOM preserved. */
export function readText(path: string): string {
  let text: string;
  try {
    text = pyDecodeUtf8(readFileSync(path));
  } catch (error) {
    if (error instanceof UnicodeDecodeError) {
      throw error;
    }
    const renamed = new Error((error as Error).message);
    renamed.name = osErrorName(error);
    throw renamed;
  }
  // Text mode's universal newlines: `\r\n` and a bare `\r` both read `\n`.
  return text.replace(/\r\n?/g, '\n');
}
