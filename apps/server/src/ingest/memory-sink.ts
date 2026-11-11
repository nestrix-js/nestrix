import { Injectable, Logger } from "@nestjs/common";
import type { IngestBatch, IngestSink } from "./model.js";

/**
 * Sink for running without storage: counts what it receives and keeps nothing, so its memory
 * does not grow with traffic.
 */
@Injectable()
export class MemoryIngestSink implements IngestSink {
  private readonly logger = new Logger("MemoryIngestSink");
  private warned = false;
  batches = 0;
  spans = 0;

  async write(batch: IngestBatch): Promise<void> {
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        "Spans are counted and discarded: no storage is wired to this sink.",
      );
    }
    this.batches++;
    for (const rs of batch.resourceSpans) this.spans += rs.spans.length;
  }
}
