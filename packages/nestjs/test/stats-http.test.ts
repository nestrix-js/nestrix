// Global state: host provider (bootApp's in-memory exporter), ALS context manager, W3C propagator.
// P2-04: dashboard-path requests get no span and no count; shadowing is reported at `close`
// when no dashboard handler ran; statistics and the dashboard check fail safe (rule 1).
import net from "node:net";
import type { INestApplication } from "@nestjs/common";
import { type BootedApp, bootApp } from "@nestrix-js/testing";
import { SpanKind } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getFailureCounts,
  resetDiagnosticsForTests,
} from "../src/diagnostics.js";
import { faultInjection } from "../src/http/request-state.js";
import { ADAPTERS, registerHostContext, serverSpan } from "./http-fixture.js";
import {
  CatchAllController,
  counts,
  DASHBOARD_PATH,
  errorCounts,
  HostUnderDashboardController,
  newHarness,
  SlowController,
  StatsController,
  sendAll,
  statsModule,
} from "./stats-fixture.js";

registerHostContext();

let booted: BootedApp | undefined;
beforeEach(() => resetDiagnosticsForTests());
afterEach(async () => {
  faultInjection.site = undefined;
  await booted?.close();
  booted = undefined;
});

const serverSpanPaths = (b: BootedApp) =>
  b
    .spans()
    .filter((s) => s.kind === SpanKind.SERVER)
    .map((s) => String(s.attributes["url.path"]));

