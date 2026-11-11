import {
  type DynamicModule,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { NestrixCore } from "./core.js";
import { NestrixInterceptor } from "./http/interceptor.js";
import type { NestrixModuleOptions } from "./options.js";
import { isDisabledByEnv, resolveOptions } from "./resolve-options.js";
import { NESTRIX_OPTIONS } from "./tokens.js";

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
  return { module: NestrixModule };
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic modules are classes with static `forRoot`.
export class NestrixModule {
  static forRoot(options: NestrixModuleOptions = {}): DynamicModule {
    const env = process.env;
    // Resolved here so an invalid option fails at module creation.
    const resolved = resolveOptions(options, env);
    if (!resolved.enabled) return disabledModule();
    return {
      module: NestrixModule,
      global: true,
      providers: [
        { provide: NESTRIX_OPTIONS, useValue: resolved },
        NestrixCore,
        { provide: APP_INTERCEPTOR, useClass: NestrixInterceptor },
      ],
      exports: [NESTRIX_OPTIONS, NestrixCore],
    };
  }

  static forRootAsync(options: NestrixModuleAsyncOptions): DynamicModule {
    // The environment kill switch is known now; `enabled: false` from the factory is not,
    // so that case yields `ResolvedOptions.enabled === false` and an inert `NestrixCore`.
    if (isDisabledByEnv(process.env)) return disabledModule();
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
        NestrixCore,
        { provide: APP_INTERCEPTOR, useClass: NestrixInterceptor },
      ],
      exports: [NESTRIX_OPTIONS, NestrixCore],
    };
  }
}
