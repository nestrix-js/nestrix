// Shared fixture for the metrics tests (P6-02). Not a test file itself.
import "reflect-metadata";
import {
  BadRequestException,
  Controller,
  Get,
  Module,
  Param,
  type Type,
} from "@nestjs/common";
import { type Attributes, trace } from "@opentelemetry/api";
import {
  type DataPoint,
  type Histogram,
  MeterProvider,
  MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import { NestrixModule } from "../../src/nestrix.module.js";
import type { NestrixModuleOptions } from "../../src/options.js";

export const ADAPTERS = ["express", "fastify", "node"] as const;

@Controller("m")
export class MetricsController {
  /** Also says whether the active span records, to show the sample rate took effect. */
  @Get("ok/:id")
  ok(@Param("id") id: string): { id: string; recording: boolean } {
    return { id, recording: trace.getActiveSpan()?.isRecording() ?? false };
  }

  @Get("boom")
  boom(): never {
    throw new TypeError("boom");
  }

  @Get("bad")
  bad(): never {
    throw new BadRequestException("bad");
  }
}

export function metricsModule(options: NestrixModuleOptions): Type {
  @Module({
    imports: [NestrixModule.forRoot({ ui: false, ...options })],
    controllers: [MetricsController],
  })
  class MetricsTestModule {}
  return MetricsTestModule;
}

/** A pull reader: `collect()` on demand, nothing periodic. */
export class TestReader extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

/** A host-style SDK `MeterProvider` with a pull reader. Not registered. */
export function hostMeterProvider(): {
  provider: MeterProvider;
  reader: TestReader;
} {
  const reader = new TestReader();
  return { provider: new MeterProvider({ readers: [reader] }), reader };
}

export async function collect(reader: MetricReader): Promise<ResourceMetrics> {
  const { resourceMetrics, errors } = await reader.collect();
  if (errors.length > 0) throw new Error(`collect errors: ${String(errors)}`);
  return resourceMetrics;
}

export function metricNames(rm: ResourceMetrics): string[] {
  return rm.scopeMetrics
    .flatMap((s) => s.metrics.map((m) => m.descriptor.name))
    .sort();
}

export function points(
  rm: ResourceMetrics,
  name: string,
): DataPoint<unknown>[] {
  return rm.scopeMetrics.flatMap((s) =>
    s.metrics
      .filter((m) => m.descriptor.name === name)
      .flatMap((m) => m.dataPoints as DataPoint<unknown>[]),
  );
}

/** `http.server.request.duration` points as `{ attributes, count }`, sorted for comparison. */
export function durationCounts(
  rm: ResourceMetrics,
): { attributes: Attributes; count: number }[] {
  return points(rm, "http.server.request.duration")
    .map((p) => ({
      attributes: p.attributes,
      count: (p.value as Histogram).count,
    }))
    .sort((a, b) =>
      JSON.stringify(a.attributes).localeCompare(JSON.stringify(b.attributes)),
    );
}

export function scopeNames(rm: ResourceMetrics): string[] {
  return rm.scopeMetrics.map((s) => s.scope.name);
}
