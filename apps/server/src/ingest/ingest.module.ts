import {
  type ClassProvider,
  type DynamicModule,
  type ExistingProvider,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
  type ValueProvider,
} from "@nestjs/common";
import { IngestController } from "./ingest.controller.js";
import type { IngestSink } from "./model.js";
import { IngestReceiver } from "./receiver.js";
import { INGEST_SINK } from "./tokens.js";

/** How the `IngestSink` is provided: any Nest provider shape, without `provide`. */
export type IngestSinkProvider =
  | Omit<ClassProvider<IngestSink>, "provide">
  | Omit<ExistingProvider<IngestSink>, "provide">
  | Omit<ValueProvider<IngestSink>, "provide">
  | Omit<FactoryProvider<IngestSink>, "provide">;

export interface IngestModuleOptions {
  /** Modules the sink provider needs, e.g. the storage module that exports the writer. */
  imports?: ModuleMetadata["imports"];
  sink: IngestSinkProvider;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class IngestModule {
  static forRoot(options: IngestModuleOptions): DynamicModule {
    return {
      module: IngestModule,
      imports: options.imports ?? [],
      controllers: [IngestController],
      providers: [
        { provide: INGEST_SINK, ...options.sink } as
          | ClassProvider
          | ExistingProvider
          | ValueProvider
          | FactoryProvider,
        IngestReceiver,
      ],
      // `IngestReceiver`: its key check, rate limiter and memory budget are shared with the
      // instance side of remote profiling (P10-02).
      exports: [INGEST_SINK, IngestReceiver],
    };
  }
}
