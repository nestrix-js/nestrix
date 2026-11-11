/**
 * The webhook sender against local receivers: signing, SSRF refusals, redirects, timeouts,
 * retries and one delivery in flight per rule. No database.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type Lookup,
  WebhookSender,
  type WebhookSenderOptions,
} from "../../src/alerts/webhook.js";
import { type Receiver, startReceiver, verifySignature } from "./helpers.js";

/** A test-only signing key. */
const KEY = "k".repeat(43);
const BODY = JSON.stringify({ state: "firing", value: 0.5 });

const open: Receiver[] = [];
const senders: WebhookSender[] = [];
async function receiver(
  ...args: Parameters<typeof startReceiver>
): Promise<Receiver> {
  const r = await startReceiver(...args);
  open.push(r);
  return r;
}
function sender(options: Partial<WebhookSenderOptions> = {}): WebhookSender {
  const s = new WebhookSender({
    allowedHosts: [],
    backoffMs: () => 10,
    timeoutMs: 1000,
    ...options,
  });
  senders.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(senders.splice(0).map((s) => s.close(1000)));
  await Promise.all(open.splice(0).map((r) => r.close()));
});

describe("signing", () => {
  it("POSTs JSON with a timestamp and an HMAC-SHA256 signature of `<timestamp>.<body>`", async () => {
    const r = await receiver();
    const s = sender({
      allowedHosts: ["127.0.0.1"],
      nowSeconds: () => 1_700_000_000,
    });
    const result = await s.send("1", `${r.url}?a=1`, KEY, BODY);
    expect(result).toEqual({
      delivery: "sent",
      attempts: 1,
      status: 200,
      error: null,
    });
    expect(r.requests).toHaveLength(1);
    const req = r.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("/hook?a=1");
    expect(req?.headers["content-type"]).toBe("application/json");
    expect(req?.headers["x-nestrix-timestamp"]).toBe("1700000000");
    expect(req?.headers["x-nestrix-signature"]).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
    expect(req?.body).toBe(BODY);
    expect(req && verifySignature(req, KEY)).toBe(true);
    expect(req && verifySignature(req, "wrong")).toBe(false);
    // The signature covers the timestamp: the same body with another timestamp does not verify.
    const replay = req && {
      ...req,
      headers: { ...req.headers, "x-nestrix-timestamp": "1700000001" },
    };
    expect(replay && verifySignature(replay, KEY)).toBe(false);
  });
});

