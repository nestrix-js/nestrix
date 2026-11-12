---
"@nestrix-js/nestjs": minor
"@nestrix-js/ui": minor
---

**The standalone server's Profiler shows each instance's CPU, event-loop delay, heap and RSS, and suggests which one to capture.** With `export.profiler: true`, each check-in now also sends `runtimeSample`. It carries CPU since the previous check-in, heap used and RSS, read at that moment with no extra timer. When the process also runs the embedded dashboard, it adds the event-loop delay p99 from the Runtime view. The server keeps the latest figures per instance and returns them in `GET /api/v1/instances`. The Profiler page shows them, with "—" when an instance does not report a figure (an older SDK, or no loop figure without the dashboard). It marks an instance "Suggested" when it is clearly busier than the other instances of its service. The fields are optional and additive: older SDKs and servers keep working.
