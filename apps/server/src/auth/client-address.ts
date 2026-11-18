/**
 * The client address the login limiter keys on (issue #31, D-96).
 *
 * `NESTRIX_TRUSTED_PROXIES` is a comma-separated list of CIDRs (`10.0.0.0/8`, `2001:db8::/32`) or
 * single addresses (`10.0.0.5`, `::1`). Without it, the client is always the socket peer and
 * `X-Forwarded-For` is never read. With it, and only when the socket peer is inside one of the
 * ranges, `X-Forwarded-For` is walked from right to left: each entry that is itself a trusted
 * proxy is skipped, and the first one that is not is the client. An entry that is not an IP address
 * (`unknown`, garbage) stops the walk, and the last trusted hop is used instead, so a malformed
 * header can only make clients share their proxy's limit (the safe side), never pick a key.
 * Entries in every `X-Forwarded-For` line count, in order (`rawHeaders`). `Forwarded` and
 * `X-Real-IP` are not read.
 *
 * Parsing uses `node:net` only (no dependency). IPv4-mapped IPv6 addresses (`::ffff:10.0.0.1`,
 * what a dual-stack socket reports) are compared as IPv4; a zone (`%eth0`) is dropped.
 */
import type { IncomingMessage } from "node:http";
import { BlockList, isIPv4, isIPv6 } from "node:net";

export interface TrustedProxies {
  /** The entries as given (trimmed), for messages. */
  readonly entries: readonly string[];
  readonly list: BlockList;
}

export type TrustedProxiesResult =
  | { ok: true; value: TrustedProxies | undefined }
  | { ok: false; errors: string[] };

/** An address in canonical comparison form: IPv4 dotted, or IPv6 without zone, lower case. */
export function normalizeAddress(
  value: unknown,
): { address: string; family: "ipv4" | "ipv6" } | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  let text = value.trim().toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (isIPv4(text)) return { address: text, family: "ipv4" };
  if (!isIPv6(text)) return undefined;
  if (text.startsWith("::ffff:") && isIPv4(text.slice(7))) {
    return { address: text.slice(7), family: "ipv4" };
  }
  return { address: text, family: "ipv6" };
}

/**
 * Parses `NESTRIX_TRUSTED_PROXIES`. Unset or blank: `undefined` (no proxy trusted). Every invalid
 * entry is reported; one invalid entry makes the whole value a configuration error.
 */
export function parseTrustedProxies(
  raw: string | undefined,
): TrustedProxiesResult {
  if (raw === undefined || raw.trim() === "")
    return { ok: true, value: undefined };
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const list = new BlockList();
  const errors: string[] = [];
  for (const entry of entries) {
    const slash = entry.indexOf("/");
    const addressText = slash === -1 ? entry : entry.slice(0, slash);
    const prefixText = slash === -1 ? undefined : entry.slice(slash + 1);
    // A zone or a mapped form has no place in a range: take the address as written.
    const family = isIPv4(addressText)
      ? "ipv4"
      : isIPv6(addressText) && !addressText.includes("%")
        ? "ipv6"
        : undefined;
    const max = family === "ipv4" ? 32 : 128;
    const prefix =
      prefixText === undefined
        ? max
        : /^\d{1,3}$/.test(prefixText)
          ? Number(prefixText)
          : Number.NaN;
    if (family === undefined || !Number.isInteger(prefix) || prefix > max) {
      errors.push(
        `NESTRIX_TRUSTED_PROXIES: "${entry.slice(0, 64)}" is not an IPv4 or IPv6 address or CIDR (e.g. 10.0.0.0/8, 2001:db8::/32).`,
      );
      continue;
    }
    try {
      list.addSubnet(addressText, prefix, family);
    } catch {
      errors.push(
        `NESTRIX_TRUSTED_PROXIES: "${entry.slice(0, 64)}" is not a valid range.`,
      );
    }
  }
  if (entries.length === 0) return { ok: true, value: undefined };
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: Object.freeze({ entries: Object.freeze(entries), list }),
  };
}

function isTrusted(
  trusted: TrustedProxies,
  a: { address: string; family: "ipv4" | "ipv6" },
): boolean {
  return trusted.list.check(a.address, a.family);
}

/** One `X-Forwarded-For` entry as an address: bare, `[v6]`, `[v6]:port` or `v4:port`. */
function forwardedEntry(
  entry: string,
): { address: string; family: "ipv4" | "ipv6" } | undefined {
  const direct = normalizeAddress(entry);
  if (direct) return direct;
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(entry);
  if (bracketed) return normalizeAddress(bracketed[1]);
  const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(entry);
  if (v4port) return normalizeAddress(v4port[1]);
  return undefined;
}

/** Every `X-Forwarded-For` entry, in order across header lines. */
function forwardedFor(req: IncomingMessage): string[] {
  const out: string[] = [];
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (String(raw[i]).toLowerCase() !== "x-forwarded-for") continue;
      for (const part of String(raw[i + 1]).split(",")) {
        const t = part.trim();
        if (t !== "") out.push(t);
      }
    }
  }
  return out;
}

/**
 * The address of the client behind `req` (see the file comment). Returns the socket peer, in
 * normalised form, unless it is a trusted proxy; `undefined` only when the socket has no
 * address. Never throws.
 */
export function clientAddressOf(
  req: IncomingMessage,
  trusted: TrustedProxies | undefined,
): string | undefined {
  try {
    const raw = req.socket?.remoteAddress;
    const peer = normalizeAddress(raw);
    if (peer === undefined) return typeof raw === "string" ? raw : undefined;
    if (trusted === undefined || !isTrusted(trusted, peer)) return peer.address;
    let current = peer;
    const entries = forwardedFor(req);
    for (let i = entries.length - 1; i >= 0; i--) {
      const hop = forwardedEntry(entries[i] as string);
      // Not an address: what lies left of it cannot be trusted; keep the last trusted hop.
      if (hop === undefined) return current.address;
      current = hop;
      if (!isTrusted(trusted, hop)) return hop.address;
    }
    // Every hop trusted (or no header): the leftmost one is the client.
    return current.address;
  } catch {
    return req.socket?.remoteAddress;
  }
}
