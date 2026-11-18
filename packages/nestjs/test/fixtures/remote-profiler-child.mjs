// Child process for profiler-remote-exit.test.ts (P10-01): a Nest application context (no HTTP
// adapter) with the built @nestrix-js/nestjs and `export.profiler: true` against argv[2]. Waits
// argv[3] ms (so a check-in is in flight, or a capture runs), closes the app, prints one JSON line.
// The parent measures how long the process lingers after that line. When argv[4] is "stdin",
// argv[3] is ignored and the child waits for the parent to write a line on stdin instead, so the
// parent can close it once a condition holds (say, enough check-ins) rather than after a fixed delay.
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestrixModule } from "../../dist/index.js";
import { runningCapture } from "../../dist/profiler/profiler.js";
import { remoteRuntime } from "../../dist/profiler/remote.js";

const [url, waitMs, mode] = process.argv.slice(2);
remoteRuntime.timing = {
  firstMinMs: 20,
  firstMaxMs: 20,
  minIntervalMs: 20,
  jitter: 0,
};

class Root {}
Module({
  imports: [
    NestrixModule.forRoot({
      serviceName: "exit-child",
      ui: false,
      metrics: false,
      export: { profiler: true, otlp: { endpoint: url, timeoutMillis: 5000 } },
    }),
  ],
})(Root);

const app = await NestFactory.createApplicationContext(Root, { logger: false });
if (mode === "stdin") {
  await new Promise((r) => process.stdin.once("data", r));
  process.stdin.pause();
} else {
  await new Promise((r) => setTimeout(r, Number(waitMs)));
}
const capturing = runningCapture() !== null;
const started = Date.now();
await app.close();
process.stdout.write(
  `${JSON.stringify({
    capturing,
    stillCapturing: runningCapture() !== null,
    closeMs: Date.now() - started,
  })}\n`,
);