describe("SSRF protection", () => {
  it.each([
    ["IPv4 loopback", (p: number) => `http://127.0.0.1:${p}/hook`],
    [
      "localhost (resolves to loopback)",
      (p: number) => `http://localhost:${p}/hook`,
    ],
    ["IPv6 loopback", (p: number) => `http://[::1]:${p}/hook`],
    [
      "IPv4-mapped loopback",
      (p: number) => `http://[::ffff:127.0.0.1]:${p}/hook`,
    ],
    ["integer IPv4 form", (p: number) => `http://2130706433:${p}/hook`],
  ])(
    "refuses %s without the allowlist, and sends nothing",
    async (_name, url) => {
      const r = await receiver();
      const result = await sender().send("1", url(r.port), KEY, BODY);
      expect(result).toMatchObject({
        delivery: "refused",
        error: "refused_address",
        attempts: 1,
      });
      expect(r.requests).toHaveLength(0);
    },
  );

  it("refuses a hostname that resolves to 127.0.0.1, and one with any private address", async () => {
    const r = await receiver();
    const calls: string[] = [];
    const lookup: Lookup = async (host) => {
      calls.push(host);
      if (host === "internal.example")
        return [{ address: "127.0.0.1", family: 4 }];
      // A public address first, a private one second: still refused.
      return [
        { address: "1.1.1.1", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ];
    };
    const s = sender({ lookup });
    expect(
      await s.send("1", `http://internal.example:${r.port}/hook`, KEY, BODY),
    ).toMatchObject({ delivery: "refused", error: "refused_address" });
    expect(
      await s.send("1", `http://mixed.example:${r.port}/hook`, KEY, BODY),
    ).toMatchObject({ delivery: "refused" });
    expect(calls).toEqual(["internal.example", "mixed.example"]);
    expect(r.requests).toHaveLength(0);
  });

  it("refuses non-http schemes and credentials in the URL", async () => {
    const s = sender({ allowedHosts: ["127.0.0.1"] });
    const withCredentials = new URL("http://127.0.0.1/x");
    withCredentials.username = "someone";
    withCredentials.password = "pw";
    for (const url of [
      "ftp://127.0.0.1/x",
      "gopher://127.0.0.1/x",
      withCredentials.href,
    ]) {
      expect(await s.send("1", url, KEY, BODY), url).toMatchObject({
        delivery: "refused",
        error: "invalid_url",
      });
    }
  });

  it("connects to the address it checked (one lookup per attempt, no second resolution)", async () => {
    const r = await receiver();
    let calls = 0;
    // `hooks.test` does not exist in real DNS: the request can only reach the receiver through
    // the address returned here. Allowlisted, since that address is loopback.
    const lookup: Lookup = async () => {
      calls++;
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const s = sender({ lookup, allowedHosts: ["hooks.test"] });
    const result = await s.send(
      "1",
      `http://hooks.test:${r.port}/hook`,
      KEY,
      BODY,
    );
    expect(result.delivery).toBe("sent");
    expect(calls).toBe(1);
    expect(r.requests[0]?.headers.host).toBe(`hooks.test:${r.port}`);
  });
});

describe("redirects, timeouts and retries", () => {
  it("does not follow a redirect and does not retry it", async () => {
    const target = await receiver();
    const r = await receiver((_req, res) => {
      res.writeHead(307, { location: target.url }).end();
    });
    const result = await sender({ allowedHosts: ["127.0.0.1"] }).send(
      "1",
      r.url,
      KEY,
      BODY,
    );
    expect(result).toEqual({
      delivery: "failed",
      attempts: 1,
      status: 307,
      error: "redirect",
    });
    expect(r.requests).toHaveLength(1);
    expect(target.requests).toHaveLength(0);
  });

  it("times out after the deadline and makes 3 attempts in all", async () => {
    const r = await receiver(() => "hang");
    const started = Date.now();
    const result = await sender({
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 200,
    }).send("1", r.url, KEY, BODY);
    expect(result).toEqual({
      delivery: "failed",
      attempts: 3,
      status: null,
      error: "timeout",
    });
    expect(r.requests).toHaveLength(3);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("retries 5xx with backoff and stops at the first success", async () => {
    const delays: number[] = [];
    const r = await receiver((_req, res, i) => {
      res.writeHead(i === 0 ? 503 : 200).end();
    });
    const result = await sender({
      allowedHosts: ["127.0.0.1"],
      backoffMs: (n) => {
        delays.push(n);
        return 20;
      },
    }).send("1", r.url, KEY, BODY);
    expect(result).toEqual({
      delivery: "sent",
      attempts: 2,
      status: 200,
      error: null,
    });
    expect(delays).toEqual([1]);
    // Each attempt is signed afresh (same body).
    expect(r.requests.map((q) => verifySignature(q, KEY))).toEqual([
      true,
      true,
    ]);
  });

  it("does not retry a 4xx other than 408 and 429, and never reads the body", async () => {
    const r = await receiver((_req, res) => {
      res.writeHead(400).end("x".repeat(100_000));
    });
    const result = await sender({ allowedHosts: ["127.0.0.1"] }).send(
      "1",
      r.url,
      KEY,
      BODY,
    );
    expect(result).toEqual({
      delivery: "failed",
      attempts: 1,
      status: 400,
      error: "http_status",
    });
  });

  it("retries a refused connection and reports a network error", async () => {
    const r = await receiver();
    const url = r.url;
    await r.close();
    const result = await sender({ allowedHosts: ["127.0.0.1"] }).send(
      "1",
      url,
      KEY,
      BODY,
    );
    expect(result).toMatchObject({
      delivery: "failed",
      attempts: 3,
      error: "network",
    });
  });

  it("uses the default backoff of 1 s then 2 s", async () => {
    const r = await receiver((_req, res) => {
      res.writeHead(500).end();
    });
    const s = new WebhookSender({
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 500,
    });
    senders.push(s);
    const started = Date.now();
    const result = await s.send("1", r.url, KEY, BODY);
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({
      delivery: "failed",
      attempts: 3,
      status: 500,
    });
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(5000);
  });
});

function slowReceiver(): Promise<Receiver> {
  return receiver(
    (_req, res) =>
      new Promise<void>((resolve) =>
        setTimeout(() => {
          res.writeHead(200).end();
          resolve();
        }, 100),
      ),
  );
}

describe("one delivery in flight per rule", () => {
  it("serializes deliveries of one key and runs other keys alongside", async () => {
    const r = await slowReceiver();
    const s = sender({ allowedHosts: ["127.0.0.1"] });
    const results = await Promise.all([
      s.send("rule-1", r.url, KEY, BODY),
      s.send("rule-1", r.url, KEY, BODY),
      s.send("rule-1", r.url, KEY, BODY),
    ]);
    expect(results.map((x) => x.delivery)).toEqual(["sent", "sent", "sent"]);
    expect(r.maxConcurrent).toBe(1);

    const r2 = await slowReceiver();
    await Promise.all([
      s.send("rule-1", r2.url, KEY, BODY),
      s.send("rule-2", r2.url, KEY, BODY),
    ]);
    expect(r2.maxConcurrent).toBe(2);
  });

  it("refuses beyond the queue bound instead of growing without limit", async () => {
    const r = await receiver(() => "hang");
    const s = sender({
      allowedHosts: ["127.0.0.1"],
      timeoutMs: 300,
      maxAttempts: 1,
      maxQueued: 1,
    });
    const results = await Promise.all([
      s.send("k", r.url, KEY, BODY),
      s.send("k", r.url, KEY, BODY),
      s.send("k", r.url, KEY, BODY),
    ]);
    expect(results.map((x) => x.error)).toEqual([
      "timeout",
      "timeout",
      "queue_full",
    ]);
  });
});

describe("faults", () => {
  it("a lookup that throws is a dns failure, never a rejection", async () => {
    const s = sender({
      lookup: () => {
        throw new Error("boom");
      },
      maxAttempts: 2,
    });
    await expect(
      s.send("1", "http://x.example/", KEY, BODY),
    ).resolves.toMatchObject({ delivery: "failed", error: "dns", attempts: 2 });
  });

  it("after close, send resolves as closed", async () => {
    const s = sender();
    await s.close(10);
    await expect(
      s.send("1", "https://example.com/", KEY, BODY),
    ).resolves.toMatchObject({ error: "closed" });
  });
});
