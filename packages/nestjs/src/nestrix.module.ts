import {
  type DynamicModule,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { NestrixCore } from "./core.js";
import { NestrixInterceptor } from "./http/interceptor.js";
import { noteModuleDefinition } from "./methods/registry.js";
import { NestrixMicroservices } from "./microservices/index.js";
import type { NestrixModuleOptions } from "./options.js";
import {
  isDisabledByEnv,
  type ResolvedOptions,
  resolveOptions,
} from "./resolve-options.js";
import { loadNestrixRuntime } from "./runtime-loader.js";
import { NESTRIX_OPTIONS, NESTRIX_RUNTIME } from "./tokens.js";

export interface NestrixModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  inject?: FactoryProvider["inject"];
  /** Receives what `inject` lists, in order. May be async. */
  useFactory: (
    ...args: never[]
  ) => NestrixModuleOptions | Promise<NestrixModuleOptions>;
}

/** No providers at all: `enabled: false` registers nothing. */
function disabledModule(): DynamicModule {
  noteModuleDefinition(false);
  return { module: NestrixModule };
}

/**
 * The SDK, exporters and dashboard, loaded with a dynamic `import()` (D-99) only when this app's
 * options turn Nestrix on. Nest awaits the factory's promise before constructing `NestrixCore`.
 */
const runtimeProvider: FactoryProvider = {
  provide: NESTRIX_RUNTIME,
  inject: [NESTRIX_OPTIONS],
  useFactory: (options: ResolvedOptions) =>
    options.enabled ? loadNestrixRuntime() : undefined,
};

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class NestrixModule {
  static forRoot(options: NestrixModuleOptions = {}): DynamicModule {
    const env = process.env;
    // Resolved here so an invalid option fails at module creation.
    const resolved = resolveOptions(options, env);
    if (!resolved.enabled) return disabledModule();
    noteModuleDefinition(true);
    // Start loading now (code only: nothing is registered or started), so it is normally done by
    // the time Nest constructs providers; `runtimeProvider` awaits the same promise.
    void loadNestrixRuntime();
    return {
      module: NestrixModule,
      global: true,
      providers: [
        { provide: NESTRIX_OPTIONS, useValue: resolved },
        runtimeProvider,
        NestrixCore,
        NestrixMicroservices,
        { provide: APP_INTERCEPTOR, useClass: NestrixInterceptor },
      ],
      exports: [NESTRIX_OPTIONS, NestrixCore],
    };
  }

  static forRootAsync(options: NestrixModuleAsyncOptions): DynamicModule {
    // The environment kill switch is known now; `enabled: false` from the factory is not,
    // so that case yields `ResolvedOptions.enabled === false` and an inert `NestrixCore`
    // (and the runtime is never loaded). Instances are decorated as for an enabled module:
    // `nestrixInstrumentIf` is the way to switch method wrappers off from configuration (D-99).
    if (isDisabledByEnv(process.env)) return disabledModule();
    noteModuleDefinition(true);
    return {
      module: NestrixModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: NESTRIX_OPTIONS,
          inject: options.inject ?? [],
          // Nest awaits an async factory before constructing any provider that depends on it.
          useFactory: async (...args: unknown[]) =>
            resolveOptions(
              await options.useFactory(...(args as never[])),
              process.env,
            ),
        },
        runtimeProvider,
        NestrixCore,
        NestrixMicroservices,
        { provide: APP_INTERCEPTOR, useClass: NestrixInterceptor },
      ],
      exports: [NESTRIX_OPTIONS, NestrixCore],
    };
  }
}
