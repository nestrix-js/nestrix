/**
 * Per-client limit on `POST /login`: at most `limit` attempts in any `windowMs` (5 per minute,
 * backlog P5-04). Every attempt that reaches the password check counts, right or wrong.
 *
 * Clients are keyed by the socket peer address, never by a forwarding header a client could set:
 * IPv4 by address, IPv6 by its /64 prefix (one host usually holds a whole /64). Behind a reverse
 * proxy every visitor shares the proxy's address and therefore one limit; that is the safe side.
 * The map is bounded: past `maxClients` the least recently seen client is forgotten.
 */
import { isIPv4, isIPv6 } from "node:net";

export type LoginRateDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

function expandIPv6(address: string): string[] | undefined {
  const zoneless = address.split("%", 1)[0] as string;
  const halves = zoneless.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 tail counts as two groups.
  const last = tail.length > 0 ? tail[tail.length - 1] : head[head.length - 1];
  const v4Groups = last?.includes(".") ? 1 : 0;
  const missing = 8 - head.length - tail.length - v4Groups;
  if (halves.length === 1 && missing !== 0) return undefined;
  if (missing < 0) return undefined;
  return [...head, ...Array<string>(missing).fill("0"), ...tail];
}

/** The rate-limit key of a socket peer address. */
export function clientKey(address: unknown): string {
  if (typeof address !== "string" || address === "") return "unknown";
  const lower = address.toLowerCase();
  if (lower.startsWith("::ffff:") && isIPv4(lower.slice(7))) {
    return lower.slice(7);
  }
  if (isIPv4(lower)) return lower;
  if (isIPv6(lower)) {
    const groups = expandIPv6(lower);
    if (groups) {
      return `${groups
        .slice(0, 4)
        .map((g) => Number.parseInt(g, 16).toString(16))
        .join(":")}::/64`;
    }
  }
  return lower;
}

export class LoginRateLimiter {
  static readonly MAX_CLIENTS = 10_000;
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => Date.now(),
    private readonly maxClients = LoginRateLimiter.MAX_CLIENTS,
  ) {}

  /** Records an attempt by `key` if allowed. */
  take(key: string): LoginRateDecision {
    const now = this.now();
    const recent = (this.attempts.get(key) ?? []).filter(
      (t) => now - t < this.windowMs && t <= now,
    );
    this.attempts.delete(key); // Re-inserted below: least recently seen first.
    if (recent.length >= this.limit) {
      this.attempts.set(key, recent);
      const oldest = recent[0] as number;
      const waitMs = this.windowMs - (now - oldest);
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }
    recent.push(now);
    this.attempts.set(key, recent);
    while (this.attempts.size > this.maxClients) {
      const oldestKey = this.attempts.keys().next().value;
      if (oldestKey === undefined) break;
      this.attempts.delete(oldestKey);
    }
    return { ok: true };
  }

  get size(): number {
    return this.attempts.size;
  }
}
