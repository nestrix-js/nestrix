// Q1/Q2 driver shared by the ESM and the CommonJS host entry points. The entry point
// passes in its own setupHost (from its own copy of the SDK) and its own AppModule.
//
// Environment:
//   S3_ADAPTER        express | fastify | node
//   S3_STORE=1        the host adds nestrixSpanProcessor() to its spanProcessors (Q2)
//   S3_STORE_FAULT    "store": the store throws on every add (inside the guard)
//   S3_NAIVE_THROW=1  the host also lists an unguarded processor that throws, first
//   S3_SAMPLER=off    the host's provider uses AlwaysOffSampler
//   S3_FAULT          injected fault inside a Nestrix hook body (see instrumentation.mjs)
//   S3_ORDER          "nestrix-first": Nestrix sets up before the host does
//   DOWNSTREAM_URL    where /s3/work calls out to (default: this app's /hello)

import * as esmApi from "@opentelemetry/api";
import {
  faults,
  httpSkips,
  NestrixStandInModule,
  nestrixSpanProcessor,
  routeStats,
  setupNestrix,
} from "../../src/nestrix/setup.mjs";
import {
  announceReady,
  boot,
  emitResult,
  makeProbeController,
  makeRootModule,
  spanRecord,
  waitForFinish,
} from "./runtime.mjs";

const naiveThrowingProcessor = {
  onStart() {
    throw new Error("naive processor: onStart");
  },
  onEnd() {
    throw new Error("naive processor: onEnd");
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

export async function runHostScenario({ setupHost, appModule, hostFormat }) {
  const env = process.env;
  globalThis.__nestrixFault = env.S3_FAULT || undefined;
  const store = env.S3_STORE
    ? nestrixSpanProcessor({ fault: env.S3_STORE_FAULT })
    : undefined;
  const extraProcessors = [];
  if (env.S3_NAIVE_THROW) extraProcessors.push(naiveThrowingProcessor);
  if (store) extraProcessors.push(store);
  const hostOptions = { extraProcessors, sampler: env.S3_SAMPLER };

  let host;
  let nx;
  const errors = [];
  if (env.S3_ORDER === "nestrix-first") {
    nx = setupNestrix();
    host = setupHost(hostOptions);
  } else {
    host = setupHost(hostOptions);
    try {
      host.api.trace.getTracer("host-app").startSpan("host.startup").end();
    } catch (error) {
      errors.push(`host.startup: ${error.message}`);
    }
    // Nestrix gets its own processor: a provider that loses the registration race is
    // shut down, and shutdown() would reach any processor shared with the host.
    nx = setupNestrix();
  }

  const outUrl = () =>
    env.DOWNSTREAM_URL ?? `http://127.0.0.1:${globalThis.__scenarioPort}/hello`;
  const root = makeRootModule(
    [appModule, NestrixStandInModule],
    [makeProbeController(host.api, outUrl)],
  );
  const { app, port } = await boot(root, env.S3_ADAPTER ?? "express");
  announceReady(port);
  await waitForFinish();
  await new Promise((r) => setTimeout(r, 100)); // let `close` listeners run
  await host.provider.forceFlush().catch(() => {});

  emitResult({
    node: process.version,
    hostFormat,
    adapter: env.S3_ADAPTER ?? "express",
    hostRegistered: host.registered,
    nestrix: {
      providerRegistered: nx.providerRegistered,
      contextManagerDetected: nx.contextManagerDetected,
      contextManagerRegistered: nx.contextManagerRegistered ?? null,
      propagatorDetected: nx.propagatorDetected,
      propagatorRegistered: nx.propagatorRegistered ?? null,
      log: nx.log,
    },
    apiCopies: {
      hostApiFile: host.apiFile,
      nestrixApiFile: import.meta.resolve("@opentelemetry/api"),
      sameModuleObject: host.api.trace === esmApi.trace,
    },
    hostSpans: host.exporter.getFinishedSpans().map(spanRecord),
    nestrixOwnStore: nx.processor.store.spans,
    storeSpans: store ? store.store.spans : null,
    storeStats: store ? store.store.stats : null,
    faults,
    routeStats,
    httpSkips,
    errors,
  });
  await app.close();
  process.exit(0);
}
