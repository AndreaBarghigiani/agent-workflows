/**
 * `urlsplit` semantics for CPython 3.12 `urllib.parse`, covering the
 * surface the ported modules use: `scheme`, `netloc`, `path`, `query`,
 * `fragment`, `username`, `password`, `hostname` and `port`.
 *
 * Matches `urlsplit(url, scheme='', allow_fragments=True)` for `str`
 * input: leading C0-control/space characters are stripped, `\t`, `\r`
 * and `\n` are removed everywhere, the scheme is recognized only when
 * it opens the string and is `[A-Za-z][A-Za-z0-9+.-]*`, and netloc
 * validation (unbalanced brackets, bracketed-host checks via
 * `ipaddress`, and the NFKC-normalization check) raises the same
 * `ValueError`s. `None` input follows `_coerce_args` coercion — it
 * behaves like `b''` and yields all-empty components — while other
 * non-string input raises `AttributeError` like `_decode_args`.
 *
 * `port` is validated lazily like the `SplitResult.port` property:
 * non-numeric and out-of-range ports raise `ValueError` on access, not
 * at split time.
 */
import { AttributeError, ValueError } from './pyerrors.ts';
import { pyStrRepr, pyTypeName } from './pyrepr.ts';

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]*$/;
const IPV_FUTURE = /^v[a-fA-F0-9]+\..+$/;

export class UrlsplitResult {
  readonly scheme: string;
  readonly netloc: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;

  constructor(
    scheme: string,
    netloc: string,
    path: string,
    query: string,
    fragment: string,
  ) {
    this.scheme = scheme;
    this.netloc = netloc;
    this.path = path;
    this.query = query;
    this.fragment = fragment;
  }

  private userinfo(): [string | null, string | null] {
    const at = this.netloc.lastIndexOf('@');
    if (at < 0) return [null, null];
    const userinfo = this.netloc.slice(0, at);
    const colon = userinfo.indexOf(':');
    if (colon < 0) return [userinfo, null];
    return [userinfo.slice(0, colon), userinfo.slice(colon + 1)];
  }

  get username(): string | null {
    return this.userinfo()[0];
  }

  get password(): string | null {
    return this.userinfo()[1];
  }

  private hostinfo(): [string, string | null] {
    const hostinfo = this.netloc.slice(this.netloc.lastIndexOf('@') + 1);
    const bracket = hostinfo.indexOf('[');
    if (bracket >= 0) {
      const close = hostinfo.slice(bracket + 1).indexOf(']');
      const bracketed = hostinfo.slice(bracket + 1);
      if (close >= 0) {
        const rest = bracketed.slice(close + 1);
        const colon = rest.indexOf(':');
        return [bracketed.slice(0, close), colon >= 0 ? rest.slice(colon + 1) : ''];
      }
      return [bracketed, ''];
    }
    const colon = hostinfo.indexOf(':');
    if (colon < 0) return [hostinfo, ''];
    return [hostinfo.slice(0, colon), hostinfo.slice(colon + 1)];
  }

  get hostname(): string | null {
    const hostname = this.hostinfo()[0];
    if (!hostname) return null;
    // Scoped IPv6 zone info keeps its case; only the host part lowers.
    const percent = hostname.indexOf('%');
    if (percent < 0) return hostname.toLowerCase();
    return (
      hostname.slice(0, percent).toLowerCase() + hostname.slice(percent)
    );
  }

  get port(): number | null {
    const port = this.hostinfo()[1];
    if (port === null || port === '') return null;
    if (/^[0-9]+$/.test(port)) {
      const value = Number(port);
      if (!(value >= 0 && value <= 65535)) {
        throw new ValueError('Port out of range 0-65535');
      }
      return value;
    }
    throw new ValueError(
      `Port could not be cast to integer value as ${pyStrRepr(port)}`,
    );
  }
}

/** `str.isascii()` for the whole string. */
function isAscii(text: string): boolean {
  return !/[^\x00-\x7F]/.test(text);
}

/** `_splitnetloc`: netloc ends at the first of `/`, `?`, `#`. */
function splitNetloc(url: string, start: number): [string, string] {
  let delim = url.length;
  for (const char of '/?#') {
    const found = url.indexOf(char, start);
    if (found >= 0 && found < delim) delim = found;
  }
  return [url.slice(start, delim), url.slice(delim)];
}

/** `ipaddress` strict IPv4: exactly four decimal octets, no leading zeros. */
function isIpv4(address: string): boolean {
  const parts = address.split('.');
  if (parts.length !== 4) return false;
  return parts.every(
    (part) =>
      /^[0-9]+$/.test(part) &&
      !(part.length > 1 && part.startsWith('0')) &&
      Number(part) <= 255,
  );
}

