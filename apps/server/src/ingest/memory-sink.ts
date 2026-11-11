import { Injectable, Logger } from "@nestjs/common";
import type { IngestBatch, IngestSink } from "./model.js";

/**
 * Default sink until the Postgres writer (P5-02) is wired: keeps the most recent batches in
 * memory, bounded, and counts the spans it saw. Nothing is durable.
 */
@Injectable()
export class MemoryIngestSink implements IngestSink {
  static readonly MAX_BATCHES = 100;
  private readonly logger = new Logger("MemoryIngestSink");
  private warned = false;
  readonly batches: IngestBatch[] = [];
  spans = 0;

  async write(batch: IngestBatch): Promise<void> {
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        "Spans are kept in memory only (storage is not wired yet) and are lost on restart.",
      );
    }
    for (const rs of batch.resourceSpans) this.spans += rs.spans.length;
    this.batches.push(batch);
    if (this.batches.length > MemoryIngestSink.MAX_BATCHES) {
      this.batches.shift();
    }
  }
}