describe.each(ADAPTERS)("dashboard path and statistics on %s", (adapter) => {
  it("gives dashboard requests no span and no count, and does not report them as shadowed when the handler ran", async () => {
    const h = newHarness();
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: true,
      }),
    });
    const dashboardPaths = [
      DASHBOARD_PATH,
      `${DASHBOARD_PATH}/`,
      `${DASHBOARD_PATH}/api/v1/meta`,
      `${DASHBOARD_PATH}/api/v1/meta?x=1`,
      `${DASHBOARD_PATH}?x=1`,
    ];
    for (const path of dashboardPaths) {
      const res = await fetch(`${booted.baseUrl}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.json()).toEqual({ dashboard: true });
    }
    // Neighbours that are not the dashboard path: traced and counted as usual.
    expect((await fetch(`${booted.baseUrl}/s/ok/1`)).status).toBe(200);
    expect((await fetch(`${booted.baseUrl}${DASHBOARD_PATH}x`)).status).toBe(
      404,
    );
    await serverSpan(booted, "/s/ok/1");
    await serverSpan(booted, `${DASHBOARD_PATH}x`);
    await expect
      .poll(() => counts(h.stats))
      .toEqual({ "GET /s/ok/:id": 1, "GET (unmatched)": 1 });

    expect(serverSpanPaths(booted).sort()).toEqual(
      ["/s/ok/1", `${DASHBOARD_PATH}x`].sort(),
    );
    expect(h.shadowed).toEqual([]);
    expect([...getFailureCounts().keys()]).toEqual([]);
  });

  it("counts a thrown 4xx as a request, not an error, and keeps span behaviour", async () => {
    const h = newHarness();
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: false,
      }),
    });
    const statuses = await sendAll(booted.baseUrl, [
      "/s/bad",
      "/s/bad",
      "/s/boom",
    ]);
    expect(statuses).toEqual([400, 400, 500]);
    await expect
      .poll(() => counts(h.stats))
      .toEqual({ "GET /s/bad": 2, "GET /s/boom": 1 });
    expect(errorCounts(h.stats)).toEqual({ "GET /s/bad": 0, "GET /s/boom": 1 });
    const span = await serverSpan(booted, "/s/boom");
    expect(span.name).toBe("GET /s/boom");
    expect(span.attributes["http.response.status_code"]).toBe(500);
  });

  it("an injected fault in statistics recording leaves the request and the span unchanged", async () => {
    const h = newHarness();
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: false,
      }),
    });
    faultInjection.site = "stats-record";
    const res = await fetch(`${booted.baseUrl}/s/ok/7`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "7" });
    const span = await serverSpan(booted, "/s/ok/7");
    expect(span.name).toBe("GET /s/ok/:id");
    expect(span.attributes["http.route"]).toBe("/s/ok/:id");
    expect(getFailureCounts().get("stats.record")).toBe(1);
    expect(counts(h.stats)).toEqual({});
  });

  it("an injected fault in the dashboard close check, and a throwing onShadowed, leave the response unchanged", async () => {
    const h = newHarness(() => {
      throw new Error("onShadowed fails");
    });
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [StatsController, HostUnderDashboardController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: false,
      }),
    });
    // A host route the dashboard does not own answers 200: shadowing, and the callback throws.
    const first = await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/host`);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("host-route");
    await expect
      .poll(() => getFailureCounts().get("http.dashboard-close"))
      .toBe(1);
    expect(h.shadowed).toEqual([200]);

    faultInjection.site = "dashboard-close";
    const second = await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/host`);
    expect(second.status).toBe(200);
    await expect
      .poll(() => getFailureCounts().get("http.dashboard-close"))
      .toBe(2);
    expect(h.shadowed).toEqual([200]);
    expect(serverSpanPaths(booted)).toEqual([]);
    expect(counts(h.stats)).toEqual({});
  });

  it("an async onShadowed that rejects is counted and raises no unhandledRejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const h = newHarness(() => Promise.reject(new Error("async fails")));
      booted = await bootApp(adapter, {
        module: statsModule({
          controllers: [HostUnderDashboardController],
          dashboard: h.dashboard,
          telemetry: false,
          mount: false,
        }),
      });
      const res = await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/host`);
      expect(res.status).toBe(200);
      await expect
        .poll(() => getFailureCounts().get("http.dashboard-close"))
        .toBe(1);
      await new Promise((r) => setTimeout(r, 50));
      expect(h.shadowed).toEqual([200]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("does not report Nest's own 404 for an unregistered sub-path of a mounted dashboard", async () => {
    const h = newHarness();
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: true,
      }),
    });
    const res = await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/api/v1/nope`);
    expect(res.status).toBe(404);
    // A control request that does report, so the absence above is not a timing accident.
    const ok = await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/api/v1/meta`);
    expect(ok.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.shadowed).toEqual([]);
    expect([...getFailureCounts().keys()]).toEqual([]);
  });

  it("does not report an OPTIONS request answered by the host's enableCors()", async () => {
    const h = newHarness();
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: true,
      }),
      configure: (app: INestApplication) => {
        app.enableCors();
      },
    });
    const res = await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/api/v1/meta`, {
      method: "OPTIONS",
      headers: {
        origin: "http://example.test",
        "access-control-request-method": "GET",
      },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).not.toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(h.shadowed).toEqual([]);
  });

  it("counts a request whose client destroys the socket mid-response exactly once", async () => {
    const h = newHarness();
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [SlowController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: false,
      }),
    });
    const ctrl = new AbortController();
    const pending = fetch(`${booted.baseUrl}/slow`, {
      signal: ctrl.signal,
    }).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    expect(await pending).toBe("aborted");
    // Past the handler's own 300 ms, so a second close or a late count would show.
    await new Promise((r) => setTimeout(r, 500));
    expect(counts(h.stats)).toEqual({ "GET /slow": 1 });
  });

  it("with no dashboard config, traces the dashboard path like any other and records nothing", async () => {
    const h = newHarness();
    booted = await bootApp(adapter, {
      module: statsModule({
        controllers: [StatsController],
        dashboard: undefined,
        telemetry: false,
        mount: true,
      }),
    });
    expect((await fetch(`${booted.baseUrl}${DASHBOARD_PATH}`)).status).toBe(
      200,
    );
    expect((await fetch(`${booted.baseUrl}/s/ok/1`)).status).toBe(200);
    await serverSpan(booted, DASHBOARD_PATH);
    await serverSpan(booted, "/s/ok/1");
    expect(counts(h.stats)).toEqual({});
    expect(h.shadowed).toEqual([]);
  });
});

describe("dashboard path case on Express", () => {
  it("treats a case variant of the dashboard path as a dashboard request: no span, no count", async () => {
    const h = newHarness();
    booted = await bootApp("express", {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: true,
      }),
    });
    const res = await fetch(
      `${booted.baseUrl}${DASHBOARD_PATH.toUpperCase()}/api/v1/meta`,
    );
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    // A host request afterwards is still traced and counted, so absence above is not a dead hook.
    expect((await fetch(`${booted.baseUrl}/s/ok/1`)).status).toBe(200);
    await expect.poll(() => counts(h.stats)).toEqual({ "GET /s/ok/:id": 1 });
    expect(serverSpanPaths(booted)).toEqual(["/s/ok/1"]);
  });
});

describe("shadowing on Express", () => {
  it("reports a host catch-all that answers a dashboard path, once per request, with its status", async () => {
    const h = newHarness();
    booted = await bootApp("express", {
      module: statsModule({
        controllers: [CatchAllController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: true,
      }),
    });
    const res = await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/api/v1/meta`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("host-catch-all");
    await expect.poll(() => h.shadowed).toEqual([200]);
    // Still a dashboard request: no span, no count.
    expect(serverSpanPaths(booted)).toEqual([]);
    expect(counts(h.stats)).toEqual({});
    // A host route outside the dashboard path is counted as usual.
    expect((await fetch(`${booted.baseUrl}/elsewhere`)).status).toBe(200);
    await expect.poll(() => counts(h.stats)).toEqual({ "GET /*splat": 1 });
    expect(h.shadowed).toEqual([200]);
  });

  it("reports a 401 from host middleware in front of the dashboard", async () => {
    const h = newHarness();
    booted = await bootApp("express", {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: true,
      }),
      configure: (app: INestApplication) => {
        app.use(
          (
            req: { url: string },
            res: { statusCode: number; end(): void },
            next: () => void,
          ) => {
            if (req.url.startsWith(DASHBOARD_PATH)) {
              res.statusCode = 401;
              res.end();
              return;
            }
            next();
          },
        );
      },
    });
    expect((await fetch(`${booted.baseUrl}${DASHBOARD_PATH}/`)).status).toBe(
      401,
    );
    await expect.poll(() => h.shadowed).toEqual([401]);
  });

  it("treats an absolute-form target for the dashboard path as a dashboard request", async () => {
    const h = newHarness();
    booted = await bootApp("express", {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: true,
      }),
    });
    const port = new URL(booted.baseUrl).port;
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(port), "127.0.0.1", () => {
        socket.write(
          `GET http://localhost:${port}${DASHBOARD_PATH}/api/v1/meta HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`,
        );
      });
      let data = "";
      socket.on("data", (c) => {
        data += c.toString();
      });
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    expect(reply).toContain("200");
    expect(reply).toContain('{"dashboard":true}');
    // A dashboard request: no span, no count, no shadow report (the handler ran).
    await new Promise((r) => setTimeout(r, 100));
    expect(serverSpanPaths(booted)).toEqual([]);
    expect(counts(h.stats)).toEqual({});
    expect(h.shadowed).toEqual([]);
  });

  it("does not report a client that went away before any response", async () => {
    const h = newHarness();
    booted = await bootApp("express", {
      module: statsModule({
        controllers: [StatsController],
        dashboard: h.dashboard,
        telemetry: false,
        mount: false,
      }),
      configure: (app: INestApplication) => {
        // Host middleware that never answers dashboard requests.
        app.use((req: { url: string }, _res: unknown, next: () => void) => {
          if (!req.url.startsWith(DASHBOARD_PATH)) next();
        });
      },
    });
    const abortOne = async (): Promise<void> => {
      const ctrl = new AbortController();
      const pending = fetch(`${booted?.baseUrl}${DASHBOARD_PATH}`, {
        signal: ctrl.signal,
      }).catch(() => "aborted");
      await new Promise((r) => setTimeout(r, 100));
      ctrl.abort();
      expect(await pending).toBe("aborted");
      await new Promise((r) => setTimeout(r, 100));
    };
    await abortOne();
    expect(h.shadowed).toEqual([]);
    expect([...getFailureCounts().keys()]).toEqual([]);
    // The same abort with the close check's fault site armed: the failure is counted, which shows
    // the dashboard close handling does run for a client that went away (and so the empty
    // `shadowed` above is the check deciding, not the check not running).
    faultInjection.site = "dashboard-close";
    await abortOne();
    expect(getFailureCounts().get("http.dashboard-close")).toBe(1);
    expect(h.shadowed).toEqual([]);
  });
});
