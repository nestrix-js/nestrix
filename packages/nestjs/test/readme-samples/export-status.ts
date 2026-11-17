import { Controller, Get } from "@nestjs/common";
import { getExportStatus } from "../../src/index.js";

@Controller("health")
export class HealthController {
  // Readiness: your own checks decide it. Telemetry is reported, never a reason to fail it,
  // so an observability outage cannot get your pods restarted or taken out of the load balancer.
  @Get("ready")
  ready() {
    const telemetry = getExportStatus();
    return {
      status: "ok",
      telemetry: telemetry.degraded ? "degraded" : "ok",
      traces: telemetry.traces.state,
      lastTraceFailure: telemetry.traces.lastFailure,
      droppedSpans: telemetry.traces.dropped,
    };
  }
}