/** `ipaddress` IPv6 acceptance (shape only — the parsed value is unused). */
function isIpv6(address: string): boolean {
  const zone = address.indexOf('%');
  let body = address;
  if (zone >= 0) {
    body = address.slice(0, zone);
    // `_split_scope_id`: the zone id is everything after the first `%`
    // and must be non-empty and free of further `%` characters.
    const scope = address.slice(zone + 1);
    if (scope === '' || scope.includes('%')) return false;
  }
  if (body === '::') return true;
  const sides = body.split('::');
  if (sides.length > 2) return false;
  const count = (side: string, allowIpv4: boolean): number | null => {
    if (side === '') return 0;
    const parts = side.split(':');
    let hextets = 0;
    for (const [index, part] of parts.entries()) {
      if (part === '') return null;
      // An embedded IPv4 address is only valid as the last component
      // of the whole address — never before a `::` compressor.
      if (part.includes('.')) {
        if (!allowIpv4 || index !== parts.length - 1 || !isIpv4(part)) {
          return null;
        }
        hextets += 2;
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(part)) return null;
        hextets += 1;
      }
    }
    return hextets;
  };
  const left = count(sides[0], sides.length === 1);
  const right = sides.length === 2 ? count(sides[1], true) : 0;
  if (left === null || right === null) return false;
  const total = left + right;
  // Without compression exactly eight hextets are required; with it the
  // total must leave room for at least one compressed hextet.
  return sides.length === 2 ? total < 8 : total === 8;
}

/** `_check_bracketed_host` — IPvFuture or a valid IPv6 (IPv4 refused). */
function checkBracketedHost(hostname: string): void {
  if (hostname.startsWith('v')) {
    if (!IPV_FUTURE.test(hostname)) {
      throw new ValueError('IPvFuture address is invalid');
    }
    return;
  }
  if (isIpv4(hostname)) {
    throw new ValueError('An IPv4 address cannot be in brackets');
  }
  if (!isIpv6(hostname)) {
    throw new ValueError(
      `${pyStrRepr(hostname)} does not appear to be an IPv4 or IPv6 address`,
    );
  }
}

/** `_check_bracketed_netloc` — runs when the netloc holds both brackets. */
function checkBracketedNetloc(netloc: string): void {
  const hostinfo = netloc.slice(netloc.lastIndexOf('@') + 1);
  const open = hostinfo.indexOf('[');
  if (open >= 0) {
    if (open > 0) throw new ValueError('Invalid IPv6 URL');
    const close = hostinfo.indexOf(']', open + 1);
    const rest = close >= 0 ? hostinfo.slice(close + 1) : '';
    if (rest && !rest.startsWith(':')) {
      throw new ValueError('Invalid IPv6 URL');
    }
    checkBracketedHost(hostinfo.slice(open + 1, close < 0 ? undefined : close));
    return;
  }
  const colon = hostinfo.indexOf(':');
  const hostname = colon < 0 ? hostinfo : hostinfo.slice(0, colon);
  checkBracketedHost(hostname);
}

/** `_checknetloc` — NFKC-normalized netloc must not gain separators. */
function checkNetloc(netloc: string): void {
  if (!netloc || isAscii(netloc)) return;
  const n = netloc.replace(/@|:|#|\?/g, '');
  const normalized = n.normalize('NFKC');
  if (n === normalized) return;
  for (const char of '/?#@:') {
    if (normalized.includes(char)) {
      throw new ValueError(
        `netloc ${pyStrRepr(netloc)} contains invalid characters under` +
          ' NFKC normalization',
      );
    }
  }
}

/**
 * `urlsplit(url)`. `null`/`undefined` mirrors `urlsplit(None)` (all-empty
 * components); any other non-string mirrors the `AttributeError` the
 * argument coercion raises.
 */
export function pyUrlsplit(url: unknown): UrlsplitResult {
  if (url === null || url === undefined) {
    return new UrlsplitResult('', '', '', '', '');
  }
  if (typeof url !== 'string') {
    throw new AttributeError(
      `'${pyTypeName(url)}' object has no attribute 'decode'`,
    );
  }
  let rest = url.replace(/^[\x00-\x20]+/, '').replace(/[\t\r\n]/g, '');
  let scheme = '';
  const colon = rest.indexOf(':');
  if (
    colon > 0 &&
    /^[A-Za-z]$/.test(rest[0]) &&
    SCHEME_CHARS.test(rest.slice(0, colon))
  ) {
    scheme = rest.slice(0, colon).toLowerCase();
    rest = rest.slice(colon + 1);
  }
  let netloc = '';
  if (rest.startsWith('//')) {
    [netloc, rest] = splitNetloc(rest, 2);
    if (netloc.includes('[') !== netloc.includes(']')) {
      throw new ValueError('Invalid IPv6 URL');
    }
    if (netloc.includes('[')) checkBracketedNetloc(netloc);
  }
  let fragment = '';
  let query = '';
  const hash = rest.indexOf('#');
  if (hash >= 0) {
    fragment = rest.slice(hash + 1);
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf('?');
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }
  checkNetloc(netloc);
  return new UrlsplitResult(scheme, netloc, rest, query, fragment);
}
