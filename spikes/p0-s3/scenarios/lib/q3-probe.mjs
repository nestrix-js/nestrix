// Q3: runs every detection idea through the ESM api copy (Nestrix's side) after the
// host has registered some combination of globals through its own copy.
import * as esmApi from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { TracerProvider } from "@opentelemetry/sdk-trace";
import {
  detectAsyncContextManager,
  detectContextManager,
  detectPropagator,
  detectPropagatorByInject,
  detectTracerProviderByProbeSpan,
  propagatorFields,
} from "../../src/nestrix/detect.mjs";

export async function probeAll({ diagMessages, hostExporter }) {
  const before = diagMessages.length;
  const probes = {
    contextManagerSync: detectContextManager(),
    contextManagerAsync: await detectAsyncContextManager(),
    propagatorFields: propagatorFields(),
    propagatorByFields: detectPropagator(),
    propagatorByInject: detectPropagatorByInject(),
    providerByProbeSpan: detectTracerProviderByProbeSpan(),
  };
  const probeDiag = diagMessages.slice(before);
  const probeSpansInHostExporter = hostExporter
    ? hostExporter.getFinishedSpans().map((s) => s.name)
    : null;

  // The try-to-register approach, for comparison: return values and diag noise.
  const before2 = diagMessages.length;
  const cm = new AsyncLocalStorageContextManager();
  const attempts = {
    setGlobalTracerProvider: esmApi.trace.setGlobalTracerProvider(
      new TracerProvider({}),
    ),
    setGlobalContextManager: esmApi.context.setGlobalContextManager(cm),
    setGlobalPropagator: esmApi.propagation.setGlobalPropagator(
      new W3CTraceContextPropagator(),
    ),
  };
  const attemptDiag = diagMessages.slice(before2).map((m) => m.split("\n")[0]);
  return {
    probes,
    probeDiag,
    probeSpansInHostExporter,
    attempts,
    attemptDiag,
    publicGetters: {
      contextApi: Object.getOwnPropertyNames(
        Object.getPrototypeOf(esmApi.context),
      ),
      propagationApi: Object.getOwnPropertyNames(
        Object.getPrototypeOf(esmApi.propagation),
      ),
    },
  };
}
