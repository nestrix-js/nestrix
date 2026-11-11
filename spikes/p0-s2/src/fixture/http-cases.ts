import http from "node:http";
import type { AddressInfo } from "node:net";

export interface CaseResult {
  name: string;
  status?: number;
  error?: string;
  /** performance.timeOrigin-based ms when the response body ended (or the call settled). */
  settledMs: number;
  bodyEndMs?: number;
}

const now = () => performance.timeOrigin + performance.now();

function run(
  name: string,
  start: (done: (r: Omit<CaseResult, "name" | "settledMs">) => void) => void,
): Promise<CaseResult> {
  return new Promise((resolve) => {
    let settled = false;
    start((r) => {
      if (settled) return;
      settled = true;
      resolve({ name, settledMs: now(), ...r });
    });
  });
}

const errText = (e: unknown) =>
  e instanceof Error
    ? `${(e as { code?: string }).code ?? e.name}: ${e.message}`
    : String(e);

export async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Every case runs sequentially inside the caller's active span. */
export async function runHttpCases(base: string): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const simple = (name: string, path: string, opts: http.RequestOptions = {}) =>
    run(name, (done) => {
      const req = http.get(`${base}${path}`, opts, (res) => {
        res.resume();
        res.on("end", () => done({ status: res.statusCode, bodyEndMs: now() }));
        res.on("error", (e) =>
          done({ status: res.statusCode, error: errText(e) }),
        );
      });
      req.on("error", (e) => done({ error: errText(e) }));
    });

  results.push(await simple("ok", "/ok"));
  results.push(await simple("status500", "/500"));
  results.push(await simple("slowBody", "/slow-body"));
  const port = await closedPort();
  results.push(
    await run("refused", (done) => {
      http
        .get(`http://127.0.0.1:${port}/x`, (res) => {
          res.resume();
          done({ status: res.statusCode });
        })
        .on("error", (e) => done({ error: errText(e) }));
    }),
  );
  results.push(await simple("serverDestroys", "/destroy"));
  results.push(
    await run("abortBeforeResponse", (done) => {
      const ac = new AbortController();
      http
        .get(`${base}/hang`, { signal: ac.signal }, (res) => {
          res.resume();
          done({ status: res.statusCode });
        })
        .on("error", (e) => done({ error: errText(e) }));
      setTimeout(() => ac.abort(), 50);
    }),
  );
  results.push(
    await run("abortMidBody", (done) => {
      const req = http.get(`${base}/slow-body`, (res) => {
        res.once("data", () => {
          req.destroy();
          done({
            status: res.statusCode,
            error: "destroyed after first chunk",
          });
        });
      });
      req.on("error", (e) => done({ error: errText(e) }));
    }),
  );
  results.push(
    await run("timeoutDestroy", (done) => {
      const req = http.get(`${base}/hang`, { timeout: 50 }, (res) => {
        res.resume();
        done({ status: res.statusCode });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", (e) => done({ error: errText(e) }));
      req.on("close", () => done({ error: "closed" }));
    }),
  );
  results.push(
    await run("destroyWithoutError", (done) => {
      // destroy() with no error argument, before any response.
      const req = http.request(`${base}/hang`, { method: "POST" });
      req.on("error", (e) => done({ error: errText(e) }));
      req.on("close", () => done({ error: "closed without error event" }));
      req.write("x");
      setTimeout(() => req.destroy(), 50);
    }),
  );
  results.push(
    await run("destroyImmediately", (done) => {
      const req = http.get(`${base}/never-sent`);
      req.on("error", (e) => done({ error: errText(e) }));
      req.on("close", () => done({ error: "closed" }));
      req.destroy();
    }),
  );
  results.push(
    await run("arrayHeaders", (done) => {
      const req = http.request(
        `${base}/array-headers`,
        {
          headers: [
            "host",
            new URL(base).host,
            "x-array",
            "1",
          ] as unknown as http.OutgoingHttpHeaders,
        },
        (res) => {
          res.resume();
          res.on("end", () => done({ status: res.statusCode }));
        },
      );
      req.on("error", (e) => done({ error: errText(e) }));
      req.end();
    }),
  );
  results.push(
    await simple("userTraceparent", "/user-traceparent", {
      headers: {
        traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
      },
    }),
  );
  const agent = new http.Agent({ keepAlive: true });
  results.push(await simple("keepAlive1", "/keepalive-1", { agent }));
  results.push(await simple("keepAlive2", "/keepalive-2", { agent }));
  agent.destroy();
  // Review F2: the caller reads the status and never consumes the body. Its own agent,
  // destroyed afterwards, so the unread socket does not linger.
  const unreadAgent = new http.Agent({ keepAlive: false });
  results.push(
    await run("unreadBody", (done) => {
      http
        .get(`${base}/big`, { agent: unreadAgent }, (res) =>
          done({ status: res.statusCode }),
        )
        .on("error", (e) => done({ error: errText(e) }));
    }),
  );
  // No 'response' listener at all: Node dumps (reads and discards) the body itself.
  results.push(
    await run("noResponseListener", (done) => {
      const req = http.get(`${base}/big-dumped`);
      req.on("error", (e) => done({ error: errText(e) }));
      req.on("close", () => done({}));
    }),
  );
  // Starts reading only on a later tick: the span has already ended at the head.
  results.push(
    await run("lateConsumer", (done) => {
      http
        .get(`${base}/big`, { agent: unreadAgent }, (res) => {
          setTimeout(() => {
            res.resume();
            res.on("end", () =>
              done({ status: res.statusCode, bodyEndMs: now() }),
            );
          }, 50);
        })
        .on("error", (e) => done({ error: errText(e) }));
    }),
  );
  unreadAgent.destroy();
  return results;
}
