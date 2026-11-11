// Node's global WebSocket through the undici bundled in Node, with no npm undici loaded (an npm
// copy that loads first owns the process-wide global dispatcher, and Node's WebSocket then runs
// on it). Global state: a host-style provider with an in-memory exporter.
//
// undici 6 (Node 22.15) publishes only `undici:request:create` for an upgrade request: no head,
// no trailers, no error. undici 7+ (Node 24, 26) publishes `headers` (101) and `trailers`.
import { SpanStatusCode } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installOutbound } from "../src/outbound/index.js";
import { recordingDiagnostics } from "./otel-helpers.js";
import {
  clientSpans,
  type EchoServer,
  inParent,
  resolved,
  setupTestTracing,
  startEchoServer,
  trackDoubleEnds,
  waitFor,
} from "./outbound-helpers.js";

const { exporter, provider } = setupTestTracing();
const doubleEnds = trackDoubleEnds();
const GRACE = 400;
let server: EchoServer;
let uninstall: () => void;
const diagnostics = recordingDiagnostics();

beforeAll(async () => {
  server = await startEchoServer();
  uninstall = installOutbound(resolved(), diagnostics, {
    unreadGraceMillis: GRACE,
  });
});
afterAll(async () => {
  uninstall();
  await server.close();
  await provider.shutdown();
});

const bundledMajor = Number(process.versions.undici?.split(".")[0]);

describe("global WebSocket on the bundled undici", () => {
  // On Node 22.15 the "no status code" branch also shows the bundled undici 6 ran the request:
  // through npm undici 7's Agent the span would carry the 101.
  it(`its span ends (Node ${process.version}, bundled undici ${process.versions.undici})`, async () => {
    const started = Date.now();
    const { result } = await inParent(
      () =>
        new Promise<string>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
          let opened = false;
          ws.onopen = () => {
            opened = true;
          };
          ws.onerror = () => undefined;
          ws.onclose = () => resolve(opened ? "opened" : "failed");
        }),
    );
    expect(result).toBe("opened");
    await waitFor(() => clientSpans(exporter).length === 1, GRACE * 10);
    const span = clientSpans(exporter)[0];
    expect(span?.attributes["url.full"]).toBe(`${server.base}/ws`);
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
    if (bundledMajor >= 7) {
      // Ended by `trailers` right after the 101 head.
      expect(span?.attributes["http.response.status_code"]).toBe(101);
    } else {
      // undici 6: only `create` was published; the grace timer armed there ended the span.
      expect(span?.attributes["http.response.status_code"]).toBeUndefined();
      expect(Date.now() - started).toBeGreaterThanOrEqual(GRACE);
    }
    expect(doubleEnds).toEqual([]);
    expect(diagnostics.failures).toEqual([]);
  });
});
