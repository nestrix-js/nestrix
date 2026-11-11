/**
 * Runtime metrics as observable instruments (P6-02, D-66). Names from
 * `@opentelemetry/semantic-conventions` 1.45.0 (incubating, so string literals, as in
 * otel/pipeline.ts):
 *
 * - `nodejs.eventloop.delay.p50`, `.p99`, `.max`: gauges, seconds, from
 *   `perf_hooks.monitorEventLoopDelay`; reset after each collection, so each value covers one
 *   export interval. Nothing is reported for an interval with no samples.
 * - `v8js.memory.heap.used` and `v8js.memory.heap.space.size`: up-down counters, bytes, per
 *   `v8js.heap.space.name`, from `v8.getHeapSpaceStatistics()` (`space_used_size`,
 *   `space_size`). The conventions deprecate `v8js.memory.heap.limit` in favour of
 *   `v8js.memory.heap.space.size`, so the limit is not reported.
 * - `process.memory.usage` (RSS): up-down counter, bytes, from `process.memoryUsage.rss()`.
 * - `process.cpu.time`: counter, seconds, per `cpu.mode` (`user`, `system`), from
 *   `process.cpuUsage()`.
 *
 * One batch callback reads them all, only when a reader collects. Each source has its own guard;
 * a failure is counted and the other sources still report. Imports `@opentelemetry/api` only.
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import type {
  Attributes,
  BatchObservableCallback,
  Meter,
  Observable,
} from "@opentelemetry/api";
import type { Diagnostics } from "../diagnostics.js";

export const RUNTIME_METRIC_NAMES = Object.freeze({
  eventLoopDelayP50: "nodejs.eventloop.delay.p50",
  eventLoopDelayP99: "nodejs.eventloop.delay.p99",
  eventLoopDelayMax: "nodejs.eventloop.delay.max",
  heapUsed: "v8js.memory.heap.used",
  heapSpaceSize: "v8js.memory.heap.space.size",
  memoryUsage: "process.memory.usage",
  cpuTime: "process.cpu.time",
});

const ATTR_V8JS_HEAP_SPACE_NAME = "v8js.heap.space.name";
const ATTR_CPU_MODE = "cpu.mode";
const CPU_USER: Attributes = Object.freeze({ [ATTR_CPU_MODE]: "user" });
const CPU_SYSTEM: Attributes = Object.freeze({ [ATTR_CPU_MODE]: "system" });
/** `monitorEventLoopDelay` sampling resolution. Node's default is 10 ms. */
const EVENT_LOOP_RESOLUTION_MS = 20;

export interface RuntimeMetrics {
  stop(): void;
}

/** Creates the instruments on `meter` and starts the event-loop monitor. Never throws. */
export function startRuntimeMetrics(
  meter: Meter,
  diagnostics: Diagnostics,
): RuntimeMetrics | undefined {
  let delay: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    const n = RUNTIME_METRIC_NAMES;
    const p50 = meter.createObservableGauge(n.eventLoopDelayP50, {
      description: "Event loop 50 percentile delay.",
      unit: "s",
    });
    const p99 = meter.createObservableGauge(n.eventLoopDelayP99, {
      description: "Event loop 99 percentile delay.",
      unit: "s",
    });
    const max = meter.createObservableGauge(n.eventLoopDelayMax, {
      description: "Event loop maximum delay.",
      unit: "s",
    });
    const heapUsed = meter.createObservableUpDownCounter(n.heapUsed, {
      description: "Heap memory size allocated.",
      unit: "By",
    });
    const heapSpaceSize = meter.createObservableUpDownCounter(n.heapSpaceSize, {
      description: "Committed size of a heap space.",
      unit: "By",
    });
    const rss = meter.createObservableUpDownCounter(n.memoryUsage, {
      description: "The amount of physical memory in use.",
      unit: "By",
    });
    const cpu = meter.createObservableCounter(n.cpuTime, {
      description: "Total CPU seconds broken down by different CPU modes.",
      unit: "s",
    });
    const observables: Observable[] = [
      p50,
      p99,
      max,
      heapUsed,
      heapSpaceSize,
      rss,
      cpu,
    ];

    const monitor = monitorEventLoopDelay({
      resolution: EVENT_LOOP_RESOLUTION_MS,
    });
    monitor.enable();
    delay = monitor;
    const spaceAttributes = new Map<string, Attributes>();

    const callback: BatchObservableCallback = (result) => {
      try {
        if (monitor.count > 0) {
          result.observe(p50, monitor.percentile(50) / 1e9);
          result.observe(p99, monitor.percentile(99) / 1e9);
          result.observe(max, monitor.max / 1e9);
        }
        monitor.reset();
      } catch (error) {
        diagnostics.countFailure("metrics.runtime.eventloop", error);
      }
      try {
        for (const space of getHeapSpaceStatistics()) {
          let attributes = spaceAttributes.get(space.space_name);
          if (attributes === undefined) {
            attributes = Object.freeze({
              [ATTR_V8JS_HEAP_SPACE_NAME]: space.space_name,
            });
            spaceAttributes.set(space.space_name, attributes);
          }
          result.observe(heapUsed, space.space_used_size, attributes);
          result.observe(heapSpaceSize, space.space_size, attributes);
        }
      } catch (error) {
        diagnostics.countFailure("metrics.runtime.heap", error);
      }
      try {
        result.observe(rss, process.memoryUsage.rss());
      } catch (error) {
        diagnostics.countFailure("metrics.runtime.memory", error);
      }
      try {
        const usage = process.cpuUsage();
        result.observe(cpu, usage.user / 1e6, CPU_USER);
        result.observe(cpu, usage.system / 1e6, CPU_SYSTEM);
      } catch (error) {
        diagnostics.countFailure("metrics.runtime.cpu", error);
      }
    };
    meter.addBatchObservableCallback(callback, observables);

    return {
      stop() {
        try {
          meter.removeBatchObservableCallback(callback, observables);
        } catch (error) {
          diagnostics.countFailure("metrics.runtime-stop", error);
        }
        try {
          monitor.disable();
        } catch (error) {
          diagnostics.countFailure("metrics.runtime-stop", error);
        }
      },
    };
  } catch (error) {
    diagnostics.countFailure("metrics.runtime-start", error);
    try {
      delay?.disable();
    } catch {
      // Counted above.
    }
    return undefined;
  }
}
