import { describe, expect, it } from "vitest";
import { blockedReason, parseIPv6 } from "../../src/alerts/address.js";
import { FOR_TOLERANCE_MS, transition } from "../../src/alerts/state.js";
import { validateRuleInput } from "../../src/alerts/store.js";
import { webhookUrlProblem } from "../../src/alerts/webhook.js";
import { loadConfig, normalizeAllowedHost } from "../../src/config.js";

describe("address classification", () => {
  it.each([
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "unspecified"],
    ["10.1.2.3", "private"],
    ["100.64.0.1", "shared (CGNAT)"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["169.254.169.254", "link-local"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["192.0.0.8", "IETF protocol assignment"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "reserved"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["::ffff:169.254.169.254", "IPv4-mapped link-local"],
    ["::127.0.0.1", "IPv4-compatible"],
    ["64:ff9b::7f00:1", "NAT64 loopback"],
    ["64:ff9b:1::1", "NAT64 local-use"],
    ["2002:7f00:1::1", "6to4 loopback"],
    ["2002:c0a8:101::1", "6to4 private"],
    ["2001::1", "Teredo"],
    ["2001:db8::1", "documentation"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["::ffff:0:127.0.0.1", "IPv4-translated"],
    ["::ffff:0:7f00:1", "IPv4-translated"],
    ["5f00::1", "not global unicast"],
    ["3fff::1", "documentation"],
    ["3fff:fff::1", "documentation"],
    ["2001:2::1", "benchmarking"],
    ["2001:10::1", "ORCHID"],
    ["2001:20::1", "ORCHIDv2"],
    ["4000::1", "not global unicast"],
    ["not-an-ip", "not an IP address"],
    ["", "not an IP address"],
  ])("refuses %s (%s)", (address, reason) => {
    expect(blockedReason(address)).toBe(reason);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "2606:4700::1111",
    "3fff:1000::1",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("allows public %s", (address) => {
    expect(blockedReason(address)).toBeUndefined();
  });

  it("parses IPv6 forms", () => {
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x102, 0x304,
    ]);
    expect(parseIPv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIPv6("1:2:3:4:5:6:1.2.3.4")).toEqual([
      1, 2, 3, 4, 5, 6, 0x102, 0x304,
    ]);
    expect(parseIPv6("1.2.3.4")).toBeUndefined();
  });
});

describe("webhook URL shape (API side, no DNS)", () => {
  it.each([
    ["ftp://example.com/x", /http or https/],
    ["file:///etc/passwd", /http or https/],
    ["http://user:pw@example.com/", /credentials/],
    ["not a url", /not a valid URL/],
    ["http://127.0.0.1:9/", /loopback/],
    ["http://[::1]/", /loopback/],
    ["http://[::ffff:127.0.0.1]/", /loopback/],
    ["http://0x7f.1/", /loopback/],
    ["http://2130706433/", /loopback/],
    ["http://10.0.0.5/", /private/],
    ["http://169.254.169.254/latest/meta-data", /link-local/],
  ])("refuses %s", (url, message) => {
    expect(webhookUrlProblem(url, [])).toMatch(message);
  });

  it("accepts public URLs and allowlisted literals", () => {
    expect(
      webhookUrlProblem("https://hooks.example.com/x?y=1", []),
    ).toBeUndefined();
    expect(
      webhookUrlProblem("http://127.0.0.1:9/", ["127.0.0.1"]),
    ).toBeUndefined();
    expect(webhookUrlProblem("http://[::1]:9/", ["::1"])).toBeUndefined();
    // Names are resolved at send time, not here.
    expect(webhookUrlProblem("http://localhost/", [])).toBeUndefined();
  });
});

describe("NESTRIX_WEBHOOK_ALLOWED_HOSTS", () => {
  it("normalizes entries as URL hostnames", () => {
    expect(normalizeAllowedHost("Hooks.Internal")).toBe("hooks.internal");
    expect(normalizeAllowedHost("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeAllowedHost("::1")).toBe("::1");
    expect(normalizeAllowedHost("[::FFFF:127.0.0.1]")).toBe("::ffff:7f00:1");
    for (const bad of [
      "http://x",
      "x:80",
      "x/y",
      "a b",
      "u@x",
      "127.0.0.1:9",
    ]) {
      expect(normalizeAllowedHost(bad), bad).toBeUndefined();
    }
  });

  it("is read from the environment and refuses bad entries", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/x",
      NESTRIX_INGEST_AUTH: "none",
    };
    const ok = loadConfig({
      ...base,
      NESTRIX_WEBHOOK_ALLOWED_HOSTS: " 127.0.0.1, Hooks.Local ",
    });
    expect(ok.ok && ok.config.alerts.allowedHosts).toEqual([
      "127.0.0.1",
      "hooks.local",
    ]);
    const none = loadConfig(base);
    expect(none.ok && none.config.alerts).toEqual({
      allowedHosts: [],
      publicUrl: undefined,
    });
    const bad = loadConfig({
      ...base,
      NESTRIX_WEBHOOK_ALLOWED_HOSTS: "http://x/",
    });
    expect(bad.ok).toBe(false);
    const url = loadConfig({
      ...base,
      NESTRIX_PUBLIC_URL: "https://obs.example.com/",
    });
    expect(url.ok && url.config.alerts.publicUrl).toBe(
      "https://obs.example.com",
    );
    expect(
      loadConfig({ ...base, NESTRIX_PUBLIC_URL: "javascript:alert(1)" }).ok,
    ).toBe(false);
  });
});

describe("state machine", () => {
  const T = 1_000_000_000_000;
  const MIN = 60_000;

  it("ok -> pending -> firing after forMinutes -> resolved", () => {
    let t = transition(undefined, 0.5, 0.1, 2, T);
    expect(t).toMatchObject({
      next: { state: "pending", sinceMs: T },
      notify: undefined,
    });
    t = transition(t.next, 0.5, 0.1, 2, T + MIN);
    expect(t).toMatchObject({ next: { state: "pending" }, notify: undefined });
    // Two minutes later, minus a little timer drift, it fires; startedAt is the pending start.
    t = transition(t.next, 0.5, 0.1, 2, T + 2 * MIN - FOR_TOLERANCE_MS + 1);
    expect(t).toMatchObject({
      next: { state: "firing", sinceMs: T },
      notify: "firing",
      startedAtMs: T,
    });
    t = transition(t.next, 0.5, 0.1, 2, T + 3 * MIN);
    expect(t.notify).toBeUndefined();
    t = transition(t.next, 0.01, 0.1, 2, T + 4 * MIN);
    expect(t).toMatchObject({
      next: { state: "ok" },
      notify: "resolved",
      startedAtMs: T,
    });
  });

  it("a breach shorter than forMinutes never fires", () => {
    let t = transition(undefined, 0.5, 0.1, 2, T);
    t = transition(t.next, 0.05, 0.1, 2, T + MIN);
    expect(t).toMatchObject({ next: { state: "ok" }, notify: undefined });
  });

  it("forMinutes 0 fires at the first breach", () => {
    expect(transition(undefined, 0.5, 0.1, 0, T)).toMatchObject({
      next: { state: "firing" },
      notify: "firing",
    });
  });

  it("no data changes nothing (a firing alert is not resolved by silence)", () => {
    const firing = { state: "firing" as const, sinceMs: T };
    expect(transition(firing, null, 0.1, 2, T + MIN)).toMatchObject({
      next: firing,
      notify: undefined,
    });
    const pending = { state: "pending" as const, sinceMs: T };
    expect(transition(pending, null, 0.1, 2, T + 10 * MIN).next).toEqual(
      pending,
    );
  });

  it("the comparator is strict", () => {
    expect(transition(undefined, 0.1, 0.1, 0, T).notify).toBeUndefined();
  });
});

describe("rule validation", () => {
  const valid = {
    name: "Errors",
    service: "shop",
    metric: "error_rate",
    threshold: 0.05,
    windowMinutes: 5,
    webhookUrl: "https://hooks.example.com/x",
  };

  it("accepts a valid rule", () => {
    expect(validateRuleInput(valid, false, [])).toEqual({
      ok: true,
      fields: {
        name: "Errors",
        service_name: "shop",
        metric: "error_rate",
        threshold: 0.05,
        window_minutes: 5,
        webhook_url: "https://hooks.example.com/x",
      },
    });
  });

  it.each([
    [{ ...valid, extra: 1 }, /Unknown field/],
    [{ ...valid, name: undefined }, /name is required/],
    [{ ...valid, windowMinutes: 4 }, /5 to 60/],
    [{ ...valid, windowMinutes: 61 }, /5 to 60/],
    [{ ...valid, windowMinutes: 5.5 }, /5 to 60/],
    [{ ...valid, forMinutes: -1 }, /0 to 60/],
    [{ ...valid, threshold: 5 }, /fraction/],
    [{ ...valid, threshold: "0.1" }, /must be a number/],
    [{ ...valid, metric: "p99_ms" }, /metric must be/],
    [{ ...valid, metric: "p95_ms", threshold: 0 }, /milliseconds/],
    [{ ...valid, comparator: "<" }, /comparator/],
    [{ ...valid, name: "a\u0000b" }, /control characters/],
    [{ ...valid, name: "x".repeat(201) }, /1 to 200/],
    [{ ...valid, enabled: "yes" }, /true or false/],
    [{ ...valid, webhookUrl: "http://127.0.0.1/" }, /loopback/],
    [[], /JSON object/],
    [null, /JSON object/],
  ])("refuses %j", (body, message) => {
    const v = validateRuleInput(body, false, []);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.message).toMatch(message);
  });

  it("checks a partial threshold against the stored metric", () => {
    const existing = { metric: "p95_ms" as const, threshold: 500 };
    expect(validateRuleInput({ threshold: 800 }, true, [], existing).ok).toBe(
      true,
    );
    expect(
      validateRuleInput({ metric: "error_rate" }, true, [], existing).ok,
    ).toBe(false);
    expect(validateRuleInput({}, true, [], existing).ok).toBe(false);
  });
});
