// DEMONSTRATION, not instrumentation: what the host sees when a diagnostics-channel
// subscriber throws and nothing catches it (why rule 1 wraps every subscriber body).
//   node scripts/unguarded-subscriber.mjs handled     # with an uncaughtException handler
//   node scripts/unguarded-subscriber.mjs unhandled   # without one (the default app)
// REDIS_URL set: also throws from an `ioredis:command` TracingChannel `start` subscriber.
import dc from "node:diagnostics_channel";
import http from "node:http";
import { Redis } from "ioredis";

const variant = process.argv[2] ?? "handled";
const seen = [];
if (variant === "handled") {
  process.on("uncaughtException", (e) =>
    seen.push(`uncaughtException: ${e.message}`),
  );
}

dc.subscribe("http.client.request.created", () => {
  throw new Error("unguarded http.client.request.created subscriber");
});
if (process.env.REDIS_URL) {
  dc.tracingChannel("ioredis:command").subscribe({
    start() {
      throw new Error("unguarded ioredis:command start subscriber");
    },
  });
}

const server = http.createServer((_req, res) => res.end("ok"));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const status = await new Promise((resolve) => {
  http
    .get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    })
    .on("error", (e) => resolve(`request error: ${e.message}`));
});
let redisResult;
if (process.env.REDIS_URL) {
  const redis = new Redis(process.env.REDIS_URL);
  redisResult = await redis.ping().catch((e) => `error: ${e.message}`);
  await redis.quit();
}
server.close();
await new Promise((r) => setTimeout(r, 50));
process.stdout.write(
  `__UNGUARDED__${JSON.stringify({ variant, node: process.version, httpStatus: status, redisResult, seen })}\n`,
);
