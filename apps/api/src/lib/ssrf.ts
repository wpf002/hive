import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';

/**
 * SSRF guard for operator-supplied outbound URLs (alert webhooks).
 *
 * This matters more here than it looks: the process that POSTs to an alert
 * webhook is the scheduler, which holds API_AUTH_TOKEN, RESEND_API_KEY and
 * DATABASE_URL and sits inside the control-plane network. An unvalidated
 * webhook URL turns any logged-in user into a request forger with that
 * vantage point — including the cloud metadata endpoint.
 *
 * Mirrors the Python guard the monitor worker already uses
 * (workers/monitor/src/hive_monitor/http_check.py): resolve the host and refuse
 * if ANY address it maps to is non-public, so a DNS name can't smuggle in an
 * internal IP. Operators with genuinely internal webhook targets opt in with
 * HIVE_ALLOW_INTERNAL_WEBHOOKS=true.
 *
 * Known limitation, shared with the Python version: this validates at
 * submission time, so a name that resolves publicly now and privately later
 * (DNS rebinding) is not caught. Closing that needs the check at request time
 * with a pinned address, which is a change to the scheduler's HTTP client.
 */

export class SsrfError extends Error {}

function allowInternal(): boolean {
  return String(process.env.HIVE_ALLOW_INTERNAL_WEBHOOKS ?? '').toLowerCase() === 'true';
}

/** True when the address is globally routable — i.e. not private/loopback/link-local/etc. */
export function isPublicAddress(addr: string): boolean {
  if (isIPv4(addr)) return isPublicIPv4(addr);
  return isPublicIPv6(addr);
}

function isPublicIPv4(addr: string): boolean {
  const p = addr.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0) return false; // IETF protocol assignments / 192.0.2.0 TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // multicast + reserved + broadcast
  return true;
}

/**
 * Expands an IPv6 address to its eight 16-bit groups, or null if unparseable.
 *
 * String-matching the textual form is not enough: `new URL()` re-serializes
 * `[::ffff:169.254.169.254]` as `[::ffff:a9fe:a9fe]`, so a check that looks for
 * a trailing dotted quad sees none and waves the metadata endpoint through.
 * Parsing to numbers is the only form that can't be spelled around.
 */
function parseIPv6(addr: string): number[] | null {
  let a = addr.toLowerCase().split('%')[0]; // strip zone id
  // A trailing dotted quad (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = a.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const octets = v4[2].split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    a = `${v4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = a.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

function isPublicIPv6(addr: string): boolean {
  const g = parseIPv6(addr);
  if (!g) return false; // unparseable — refuse rather than guess

  const allZero = g.every((x) => x === 0);
  if (allZero) return false; // ::  unspecified
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1 loopback

  // IPv4-mapped ::ffff:0:0/96 and IPv4-compatible ::/96 — judge the v4 part,
  // which is where 169.254.169.254 and 127.0.0.1 hide.
  const firstFive = g.slice(0, 5).every((x) => x === 0);
  if (firstFive && (g[5] === 0xffff || g[5] === 0)) {
    const v4addr = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPublicIPv4(v4addr);
  }
  // NAT64 well-known prefix 64:ff9b::/96 — also carries an embedded v4.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    const v4addr = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
    return isPublicIPv4(v4addr);
  }
  // 6to4 2002::/16 embeds a v4 in the next 32 bits.
  if (g[0] === 0x2002) {
    const v4addr = `${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`;
    return isPublicIPv4(v4addr);
  }

  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast ff00::/8
  if (g[0] === 0x0100 && g[1] === 0) return false; // discard-only 100::/64
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation 2001:db8::/32
  return true;
}

/**
 * Throws SsrfError unless `raw` is an http(s) URL whose host resolves entirely
 * to public addresses. Safe to call on user input; never throws anything else.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  if (allowInternal()) return;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('webhook url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError(`unsupported url scheme '${url.protocol.replace(':', '')}' (only http/https)`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap [::1]
  if (!host) throw new SsrfError('webhook url has no host');

  // A literal IP needs no resolution — and must not be handed to DNS.
  if (isIPv4(host) || host.includes(':')) {
    if (!isPublicAddress(host)) {
      throw new SsrfError(
        `refusing webhook to '${host}' — that is a non-public address. ` +
          'Set HIVE_ALLOW_INTERNAL_WEBHOOKS=true to allow internal targets.',
      );
    }
    return;
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch (e) {
    throw new SsrfError(`cannot resolve webhook host '${host}': ${(e as Error).message}`);
  }
  // Reject if ANY address is non-public, so a name resolving to both a public
  // and an internal address can't be used to slip past.
  for (const { address } of addrs) {
    if (!isPublicAddress(address)) {
      throw new SsrfError(
        `refusing webhook to '${host}' — it resolves to non-public address ${address}. ` +
          'Set HIVE_ALLOW_INTERNAL_WEBHOOKS=true to allow internal targets.',
      );
    }
  }
}
