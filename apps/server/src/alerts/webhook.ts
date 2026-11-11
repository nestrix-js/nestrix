/**
 * Outbound webhook delivery for alert notifications (docs/backlog/phase-7.md, P7-03).
 *
 * Security rules, each tested in `test/alerts/webhook.test.ts`:
 *
 * - `http:` and `https:` only; no credentials in the URL.
 * - The host is resolved once per attempt (`lookup`, every address), and the attempt is refused
 *   when **any** address is private, loopback, link-local, unique-local, multicast, unspecified
 *   or otherwise not public unicast (`address.ts`), unless the URL's host is listed in
 *   `NESTRIX_WEBHOOK_ALLOWED_HOSTS`. The socket then connects to the address that was checked
 *   (`host` is the IP, `Host` and TLS SNI/verification use the name), so a second DNS answer
 *   cannot swap in another address (no DNS-rebinding window).
 * - Redirects are never followed: a 3xx is a failed delivery and is not retried.
 * - Each attempt has a 5 s deadline (connect, TLS, request and response headers); the response
 *   body is never read.
 * - Up to 3 attempts with backoff (1 s, then 2 s) on network errors, timeouts, 408, 429 and 5xx.
 * - One delivery in flight per key (the rule id); later ones wait in a short queue.
 * - Nothing logged or stored here contains the secret, the URL's path or query, or a response
 *   body: results carry a status code and a short error category.
 */
import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { blockedReason, ipLiteral } from "./address.js";

export type DeliveryOutcome = "sent" | "failed" | "refused";

export interface DeliveryResult {
  delivery: DeliveryOutcome;
  attempts: number;
  /** HTTP status of the last answer, if any. */
  status: number | null;
  /**
   * `null` when sent. Otherwise a category: `invalid_url`, `refused_address`, `dns`, `timeout`,
   * `network`, `redirect`, `http_status`, `queue_full`, `closed`, `internal`.
   */
  error: string | null;
}

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

export interface WebhookSenderOptions {
  /** Normalized hostnames exempt from the address check (`ServerConfig.alerts.allowedHosts`). */
  allowedHosts: readonly string[];
  /** Per attempt. Default 5000. */
  timeoutMs?: number;
  /** Default 3. */
  maxAttempts?: number;
  /** Delay before attempt `n + 1` after attempt `n` failed (n from 1). Default 1000 * 2^(n-1). */
  backoffMs?: (attempt: number) => number;
  /** DNS resolution; replaceable in tests. Default `dns.lookup` with `all: true`. */
  lookup?: Lookup;
  /** Deliveries waiting per key beyond the one in flight. Default 16. */
  maxQueued?: number;
  /** Seconds since the epoch, for the timestamp header. Replaceable in tests. */
  nowSeconds?: () => number;
}

export const SIGNATURE_HEADER = "x-nestrix-signature";
export const TIMESTAMP_HEADER = "x-nestrix-timestamp";
const USER_AGENT = "nestrix-server-webhook/1";

/** `sha256=<hex>`: HMAC-SHA256 with `secret` of `<timestamp>.<body>`. */
export function signPayload(
  secret: string,
  timestamp: string,
  body: string,
): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const defaultLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({
    address: a.address,
    family: a.family,
  }));

/**
 * Checks a webhook URL's shape without resolving it: `undefined` when acceptable, else the
 * reason. Used by the API on create and update, and again before every attempt.
 */
export function webhookUrlProblem(
  raw: string,
  allowedHosts: readonly string[],
): string | undefined {
  const checked = checkUrl(raw, allowedHosts);
  return "url" in checked ? undefined : checked.message;
}

type UrlCheck =
  | { url: URL }
  | { error: "invalid_url" | "refused_address"; message: string };

function checkUrl(raw: string, allowedHosts: readonly string[]): UrlCheck {
  const invalid = (message: string): UrlCheck => ({
    error: "invalid_url",
    message,
  });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("webhookUrl is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return invalid("webhookUrl must use http or https.");
  }
  if (url.username !== "" || url.password !== "") {
    return invalid("webhookUrl must not contain credentials.");
  }
  if (url.hostname === "") return invalid("webhookUrl has no host.");
  const literal = ipLiteral(url.hostname);
  if (literal !== undefined && !allowedHosts.includes(hostOf(url))) {
    const reason = blockedReason(literal);
    if (reason !== undefined) {
      return {
        error: "refused_address",
        message: `webhookUrl points to a ${reason} address; list the host in NESTRIX_WEBHOOK_ALLOWED_HOSTS to allow it.`,
      };
    }
  }
  return { url };
}

