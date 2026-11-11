import { trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { nestrixSpanProcessor } from "../../src/index.js";

// Your own SDK setup, started before NestFactory.create.
trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [
      new BatchSpanProcessor({ exporter: new OTLPTraceExporter() }),
      // Feeds the dashboard's store. It stores nothing while the dashboard is off.
      nestrixSpanProcessor(),
    ],
  }),
);
