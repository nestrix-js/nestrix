import { type DynamicModule, Module } from "@nestjs/common";
import { InstanceController } from "./instance.controller.js";
import { RemoteProfilesController } from "./remote-profiles.controller.js";
import { RemoteProfileStore } from "./store.js";

export interface RemoteProfilesModuleOptions {
  /**
   * The application's `IngestModule.forRoot(...)`, the same object `AppModule` imports (so Nest
   * resolves one instance): the instance routes share its receiver's key check, rate limiter and
   * memory budget.
   */
  ingest: DynamicModule;
}

/**
 * Remote CPU profiling (docs/backlog/phase-10.md P10-02, D-76): the instance routes on the ingest
 * port (`InstanceController`, ingest key), the dashboard routes under `/api/v1`
 * (`RemoteProfilesController`) and the store. Needs `StorageModule` (global: `STORAGE_POOL`).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class RemoteProfilesModule {
  static forRoot(options: RemoteProfilesModuleOptions): DynamicModule {
    return {
      module: RemoteProfilesModule,
      imports: [options.ingest],
      controllers: [InstanceController, RemoteProfilesController],
      providers: [RemoteProfileStore],
      exports: [RemoteProfileStore],
    };
  }
}
