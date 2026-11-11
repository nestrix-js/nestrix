import type {
  CanActivate,
  ClassProvider,
  ExistingProvider,
  FactoryProvider,
  ModuleMetadata,
  ValueProvider,
} from "@nestjs/common";

/** How the query API's guard is provided: any Nest provider shape, without `provide`. */
export type QueryGuardProvider =
  | Omit<ClassProvider<CanActivate>, "provide">
  | Omit<ExistingProvider<CanActivate>, "provide">
  | Omit<ValueProvider<CanActivate>, "provide">
  | Omit<FactoryProvider<CanActivate>, "provide">;

export interface QueryModuleOptions {
  /** Modules the guard provider needs. */
  imports?: ModuleMetadata["imports"];
  /** The guard every query route runs. Default: `DenyQueryGuard` (the API is closed). */
  guard?: QueryGuardProvider;
  /**
   * How long the store counts of `meta` (a `count(*)` over the trace and span tables) are reused,
   * in ms. Default 5000; 0 recounts on every request.
   */
  statsCacheMs?: number;
}

export interface ResolvedQueryOptions {
  statsCacheMs: number;
}

export const QUERY_OPTIONS = Symbol("nestrix-server:query-options");
