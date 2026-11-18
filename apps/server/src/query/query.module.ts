import {
  type ClassProvider,
  type DynamicModule,
  type ExistingProvider,
  type FactoryProvider,
  Logger,
  Module,
  type ValueProvider,
} from "@nestjs/common";
import type { Pool } from "pg";
import {
  ERROR_SYNC_OPTIONS,
  ErrorGroupSync,
  type ErrorSyncOptions,
} from "../errors/sync.js";
import { ErrorGroupSyncLifecycle } from "../errors/sync.lifecycle.js";
import { ErrorTriageController } from "../errors/triage.controller.js";
import { SlosService } from "../slos/slos.service.js";
import { STORAGE_POOL } from "../storage/storage.module.js";
import { ExplainService } from "./explain.service.js";
import { DenyQueryGuard, QUERY_GUARD, QueryGuardGate } from "./guard.js";
import {
  QUERY_OPTIONS,
  type QueryModuleOptions,
  type ResolvedQueryOptions,
} from "./options.js";
import { OverviewService } from "./overview.service.js";
import { QueryController } from "./query.controller.js";
import { QueryService } from "./query.service.js";
import { TraceLogsService } from "./trace-logs.service.js";

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
      // The triage routes are admin-only writes (`SessionQueryGuard`); they share the path of the
      // error group reads.
      controllers: [QueryController, ErrorTriageController],
      providers: [
        {
          provide: QUERY_GUARD,
          ...(options.guard ?? { useClass: DenyQueryGuard }),
        } as ClassProvider | ExistingProvider | ValueProvider | FactoryProvider,
        { provide: QUERY_OPTIONS, useValue: resolved },
        QueryGuardGate,
        QueryService,
        OverviewService,
        ExplainService,
        // Stateless (needs only STORAGE_POOL): the overview reads SLO burn rates through it.
        SlosService,
        TraceLogsService,
        // Stored triage state of error groups (issue #26, D-103).
        { provide: ERROR_SYNC_OPTIONS, useValue: options.errorSync ?? {} },
        {
          provide: ErrorGroupSync,
          inject: [STORAGE_POOL, QueryService, ERROR_SYNC_OPTIONS],
          useFactory: (
            pool: Pool,
            query: QueryService,
            o: ErrorSyncOptions,
          ) => {
            const logger = new Logger("NestrixErrorGroups");
            return new ErrorGroupSync(pool, query, {
              ...o,
              onError: o.onError ?? ((message) => logger.warn(message)),
            });
          },
        },
        ErrorGroupSyncLifecycle,
      ],
    };
  }
}
