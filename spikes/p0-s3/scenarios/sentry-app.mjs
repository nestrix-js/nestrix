// Q4 app: the fixture AppModule with Sentry's Nest module and global filter (as
// Sentry's Nest setup adds them) and the Nestrix stand-in. Run with
// `node --import ./scenarios/sentry-instrument.mjs scenarios/sentry-app.mjs`.
import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import * as api from "@opentelemetry/api";
import {
  getClient,
  getCurrentScope,
  getTraceContextFromScope,
  hasExternalPropagationContext,
} from "@sentry/core";
import * as Sentry from "@sentry/nestjs";
import { SentryGlobalFilter, SentryModule } from "@sentry/nestjs/setup";
import { AppModule } from "express-esm/app.module";
import {
  faults,
  httpSkips,
  NestrixStandInModule,
  routeStats,
  setupNestrix,
} from "../src/nestrix/setup.mjs";
import {
  announceReady,
  boot,
  emitResult,
  spanRecord,
  waitForFinish,
} from "./lib/runtime.mjs";

// S3_FAULT=route-hook turns the route hook into a no-op (it throws inside its guard),
// to compare span names with and without it.
globalThis.__nestrixFault = process.env.S3_FAULT || undefined;
// S3_ROUTE_LEGACY=1: the pre-review route hook (renames trace.getActiveSpan()).
globalThis.__nestrixRouteLegacy = process.env.S3_ROUTE_LEGACY === "1";
const nx = setupNestrix();

// GET /s3/probe: what Sentry and the OTel api each see inside a request.
class ProbeController {
  probe() {
    const otel = api.trace.getActiveSpan()?.spanContext() ?? null;
    return {
      otelActive: otel && { traceId: otel.traceId, spanId: otel.spanId },
      sentryActiveSpan: Sentry.getActiveSpan()?.spanContext() ?? null,
      sentryTraceContext: getTraceContextFromScope(getCurrentScope()),
      sentryTraceData: Sentry.getTraceData(),
      hasExternalPropagationContext: hasExternalPropagationContext(),
      integrations: Object.keys(getClient()?._integrations ?? {}),
    };
  }
}
Controller("s3")(ProbeController);
Get("probe")(
  ProbeController.prototype,
  "probe",
  Object.getOwnPropertyDescriptor(ProbeController.prototype, "probe"),
);

class SentryRootModule {}
Module({
  imports: [SentryModule.forRoot(), AppModule, NestrixStandInModule],
  controllers: [ProbeController],
  providers: [{ provide: APP_FILTER, useClass: SentryGlobalFilter }],
})(SentryRootModule);

const { app, port } = await boot(
  SentryRootModule,
  process.env.S3_ADAPTER ?? "express",
);
process.env.PORT = String(port);
announceReady(port);
await waitForFinish();
await new Promise((r) => setTimeout(r, 200));
await globalThis.__host?.provider.forceFlush();
const flushed = await Sentry.flush(3000);

emitResult({
  node: process.version,
  mode: globalThis.__sentryMode,
  nestrix: {
    providerRegistered: nx.providerRegistered,
    contextManagerDetected: nx.contextManagerDetected,
    contextManagerRegistered: nx.contextManagerRegistered ?? null,
    propagatorDetected: nx.propagatorDetected,
    propagatorRegistered: nx.propagatorRegistered ?? null,
    propagatorFields: api.propagation.fields(),
  },
  hostRegistered: globalThis.__host?.registered ?? null,
  hostSpans: globalThis.__host
    ? globalThis.__host.exporter.getFinishedSpans().map(spanRecord)
    : null,
  nestrixOwnStore: nx.processor.store.spans,
  sentryFlushed: flushed,
  faults,
  routeStats,
  httpSkips,
});
await app.close();
process.exit(0);
