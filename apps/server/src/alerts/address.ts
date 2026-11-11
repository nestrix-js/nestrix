/**
 * Which resolved addresses a webhook may connect to (SSRF protection, docs/backlog/phase-7.md).
 *
 * `blockedReason(address)` returns why an IP literal is refused, or `undefined` when it is a
 * public unicast address. Refused (IPv4): unspecified and "this network" 0/8, private 10/8,
 * 172.16/12, 192.168/16, shared (CGNAT) 100.64/10, loopback 127/8, link-local 169.254/16, IETF
 * protocol assignments 192.0.0/24, documentation 192.0.2/24, 198.51.100/24, 203.0.113/24,
 * benchmarking 198.18/15, multicast 224/4, reserved 240/4 and broadcast. Refused (IPv6):
 * unspecified `::`, loopback `::1`, IPv4-compatible `::/96`, discard `100::/64`, Teredo
 * `2001::/32`, documentation `2001:db8::/32`, unique-local `fc00::/7`, link-local `fe80::/10`,
 * site-local `fec0::/10`, multicast `ff00::/8`, NAT64 local-use `64:ff9b:1::/48`; and the IPv4
 * address embedded in IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and 6to4 `2002::/16`
 * is checked against the IPv4 rules. IPv6 is otherwise allowed only inside global unicast
 * `2000::/3`, minus documentation `3fff::/20`, benchmarking `2001:2::/48`, ORCHID
 * `2001:10::/28` and `2001:20::/28`, and IPv4-translated `::ffff:0:0:0/96` is refused.
 * Anything that does not parse is refused.
 *
 * Written by hand, not with `net.BlockList`, so the IPv4-mapped and embedded forms are handled
 * explicitly and tested (`test/alerts/unit.test.ts`).
 */
import { isIPv4, isIPv6 } from "node:net";

/** The four octets of a dotted-quad IPv4 address, or `undefined`. */
export function parseIPv4(text: string): number[] | undefined {
  if (!isIPv4(text)) return undefined;
  return text.split(".").map(Number);
}

/** The eight 16-bit groups of an IPv6 address (zone id stripped), or `undefined`. */
export function parseIPv6(input: string): number[] | undefined {
  const text = input.split("%", 1)[0] as string;
  if (!isIPv6(text)) return undefined;
  let head = text;
  let tailV4: number[] = [];
  const lastColon = head.lastIndexOf(":");
  const last = head.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (v4 === undefined) return undefined;
    tailV4 = [
      ((v4[0] as number) << 8) | (v4[1] as number),
      ((v4[2] as number) << 8) | (v4[3] as number),
    ];
    head = head.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::", "a::1.2.3.4" leaves "a::", "a:b:1.2.3.4" leaves "a:b:"
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const groupsWanted = 8 - tailV4.length;
  const parseGroups = (s: string) =>
    s === "" ? [] : s.split(":").map((g) => Number.parseInt(g, 16));
  let groups: number[];
  const gap = head.indexOf("::");
  if (gap >= 0) {
    const left = parseGroups(head.slice(0, gap));
    const right = parseGroups(head.slice(gap + 2));
    const fill = groupsWanted - left.length - right.length;
    if (fill < 0) return undefined;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = parseGroups(head);
  }
  groups = [...groups, ...tailV4];
  if (
    groups.length !== 8 ||
    groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)
  ) {
    return undefined;
  }
  return groups;
}

function v4Reason(o: readonly number[]): string | undefined {
  const [a, b, c] = o as [number, number, number, number];
  if (a === 0) return "unspecified";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "shared (CGNAT)";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 0 && c === 0) return "IETF protocol assignment";
  if (a === 192 && b === 0 && c === 2) return "documentation";
  if (a === 192 && b === 168) return "private";
  if (a === 198 && (b === 18 || b === 19)) return "benchmarking";
  if (a === 198 && b === 51 && c === 100) return "documentation";
  if (a === 203 && b === 0 && c === 113) return "documentation";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved";
  return undefined;
}

function v4FromGroups(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function v6Reason(g: readonly number[]): string | undefined {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const firstFiveZero =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstFiveZero && g5 === 0) {
    if (g6 === 0 && g7 === 0) return "unspecified";
    if (g6 === 0 && g7 === 1) return "loopback";
    return "IPv4-compatible";
  }
  if (firstFiveZero && g5 === 0xffff) {
    const reason = v4Reason(v4FromGroups(g6, g7));
    return reason === undefined ? undefined : `IPv4-mapped ${reason}`;
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return "NAT64 local-use";
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      const reason = v4Reason(v4FromGroups(g6, g7));
      return reason === undefined ? undefined : `NAT64 ${reason}`;
    }
  }
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0xffff &&
    g5 === 0
  ) {
    return "IPv4-translated";
  }
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard";
  if (g0 === 0x2002) {
    const reason = v4Reason(v4FromGroups(g1, g2));
    return reason === undefined ? undefined : `6to4 ${reason}`;
  }
  if ((g0 & 0xfe00) === 0xfc00) return "unique-local";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local";
  if ((g0 & 0xffc0) === 0xfec0) return "site-local";
  if ((g0 & 0xff00) === 0xff00) return "multicast";
  // Only global unicast 2000::/3 is allowed, minus the non-global ranges inside it.
  if ((g0 & 0xe000) !== 0x2000) return "not global unicast";
  if (g0 === 0x2001 && g1 === 0) return "Teredo";
  if (g0 === 0x2001 && g1 === 0xdb8) return "documentation";
  if (g0 === 0x2001 && g1 === 2 && g2 === 0) return "benchmarking";
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x10) return "ORCHID";
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x20) return "ORCHIDv2";
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return "documentation";
  return undefined;
}

/**
 * Why a webhook may not connect to `address` (an IP literal, IPv6 without brackets), or
 * `undefined` when it is a public unicast address. Never throws.
 */
export function blockedReason(address: string): string | undefined {
  try {
    const v4 = parseIPv4(address);
    if (v4 !== undefined) return v4Reason(v4);
    const v6 = parseIPv6(address);
    if (v6 !== undefined) return v6Reason(v6);
    return "not an IP address";
  } catch {
    return "not an IP address";
  }
}

/** A URL's hostname as an IP literal (IPv6 brackets removed), or `undefined` for a name. */
export function ipLiteral(hostname: string): string | undefined {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  return isIPv4(bare) || isIPv6(bare) ? bare : undefined;
}
