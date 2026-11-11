// Injected faults inside the receiver: whatever throws, the request is answered and the
// process keeps serving.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IngestReceiver } from "../../src/ingest/receiver.js";
import {
  auth,
  fixture,
  JSON_TYPE,
  PROTO,
  post,
  startServer,
  type TestServer,
} from "./helpers.js";

let server: TestServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
});

describe("receiver faults", () => {
  it("answers 500 in the request's encoding when the pipeline throws", async () => {
    const receiver = server.app.get(IngestReceiver);
    const spy = vi
      .spyOn(receiver as unknown as { process: () => never }, "process")
      .mockImplementation(() => {
        throw new Error("injected");
      });
    try {
      const res = await post(server.url, fixture("traces.json"), {
        ...auth(),
        "content-type": JSON_TYPE,
      });
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe(JSON_TYPE);
      expect(await res.json()).toEqual({ message: "internal error" });
    } finally {
      spy.mockRestore();
    }
    const ok = await post(server.url, fixture("traces.pb"), {
      ...auth(),
      "content-type": PROTO,
    });
    expect(ok.status).toBe(200);
  });

  it("survives a failing logger while handling a failure", async () => {
    const receiver = server.app.get(IngestReceiver);
    const logger = (receiver as unknown as { logger: { error: () => void } })
      .logger;
    const loggerSpy = vi.spyOn(logger, "error").mockImplementation(() => {
      throw new Error("logger down");
    });
    // Reset the log throttle so the logger is reached.
    (receiver as unknown as { lastSinkLogMs: number }).lastSinkLogMs =
      Number.NEGATIVE_INFINITY;
    server.sink.behaviour = async () => {
      throw new Error("storage down");
    };
    try {
      const res = await post(server.url, fixture("traces.pb"), {
        ...auth(),
        "content-type": PROTO,
      });
      expect(res.status).toBe(503);
      expect(loggerSpy).toHaveBeenCalled();
    } finally {
      server.sink.behaviour = async () => {};
      loggerSpy.mockRestore();
    }
  });
});
