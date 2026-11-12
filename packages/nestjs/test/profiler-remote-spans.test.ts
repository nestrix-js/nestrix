// P10-01: the remote profiler's own requests produce no spans and carry no `traceparent`.
//
// Nestrix's fetch/undici subscriber is installed under a host-style provider. The poller is started
// inside an active, sampled parent span, so its timers inherit that context: without the
// suppress-tracing key every check-in, upload and failure report would get a client span under the
// parent (the control test shows a plain fetch does). Global state: the tracer provider, the
// context manager and the propagator.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { installOutbound } from "../src/outbound/index.js";
import { resetProfilerForTests } from "../src/profiler/profiler.js";
import { RemoteProfilerPoller } from "../src/profiler/remote.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import {
  clientSpans,
  inParent,
  resolved,
  setupTestTracing,
} from "./outbound-helpers.js";
import {
  CHECK_IN,
  type FakeServer,
  startFakeServer,
  until,
} from "./profiler-remote-fixture.js";

const { exporter, provider } = setupTestTracing();
const diagnostics = recordingDiagnostics();
const uninstall = installOutbound(resolved(), diagnostics);
let server: FakeServer;

beforeAll(async () => {
  server = await startFakeServer();
});
afterAll(async () => {
  uninstall();
  await server.close();
  await provider.shutdown();
});
afterEach(() => {
  exporter.reset();
  server.hits.length = 0;
  resetProfilerForTests();
});

describe("the poller's requests are invisible to tracing", () => {
  it("control: a plain fetch in the same parent gets a client span and a traceparent", async () => {
    await inParent(() =>
      fetch(`${server.url}/control`, { method: "POST" }).then((r) => r.text()),
    );
    expect(clientSpans(exporter)).toHaveLength(1);
    expect(server.hits[0]?.headers.traceparent).toBeDefined();
  });

  it("check-ins, the upload and a failure report: no spans, no traceparent", async () => {
    let checkIns = 0;
    server.respond = (hit) => {
      if (hit.path === CHECK_IN) {
        checkIns++;
        // 1st: a real 1 s capture (uploaded); 3rd: an invalid duration (reported as failed).
        const capture =
          checkIns === 1
            ? { id: "aaaaaaaaaaaaaaaa", durationMs: 1000 }
            : checkIns === 3
              ? { id: "bbbbbbbbbbbbbbbb", durationMs: 1 }
              : undefined;
        return { status: 200, json: { capture, nextCheckInMs: 50 } };
      }
      return { status: 204 };
    };
    const poller = new RemoteProfilerPoller({
      target: { baseUrl: server.url, headers: {}, timeoutMillis: 2000 },
      identity: {
        service: "s",
        instanceId: "i",
        version: undefined,
        host: undefined,
      },
      diagnostics,
      log: () => undefined,
      timing: { firstMinMs: 5, firstMaxMs: 5, minIntervalMs: 20, jitter: 0 },
    });
    try {
      await inParent(() => poller.start());
      await until(
        () =>
          server.hits.some(
            (h) => h.path === "/v1/nestrix/profiles/aaaaaaaaaaaaaaaa",
          ) &&
          server.hits.some(
            (h) => h.path === "/v1/nestrix/profiles/bbbbbbbbbbbbbbbb/failed",
          ),
        5000,
        "the upload and the failure report",
      );
    } finally {
      poller.stop();
    }
    await provider.forceFlush();
    expect(server.hits.length).toBeGreaterThan(3);
    expect(server.hits.map((h) => h.headers.traceparent)).toEqual(
      server.hits.map(() => undefined),
    );
    expect(clientSpans(exporter)).toEqual([]);
    // Only the test's own parent span was recorded.
    expect(exporter.getFinishedSpans().map((s) => s.name)).toEqual(["parent"]);
    expect(diagnostics.failures).toEqual([]);
  }, 10_000);
});