/** The URL's host as allowlist entries are normalized (lower case, IPv6 without brackets). */
function hostOf(url: URL): string {
  const h = url.hostname.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

interface AttemptResult {
  status: number | null;
  error: string | null;
  retry: boolean;
}

export class WebhookSender {
  private readonly allowed: ReadonlySet<string>;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly lookup: Lookup;
  private readonly maxQueued: number;
  private readonly nowSeconds: () => number;
  private readonly chains = new Map<
    string,
    { tail: Promise<unknown>; size: number }
  >();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(options: WebhookSenderOptions) {
    this.allowed = new Set(options.allowedHosts);
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.backoffMs = options.backoffMs ?? ((n) => 1000 * 2 ** (n - 1));
    this.lookup = options.lookup ?? defaultLookup;
    this.maxQueued = options.maxQueued ?? 16;
    this.nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Delivers `body` (JSON text) to `url`, signed with `secret`, after any delivery already queued
   * under `key`. Never rejects.
   */
  send(
    key: string,
    url: string,
    secret: string,
    body: string,
    options: { maxAttempts?: number } = {},
  ): Promise<DeliveryResult> {
    if (this.closed) return Promise.resolve(failed("closed", 0));
    const chain = this.chains.get(key) ?? {
      tail: Promise.resolve(),
      size: 0,
    };
    if (chain.size > this.maxQueued) {
      return Promise.resolve(failed("queue_full", 0));
    }
    chain.size++;
    const run = chain.tail.then(() =>
      this.deliver(url, secret, body, options.maxAttempts ?? this.maxAttempts),
    );
    const settled = run.then(
      (r) => r,
      () => failed("internal", 0),
    );
    chain.tail = settled;
    this.chains.set(key, chain);
    const tracked = settled.finally(() => {
      this.inflight.delete(tracked);
      chain.size--;
      if (chain.size === 0 && this.chains.get(key) === chain) {
        this.chains.delete(key);
      }
    });
    this.inflight.add(tracked);
    return settled;
  }

  /** Stops accepting deliveries and waits up to `timeoutMs` for those in progress. */
  async close(timeoutMs = 10_000): Promise<void> {
    this.closed = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async deliver(
    url: string,
    secret: string,
    body: string,
    maxAttempts: number,
  ): Promise<DeliveryResult> {
    let last: AttemptResult = { status: null, error: "internal", retry: false };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.closed && attempt > 1) return failed("closed", attempt - 1);
      try {
        last = await this.attempt(url, secret, body);
      } catch {
        last = { status: null, error: "internal", retry: false };
      }
      if (last.error === null) {
        return {
          delivery: "sent",
          attempts: attempt,
          status: last.status,
          error: null,
        };
      }
      if (last.error === "refused_address" || last.error === "invalid_url") {
        return {
          delivery: "refused",
          attempts: attempt,
          status: null,
          error: last.error,
        };
      }
      if (!last.retry || attempt === maxAttempts) {
        return {
          delivery: "failed",
          attempts: attempt,
          status: last.status,
          error: last.error,
        };
      }
      await this.sleep(this.backoffMs(attempt));
    }
    return failed(last.error ?? "internal", maxAttempts, last.status);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      timer.unref();
      this.timers.add(timer);
    });
  }

  private async attempt(
    raw: string,
    secret: string,
    body: string,
  ): Promise<AttemptResult> {
    const checked = checkUrl(raw, [...this.allowed]);
    if (!("url" in checked)) {
      return { status: null, error: checked.error, retry: false };
    }
    const url = checked.url;
    const host = hostOf(url);
    const allowed = this.allowed.has(host);
    const literal = ipLiteral(url.hostname);

    let addresses: ResolvedAddress[];
    if (literal !== undefined) {
      addresses = [{ address: literal, family: literal.includes(":") ? 6 : 4 }];
    } else {
      try {
        addresses = await withTimeout(this.lookup(host), this.timeoutMs);
      } catch {
        return { status: null, error: "dns", retry: true };
      }
    }
    if (addresses.length === 0) {
      return { status: null, error: "dns", retry: true };
    }
    if (!allowed && addresses.some((a) => blockedReason(a.address))) {
      return { status: null, error: "refused_address", retry: false };
    }
    const target = addresses[0] as ResolvedAddress;

    const timestamp = String(this.nowSeconds());
    const isHttps = url.protocol === "https:";
    const payload = Buffer.from(body, "utf8");
    const headers: Record<string, string> = {
      host: url.host,
      "content-type": "application/json",
      "content-length": String(payload.length),
      "user-agent": USER_AGENT,
      [TIMESTAMP_HEADER]: timestamp,
      [SIGNATURE_HEADER]: signPayload(secret, timestamp, body),
    };
    const options = {
      host: target.address,
      family: target.family,
      port: url.port === "" ? (isHttps ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: "POST",
      headers,
      setHost: false,
      agent: false as const,
      // TLS: verify the certificate against the name, not the IP connected to.
      ...(isHttps && literal === undefined ? { servername: host } : {}),
    };

    return new Promise<AttemptResult>((resolve) => {
      let done = false;
      const finish = (result: AttemptResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const onResponse = (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        // The body is never read: a large or slow answer costs nothing.
        res.destroy();
        req.destroy();
        if (status >= 200 && status < 300) {
          finish({ status, error: null, retry: false });
        } else if (status >= 300 && status < 400) {
          finish({ status, error: "redirect", retry: false });
        } else {
          finish({
            status,
            error: "http_status",
            retry: status === 408 || status === 429 || status >= 500,
          });
        }
      };
      const req = isHttps
        ? httpsRequest(options, onResponse)
        : httpRequest(options, onResponse);
      const timer = setTimeout(() => {
        finish({ status: null, error: "timeout", retry: true });
        req.destroy();
      }, this.timeoutMs);
      timer.unref();
      req.on("error", () =>
        finish({ status: null, error: "network", retry: true }),
      );
      req.end(payload);
    });
  }
}

function failed(
  error: string,
  attempts: number,
  status: number | null = null,
): DeliveryResult {
  return { delivery: "failed", attempts, status, error };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    timer.unref();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
