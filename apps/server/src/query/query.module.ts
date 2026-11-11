import {
  type ClassProvider,
  type DynamicModule,
  type ExistingProvider,
  type FactoryProvider,
  Module,
  type ValueProvider,
} from "@nestjs/common";
import { DenyQueryGuard, QUERY_GUARD, QueryGuardGate } from "./guard.js";
import {
  QUERY_OPTIONS,
  type QueryModuleOptions,
  type ResolvedQueryOptions,
} from "./options.js";
import { QueryController } from "./query.controller.js";
import { QueryService } from "./query.service.js";

/**
 * The query API (`GET /api/v1/*`). Needs `StorageModule` (global) for the database. Closed by
 * default: pass `guard` to open it (`guard.ts` explains the hook).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class QueryModule {
  static forRoot(options: QueryModuleOptions = {}): DynamicModule {
    const resolved: ResolvedQueryOptions = {
      statsCacheMs: options.statsCacheMs ?? 5000,
    };
    return {
      module: QueryModule,
      imports: options.imports ?? [],
      controllers: [QueryController],
      providers: [
        {
          provide: QUERY_GUARD,
          ...(options.guard ?? { useClass: DenyQueryGuard }),
        } as ClassProvider | ExistingProvider | ValueProvider | FactoryProvider,
        { provide: QUERY_OPTIONS, useValue: resolved },
        QueryGuardGate,
        QueryService,
      ],
    };
  }
}
