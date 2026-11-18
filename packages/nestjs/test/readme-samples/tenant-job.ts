import { Processor, WorkerHost } from "@nestjs/bullmq";
import type { Job } from "bullmq";
import { setTraceAttributes } from "../../src/index.js";

@Processor("reports")
export class ReportProcessor extends WorkerHost {
  async process(job: Job<{ tenantId: string }>): Promise<void> {
    // On the job's root span; listed in contextPropagation.keys, it also reaches the jobs this one queues.
    setTraceAttributes({ "tenant.id": job.data.tenantId });
  }
}
