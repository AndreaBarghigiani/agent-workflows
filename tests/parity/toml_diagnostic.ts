/**
 * Normalize only an embedded TOML parser diagnostic tail.
 *
 * Allowed difference 3 in docs/node-port.md. The replacement is the span
 * that ends with ` (at line N, column M)`, including smol-toml's
 * `Invalid TOML document: ` prefix when that prefix introduces the span.
 * Success text that merely contains those words, such as a filename, stays
 * unchanged.
 */

const PREFIXED =
  /Invalid TOML document: ([^:();\n]*\(at line \d+, column \d+\))/g;
const TAIL = /([:();]|^)[^:();\n]*\(at line \d+, column \d+\)/g;

/** Map an embedded TOML parser diagnostic to `<toml>`. */
export function normalizeToml(text: string): string {
  return text.replace(PREFIXED, '$1').replace(TAIL, '$1<toml>');
}
