// Everything `NestrixCore` needs once Nestrix is on: the OpenTelemetry SDK setup, the exporters,
// the dashboard and store, metrics, log export, the HTTP, outbound and database instrumentation,
// and the remote profiler (D-99, issue #41). This module is loaded only through the dynamic
// `import()` in `runtime-loader.ts`, never statically from the package entry, so an app with
// Nestrix switched off does not load the SDK packages or the dashboard code. Like every module
// here it has no side effects at import (architecture §4.2, "Registration timing").
export { createDashboard, UI_MISSING_MESSAGE } from "./dashboard/mount.js";
export { installHttpInstrumentation } from "./http/server.js";
export {
  installIntegrations,
  rescanIntegrations,
} from "./integrations/index.js";
export { setupLogExport } from "./logs/export.js";
export { startMetrics } from "./metrics/index.js";
export { instanceIdentity } from "./otel/resource.js";
export { setupTelemetry } from "./otel/setup.js";
export { installOutbound } from "./outbound/index.js";
export { buildRedactedQueryKeys, scrubSpanAttributes } from "./privacy.js";
export { installProcessErrorMonitor } from "./process-errors.js";
export { RemoteProfilerPoller } from "./profiler/remote.js";
